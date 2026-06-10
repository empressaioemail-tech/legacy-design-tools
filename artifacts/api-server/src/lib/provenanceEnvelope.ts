/**
 * Uniform provenance envelope for architect-facing Cortex surfaces (C1 / moat #3).
 *
 * Rail-quiet (I7): calibration GRADE is intentionally excluded from buyer-facing output.
 */

import { eq, inArray } from "drizzle-orm";
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

export async function hydrateProvenanceSources(
  atomIds: readonly string[],
): Promise<ProvenanceSourceEntry[]> {
  if (atomIds.length === 0) return [];

  const corpusRows = await db
    .select({
      id: codeAtoms.id,
      edition: codeAtoms.edition,
      sourceUrl: codeAtoms.sourceUrl,
      fetchedAt: codeAtoms.fetchedAt,
      sourceName: codeAtomSources.sourceName,
    })
    .from(codeAtoms)
    .innerJoin(codeAtomSources, eq(codeAtomSources.id, codeAtoms.sourceId))
    .where(inArray(codeAtoms.id, [...atomIds]));

  const reasoningRows = await db
    .select({
      id: reasoningAtoms.id,
      edition: reasoningAtoms.edition,
      sources: reasoningAtoms.sources,
      verificationState: reasoningAtoms.verificationState,
      updatedAt: reasoningAtoms.updatedAt,
    })
    .from(reasoningAtoms)
    .where(inArray(reasoningAtoms.id, [...atomIds]));

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
  const sources = await hydrateProvenanceSources(atomIds);
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
