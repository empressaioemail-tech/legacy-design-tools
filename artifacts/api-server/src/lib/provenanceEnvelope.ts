/**
 * Uniform provenance envelope for architect-facing Cortex surfaces (C1 / moat #3).
 *
 * Rail-quiet (I7): calibration GRADE is intentionally excluded from buyer-facing output.
 */

import { eq, inArray } from "drizzle-orm";
import {
  canonicalOverlayAtomKey,
  isReasoningOverlayAtomId,
} from "@workspace/codes";
import { db, codeAtoms, codeAtomSources, reasoningAtoms, type Finding, type ParcelBriefing, type BriefingSource } from "@workspace/db";
import type { CodeSectionInput } from "@workspace/finding-engine";
import type { FindingCitation } from "@workspace/finding-engine";

export interface ProvenanceSourceEntry {
  atomId: string;
  deeplink: string;
  edition: string;
  retrievedAt: string;
  verificationState: "verified" | "unverified-web-source";
  sourceName?: string;
}

export interface ProvenanceEnvelope {
  lineage: { atomIds: string[] };
  sources: ProvenanceSourceEntry[];
  reasoning: {
    rule?: string;
    precedenceChain?: string[];
    projectFacts?: Record<string, unknown>;
  };
  confidence: number;
  evaluatedAt: string;
  edition: string | null;
}

export function atomIdsFromCitations(
  citations: ReadonlyArray<FindingCitation>,
): string[] {
  const ids: string[] = [];
  for (const c of citations) {
    if (c.kind === "code-section") ids.push(c.atomId);
  }
  return ids;
}

function parsePrecedenceReasoning(text: string): {
  rule?: string;
  precedenceChain?: string[];
} {
  if (!text.includes("Precedence reconciliation")) return {};
  const ruleMatch = /\(([^)]+)\) for/.exec(text);
  const rule = ruleMatch?.[1];
  const chain = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.includes("govern") || s.includes("preempt") || s.includes("stringent"));
  return {
    ...(rule ? { rule } : {}),
    ...(chain.length > 0 ? { precedenceChain: chain } : {}),
  };
}

/**
 * Check if a string looks like a UUID (8-4-4-4-12 hex pattern).
 * Used to distinguish DB corpus atom ids from retrieval-supplement ids.
 */
function looksLikeUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Check if an atom id is a retrieval-supplement id (like icc-model-code/edition/section).
 * These are NOT stored in the DB; provenance must be synthesized from the id structure.
 */
function isRetrievalSupplementAtomId(atomId: string): boolean {
  // Retrieval-supplement ids contain slashes and are not UUIDs
  return atomId.includes("/") && !looksLikeUuid(atomId);
}

/**
 * Extract jurisdiction from a retrieval-supplement atom id.
 * E.g., "icc-model-code/2018-international-building-code-6th-printing/1612-3" → "icc-model-code"
 */
function extractJurisdictionFromSupplementId(atomId: string): string {
  const parts = atomId.split("/");
  return parts[0] ?? atomId;
}

/**
 * Build a source label from a retrieval-supplement jurisdiction.
 * Aligns with the labeling in findings.ts `toCodeSectionInput`.
 */
function labelForRetrievalJurisdiction(jurisdiction: string): string {
  if (jurisdiction === "icc-model-code") {
    return "ICC model code";
  }
  // Future supplement jurisdictions can be mapped here
  return jurisdiction;
}

/** Split citation atom ids by namespace before DB hydration (UUID corpus vs reasoning-layer vs retrieval-supplement). */
export function partitionProvenanceAtomIds(atomIds: readonly string[]): {
  corpusAtomIds: string[];
  reasoningAtomIds: string[];
  supplementAtomIds: string[];
} {
  const corpusAtomIds: string[] = [];
  const reasoningAtomIds: string[] = [];
  const supplementAtomIds: string[] = [];
  for (const raw of atomIds) {
    if (isReasoningOverlayAtomId(raw)) {
      reasoningAtomIds.push(raw);
    } else if (isRetrievalSupplementAtomId(raw)) {
      supplementAtomIds.push(raw);
    } else {
      corpusAtomIds.push(canonicalOverlayAtomKey(raw));
    }
  }
  return { corpusAtomIds, reasoningAtomIds, supplementAtomIds };
}

