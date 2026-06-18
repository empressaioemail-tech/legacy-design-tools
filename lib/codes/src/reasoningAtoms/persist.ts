import { and, eq, inArray, sql } from "drizzle-orm";
import { db, reasoningAtoms, type ReasoningSourceLink } from "@workspace/db";
import type { WebCodeFetchResult } from "../webCodeFetch/types";
import type { WebCodeReviewTarget } from "../webCodeFetch/types";
import { reasoningAtomId, jurisdictionReasoningAtomId } from "./ids";
import { mergeReasoningSources, sourceSetChanged } from "./sources";
import { capReasoningSnippet, reasoningSummaryFromFetch } from "./snippet";
import type { ReasoningAtomRecord, ReasoningVerificationState } from "./types";

export function webResultToSourceLink(result: WebCodeFetchResult): ReasoningSourceLink {
  return {
    url: result.sourceUrl,
    sourceName: result.sourceName,
    edition: result.edition,
    retrievedAt: result.retrievedAt,
    verified: result.verified,
  };
}

export function verificationStateFromResult(
  result: WebCodeFetchResult,
): ReasoningVerificationState {
  return result.verified ? "verified" : "unverified-web-source";
}

/** Never downgrade verified → unverified on re-warm; upgrades only. */
export function mergeVerificationState(
  prior: ReasoningVerificationState | string | null | undefined,
  incoming: ReasoningVerificationState,
  opts?: { priorGrounded?: boolean },
): ReasoningVerificationState {
  if (prior === "verified") return "verified";
  if (incoming === "verified") return "verified";
  if (opts?.priorGrounded) return "verified";
  return incoming;
}

function assertedConfidenceFromResult(result: WebCodeFetchResult): number {
  if (!result.verified) {
    return Math.min(result.confidence, 0.35);
  }
  return result.confidence;
}

/**
 * UPSERT a reasoning atom from a web fetch. Merges sources[] on conflict;
 * persists capped snippet only — never full section text.
 * Preserves calibratedConfidence and calibration metadata on re-warm.
 *
 * When `verifyBeforePromote` is true (deepen/incremental mode), failed fetches
 * never mutate an existing row — verified is a high-water mark.
 */
