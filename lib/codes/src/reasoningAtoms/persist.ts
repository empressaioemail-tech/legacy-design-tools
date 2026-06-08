import { and, eq, inArray } from "drizzle-orm";
import { db, reasoningAtoms, type ReasoningSourceLink } from "@workspace/db";
import type { WebCodeFetchResult } from "../webCodeFetch/types";
import type { WebCodeReviewTarget } from "../webCodeFetch/types";
import { reasoningAtomId } from "./ids";
import { mergeReasoningSources } from "./sources";
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

/**
 * UPSERT a reasoning atom from a web fetch. Merges sources[] on conflict;
 * persists capped snippet only — never full section text.
 */
export async function upsertReasoningAtomFromWebFetch(args: {
  jurisdictionKey: string;
  target: WebCodeReviewTarget;
  result: WebCodeFetchResult;
}): Promise<ReasoningAtomRecord> {
  const { jurisdictionKey, target, result } = args;
  const id = reasoningAtomId(target.editionSlug, target.codeRef);
  const incomingSource = webResultToSourceLink(result);
  const verificationState = verificationStateFromResult(result);
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

  const now = new Date();
  if (existing[0]) {
    const mergedSources = mergeReasoningSources(
      (existing[0].sources as ReasoningSourceLink[]) ?? [],
      incomingSource,
    );
    const [row] = await db
      .update(reasoningAtoms)
      .set({
        sources: mergedSources,
        confidence: String(Math.max(Number(existing[0].confidence), result.confidence)),
        verificationState,
        snippet: snippet ?? existing[0].snippet,
        reasoning,
        updatedAt: now,
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
      confidence: String(result.confidence),
      verificationState,
      snippet,
      displayMode: "deeplink",
      accessPolicy: "platform-internal",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(row!);
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

function mapRow(row: typeof reasoningAtoms.$inferSelect): ReasoningAtomRecord {
  return {
    id: row.id,
    jurisdictionKey: row.jurisdictionKey,
    codeRef: row.codeRef,
    edition: row.edition,
    editionSlug: row.editionSlug,
    sources: (row.sources as ReasoningSourceLink[]) ?? [],
    reasoning: row.reasoning,
    confidence: Number(row.confidence),
    verificationState: row.verificationState as ReasoningVerificationState,
    snippet: row.snippet,
    displayMode: row.displayMode as ReasoningAtomRecord["displayMode"],
    calibratedConfidence:
      row.calibratedConfidence != null
        ? Number(row.calibratedConfidence)
        : null,
    accessPolicy: row.accessPolicy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
