/**
 * Uniform provenance envelope for extension brief output (sprint 58 C2).
 *
 * Rail-quiet (I7): calibration grade is omitted from buyer-facing schemas.
 */

export interface BriefProvenanceSource {
  atomId: string;
  sourceUrl: string;
  edition: string;
  retrievedAt: string;
  verificationState: "verified" | "unverified" | "corpus";
}

export interface BriefProvenanceEnvelope {
  lineage: { atomIds: string[] };
  sources: BriefProvenanceSource[];
  reasoningChain: {
    rule: string;
    precedence: string | null;
    projectFacts: string[];
  };
  confidence: number | null;
  timestamp: string;
  edition: string | null;
  /** Local-code layer honesty — corpus vs web-scraped fallback. */
  coverage?: { degraded: boolean; reason?: string };
  /** Present when BROKERAGE_BRIEF_VIA_GATE routes retrieval through the spine. */
  spineViaGate?: boolean;
}

export interface BriefProvenanceAtomInput {
  atomDid: string;
  sourceUrl?: string | null;
  edition?: string | null;
  codeBook?: string | null;
}

export function buildBrokerageBriefProvenanceEnvelope(input: {
  citations: Array<{ atomDid: string }>;
  atoms?: BriefProvenanceAtomInput[];
  finishedAt: string;
  jurisdictionKey: string | null;
  corpusStatus: string;
  reasoningMethod?: string;
  spineViaGate?: boolean;
  coverage?: { degraded: boolean; reason?: string };
  localCodeSource?: "corpus" | "websearch" | "none";
}): BriefProvenanceEnvelope {
  const atomIds = [
    ...new Set(
      input.citations.map((c) => c.atomDid).filter((id) => id.length > 0),
    ),
  ];

  const atomMeta = new Map(
    (input.atoms ?? []).map((a) => [a.atomDid, a] as const),
  );

  const webSourced = input.localCodeSource === "websearch";
  const sources: BriefProvenanceSource[] = atomIds.map((atomId) => {
    const meta = atomMeta.get(atomId);
    const isWebAtom =
      webSourced ||
      atomId.startsWith("websearch:") ||
      atomId.startsWith("reasoning:");
    return {
      atomId,
      sourceUrl: meta?.sourceUrl?.trim() || "",
      edition: meta?.edition?.trim() || meta?.codeBook?.trim() || "",
      retrievedAt: input.finishedAt,
      verificationState: isWebAtom
        ? "unverified"
        : input.corpusStatus === "in_corpus"
          ? "corpus"
          : "unverified",
    };
  });

  const edition =
    sources.find((s) => s.edition.length > 0)?.edition ??
    input.jurisdictionKey;

  return {
    lineage: { atomIds },
    sources,
    reasoningChain: {
      rule: "municipal-code-retrieval",
      precedence: null,
      projectFacts: input.jurisdictionKey
        ? [`jurisdiction:${input.jurisdictionKey}`]
        : [],
    },
    confidence: webSourced
      ? 0.35
      : input.corpusStatus === "in_corpus"
        ? 0.85
        : input.corpusStatus === "partial"
          ? 0.6
          : null,
    timestamp: input.finishedAt,
    edition,
    ...(input.coverage ? { coverage: { ...input.coverage } } : {}),
    ...(input.spineViaGate ? { spineViaGate: true } : {}),
  };
}