export async function hydrateProvenanceSources(
  atomIds: readonly string[],
): Promise<ProvenanceSourceEntry[]> {
  if (atomIds.length === 0) return [];

  const { corpusAtomIds, reasoningAtomIds, supplementAtomIds } =
    partitionProvenanceAtomIds(atomIds);

  const corpusRows =
    corpusAtomIds.length > 0
      ? await db
          .select({
            id: codeAtoms.id,
            edition: codeAtoms.edition,
            sourceUrl: codeAtoms.sourceUrl,
            fetchedAt: codeAtoms.fetchedAt,
            sourceName: codeAtomSources.sourceName,
          })
          .from(codeAtoms)
          .innerJoin(
            codeAtomSources,
            eq(codeAtomSources.id, codeAtoms.sourceId),
          )
          .where(inArray(codeAtoms.id, corpusAtomIds))
      : [];

  const reasoningRows =
    reasoningAtomIds.length > 0
      ? await db
          .select({
            id: reasoningAtoms.id,
            edition: reasoningAtoms.edition,
            sources: reasoningAtoms.sources,
            verificationState: reasoningAtoms.verificationState,
            updatedAt: reasoningAtoms.updatedAt,
          })
          .from(reasoningAtoms)
          .where(inArray(reasoningAtoms.id, reasoningAtomIds))
      : [];

  const byId = new Map<string, ProvenanceSourceEntry>();

  for (const r of corpusRows) {
    byId.set(r.id, {
      atomId: r.id,
      deeplink: r.sourceUrl,
      edition: r.edition ?? "",
      retrievedAt: r.fetchedAt.toISOString(),
      verificationState: "verified",
      sourceName: r.sourceName,
    });
  }

  for (const r of reasoningRows) {
    const primary = Array.isArray(r.sources) ? r.sources[0] : undefined;
    byId.set(r.id, {
      atomId: r.id,
      deeplink: primary?.url ?? "",
      edition: primary?.edition ?? r.edition ?? "",
      retrievedAt: primary?.retrievedAt ?? r.updatedAt.toISOString(),
      verificationState:
        r.verificationState === "verified"
          ? "verified"
          : "unverified-web-source",
      sourceName: primary?.sourceName,
    });
  }

  // Build provenance for retrieval-supplement atoms without DB lookup.
  // These ids come from the retrieval system (e.g., icc-model-code/edition/section)
  // and are NOT stored in the code_atoms table.
  for (const id of supplementAtomIds) {
    const jurisdiction = extractJurisdictionFromSupplementId(id);
    const sourceName = labelForRetrievalJurisdiction(jurisdiction);
    // Extract edition from the id if possible (second segment)
    const parts = id.split("/");
    const edition = parts[1] ?? "";
    
    byId.set(id, {
      atomId: id,
      deeplink: "", // No direct deeplink for retrieval supplements
      edition,
      retrievedAt: new Date().toISOString(),
      verificationState: "verified", // Retrieval supplements are considered verified
      sourceName,
    });
  }

  return atomIds
    .map((id) => byId.get(id))
    .filter((e): e is ProvenanceSourceEntry => e !== undefined);
}