export async function upsertReasoningAtomFromWebFetch(args: {
  jurisdictionKey: string;
  target: WebCodeReviewTarget;
  result: WebCodeFetchResult;
  verifyBeforePromote?: boolean;
}): Promise<ReasoningAtomRecord> {
  const { jurisdictionKey, target, result, verifyBeforePromote = false } = args;
  const id = jurisdictionReasoningAtomId(jurisdictionKey, target.editionSlug, target.codeRef);
  const incomingSource = webResultToSourceLink(result);
  const incomingVerificationState = verificationStateFromResult(result);
  const assertedConfidence = assertedConfidenceFromResult(result);
  const snippet = capReasoningSnippet(
    result.verified ? result.text : null,
  );
  const reasoning = reasoningSummaryFromFetch({
    codeRef: target.codeRef,
    edition: target.edition,
    verified: result.verified,
    sourceName: result.sourceName,
  });

  const existing = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.id, id))
    .limit(1);

  if (verifyBeforePromote && existing[0] && !result.verified) {
    return mapRow(existing[0]);
  }

  const now = new Date();
  if (existing[0]) {
    const priorSources = (existing[0].sources as ReasoningSourceLink[]) ?? [];
    const mergedSources = mergeReasoningSources(priorSources, incomingSource);
    const sourcesDrifted = sourceSetChanged(priorSources, mergedSources);
    const nextSourceSetVersion =
      sourcesDrifted
        ? Number(existing[0].sourceSetVersion ?? 1) + 1
        : Number(existing[0].sourceSetVersion ?? 1);

    const priorGrounded = priorSources.some((source) => source.verified);
    const verificationState = mergeVerificationState(
      existing[0].verificationState,
      incomingVerificationState,
      { priorGrounded },
    );

    const [row] = await db
      .update(reasoningAtoms)
      .set({
        sources: mergedSources,
        assertedConfidence: String(
          Math.max(Number(existing[0].assertedConfidence), assertedConfidence),
        ),
        verificationState,
        snippet: snippet ?? existing[0].snippet,
        reasoning:
          incomingVerificationState === "verified" || verificationState === "verified"
            ? reasoning
            : existing[0].reasoning,
        updatedAt: now,
        sourceSetVersion: nextSourceSetVersion,
        calibrationStale:
          sourcesDrifted || Boolean(existing[0].calibrationStale),
      })
      .where(eq(reasoningAtoms.id, id))
      .returning();
    return mapRow(row!);
  }

  const [row] = await db
    .insert(reasoningAtoms)
    .values({
      id,
      jurisdictionKey,
      codeRef: target.codeRef,
      edition: target.edition,
      editionSlug: target.editionSlug,
      sources: [incomingSource],
      reasoning,
      assertedConfidence: String(assertedConfidence),
      verificationState: incomingVerificationState,
      snippet,
      displayMode: "deeplink",
      accessPolicy: "platform-internal",
      sourceSetVersion: 1,
      calibrationStale: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(row!);
}

/** Corpus-covered reference — deeplink overlay only, no web text grounding. */
export async function upsertReasoningAtomCorpusOverlay(args: {
  jurisdictionKey: string;
  target: WebCodeReviewTarget;
  corpusSourceUrl: string;
  corpusAtomId: string;
}): Promise<ReasoningAtomRecord> {
  const { jurisdictionKey, target, corpusSourceUrl, corpusAtomId } = args;
  const id = jurisdictionReasoningAtomId(jurisdictionKey, target.editionSlug, target.codeRef);
  const retrievedAt = new Date().toISOString();
  const incomingSource: ReasoningSourceLink = {
    url: corpusSourceUrl,
    sourceName: "corpus",
    edition: target.edition,
    retrievedAt,
    verified: true,
  };
  const reasoning = `Corpus-covered reference for ${target.codeRef} (${target.edition}) — structural atom ${corpusAtomId}; calibration attributes via lineage, not re-grounded web text.`;

  const existing = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.id, id))
    .limit(1);

  const now = new Date();
  if (existing[0]) {
    const priorSources = (existing[0].sources as ReasoningSourceLink[]) ?? [];
    const mergedSources = mergeReasoningSources(priorSources, incomingSource);
    const sourcesDrifted = sourceSetChanged(priorSources, mergedSources);
    const [row] = await db
      .update(reasoningAtoms)
      .set({
        sources: mergedSources,
        reasoning,
        updatedAt: now,
        sourceSetVersion: sourcesDrifted
          ? Number(existing[0].sourceSetVersion ?? 1) + 1
          : Number(existing[0].sourceSetVersion ?? 1),
        calibrationStale:
          sourcesDrifted || Boolean(existing[0].calibrationStale),
      })
      .where(eq(reasoningAtoms.id, id))
      .returning();
    return mapRow(row!);
  }

  const [row] = await db
    .insert(reasoningAtoms)
    .values({
      id,
      jurisdictionKey,
      codeRef: target.codeRef,
      edition: target.edition,
      editionSlug: target.editionSlug,
      sources: [incomingSource],
      reasoning,
      assertedConfidence: "0.75",
      verificationState: "verified",
      snippet: null,
      displayMode: "deeplink",
      accessPolicy: "platform-internal",
      sourceSetVersion: 1,
      calibrationStale: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(row!);
}

/** NFPA-license-required — deeplink-only reference atom, no grounded snippet. */
export async function upsertReasoningAtomDeeplinkOnly(args: {
  jurisdictionKey: string;
  target: WebCodeReviewTarget;
  deeplinkUrl: string;
  sourceName?: string;
}): Promise<ReasoningAtomRecord> {
  const { jurisdictionKey, target, deeplinkUrl } = args;
  const sourceName = args.sourceName ?? "nfpa";
  const id = jurisdictionReasoningAtomId(jurisdictionKey, target.editionSlug, target.codeRef);
  const retrievedAt = new Date().toISOString();
  const incomingSource: ReasoningSourceLink = {
    url: deeplinkUrl,
    sourceName,
    edition: target.edition,
    retrievedAt,
    verified: true,
  };
  const reasoning = `Licensed-display reference for ${target.codeRef} (${target.edition}) — deeplink only until NFPA track lands; no grounded text stored.`;

  const existing = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.id, id))
    .limit(1);

  const now = new Date();
  if (existing[0]) {
    const priorSources = (existing[0].sources as ReasoningSourceLink[]) ?? [];
    const mergedSources = mergeReasoningSources(priorSources, incomingSource);
    const sourcesDrifted = sourceSetChanged(priorSources, mergedSources);
    const [row] = await db
      .update(reasoningAtoms)
      .set({
        sources: mergedSources,
        reasoning,
        snippet: null,
        assertedConfidence: "0.5",
        verificationState: "verified",
        displayMode: "deeplink",
        updatedAt: now,
        sourceSetVersion: sourcesDrifted
          ? Number(existing[0].sourceSetVersion ?? 1) + 1
          : Number(existing[0].sourceSetVersion ?? 1),
        calibrationStale:
          sourcesDrifted || Boolean(existing[0].calibrationStale),
      })
      .where(eq(reasoningAtoms.id, id))
      .returning();
    return mapRow(row!);
  }

  const [row] = await db
    .insert(reasoningAtoms)
    .values({
      id,
      jurisdictionKey,
      codeRef: target.codeRef,
      edition: target.edition,
      editionSlug: target.editionSlug,
      sources: [incomingSource],
      reasoning,
      assertedConfidence: "0.5",
      verificationState: "verified",
      snippet: null,
      displayMode: "deeplink",
      accessPolicy: "platform-internal",
      sourceSetVersion: 1,
      calibrationStale: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(row!);
}

export async function retrieveReasoningAtomById(
  id: string,
): Promise<ReasoningAtomRecord | null> {
  const rows = await db
    .select()
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.id, id))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function retrieveReasoningAtomsForRefs(args: {
  jurisdictionKey: string;
  codeRefs: ReadonlyArray<string>;
}): Promise<ReasoningAtomRecord[]> {
  if (args.codeRefs.length === 0) return [];
  const rows = await db
    .select()
    .from(reasoningAtoms)
    .where(
      and(
        eq(reasoningAtoms.jurisdictionKey, args.jurisdictionKey),
        inArray(reasoningAtoms.codeRef, [...args.codeRefs]),
      ),
    );
  return rows.map(mapRow);
}

/** Count persisted reasoning atoms for coverage tier / warmup verification. */
export async function countReasoningAtomsForJurisdiction(
  jurisdictionKey: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reasoningAtoms)
    .where(eq(reasoningAtoms.jurisdictionKey, jurisdictionKey));
  return Number(rows[0]?.n ?? 0);
}

function mapRow(row: typeof reasoningAtoms.$inferSelect): ReasoningAtomRecord {
  return {
    id: row.id,
    jurisdictionKey: row.jurisdictionKey,
    codeRef: row.codeRef,
    edition: row.edition,
    editionSlug: row.editionSlug,
    sources: (row.sources as ReasoningSourceLink[]) ?? [],
    reasoning: row.reasoning,
    assertedConfidence: Number(row.assertedConfidence),
    verificationState: row.verificationState as ReasoningVerificationState,
    snippet: row.snippet,
    displayMode: row.displayMode as ReasoningAtomRecord["displayMode"],
    calibratedConfidence:
      row.calibratedConfidence != null
        ? Number(row.calibratedConfidence)
        : null,
    sourceSetVersion: Number(row.sourceSetVersion ?? 1),
    calibrationStale: Boolean(row.calibrationStale),
    accessPolicy: row.accessPolicy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