export function buildProvenanceFromCodeSections(
  citations: ReadonlyArray<FindingCitation>,
  codeSections: ReadonlyArray<CodeSectionInput>,
  args?: {
    confidence?: number;
    precedenceChain?: string[];
    rule?: string;
    evaluatedAt?: Date;
  },
): ProvenanceEnvelope {
  const atomIds = atomIdsFromCitations(citations);
  const sectionById = new Map(codeSections.map((s) => [s.atomId, s]));

  const sources: ProvenanceSourceEntry[] = [];
  for (const atomId of atomIds) {
    const section = sectionById.get(atomId);
    const wp = section?.webProvenance;
    if (!wp) continue;
    const primary = wp.sources?.[0];
    sources.push({
      atomId,
      deeplink: primary?.url ?? wp.sourceUrl,
      edition: primary?.edition ?? wp.edition,
      retrievedAt: primary?.retrievedAt ?? wp.retrievedAt,
      verificationState:
        wp.verificationState ??
        (wp.verified ? "verified" : "unverified-web-source"),
      sourceName: primary?.sourceName ?? wp.sourceName,
    });
  }

  const confidences = atomIds
    .map((id) => sectionById.get(id)?.webProvenance?.confidence)
    .filter((c): c is number => typeof c === "number");

  const evaluatedAt = (args?.evaluatedAt ?? new Date()).toISOString();
  const editions = sources.map((s) => s.edition).filter(Boolean);

  return {
    lineage: { atomIds },
    sources,
    reasoning: {
      ...(args?.rule ? { rule: args.rule } : {}),
      ...(args?.precedenceChain?.length
        ? { precedenceChain: args.precedenceChain }
        : {}),
    },
    confidence:
      args?.confidence ??
      (confidences.length > 0 ? Math.min(...confidences) : 0),
    evaluatedAt,
    edition: editions[0] ?? null,
  };
}

export async function buildProvenanceFromFindingRow(
  row: Finding,
): Promise<ProvenanceEnvelope> {
  const citations = Array.isArray(row.citations)
    ? (row.citations as FindingCitation[])
    : [];
  const atomIds = atomIdsFromCitations(citations);
  const precedence = parsePrecedenceReasoning(row.text);
  
  let sources: ProvenanceSourceEntry[] = [];
  try {
    sources = await hydrateProvenanceSources(atomIds);
  } catch (error) {
    // Defense in depth: if provenance hydration fails for this finding,
    // log the error and return a minimal envelope rather than crashing
    // the entire findings listing.
    console.warn(
      `Failed to hydrate provenance sources for finding ${row.atomId}:`,
      error instanceof Error ? error.message : String(error),
      `atomIds:`,
      atomIds,
    );
    
    // Return minimal provenance entries with just the atom IDs
    sources = atomIds.map((atomId) => ({
      atomId,
      deeplink: "",
      edition: "",
      retrievedAt: row.aiGeneratedAt.toISOString(),
      verificationState: "unverified-web-source" as const,
      sourceName: undefined,
    }));
  }
  
  const editions = sources.map((s) => s.edition).filter(Boolean);

  return {
    lineage: { atomIds },
    sources,
    reasoning: precedence,
    confidence: Number(row.confidence),
    evaluatedAt: row.aiGeneratedAt.toISOString(),
    edition: editions[0] ?? null,
  };
}

export function buildProvenanceFromBriefing(
  briefing: ParcelBriefing,
  sources: readonly BriefingSource[],
): ProvenanceEnvelope {
  const evaluatedAt =
    briefing.generatedAt?.toISOString() ?? briefing.updatedAt.toISOString();
  const sourceEntries: ProvenanceSourceEntry[] = sources.map((s) => {
    const edition =
      s.snapshotDate instanceof Date
        ? s.snapshotDate.toISOString().slice(0, 10)
        : String(s.snapshotDate ?? "");
    return {
      atomId: s.id,
      deeplink: s.glbObjectPath ?? "",
      edition,
      retrievedAt: s.createdAt.toISOString(),
      verificationState: "verified" as const,
      sourceName: s.provider ?? s.layerKind,
    };
  });

  return {
    lineage: { atomIds: sources.map((s) => s.id) },
    sources: sourceEntries,
    reasoning: {},
    confidence: 1,
    evaluatedAt,
    edition: sourceEntries[0]?.edition ?? null,
  };
}

export function buildProvenanceFromCodeAtom(args: {
  atomId: string;
  sourceUrl: string;
  edition: string;
  fetchedAt: string;
  sourceName: string;
}): ProvenanceEnvelope {
  return {
    lineage: { atomIds: [args.atomId] },
    sources: [
      {
        atomId: args.atomId,
        deeplink: args.sourceUrl,
        edition: args.edition,
        retrievedAt: args.fetchedAt,
        verificationState: "verified",
        sourceName: args.sourceName,
      },
    ],
    reasoning: {},
    confidence: 1,
    evaluatedAt: args.fetchedAt,
    edition: args.edition,
  };
}
