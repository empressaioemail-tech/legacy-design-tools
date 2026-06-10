/**
 * Feature flag for routing brokerage brief code retrieval through the spine
 * (retrieval-api / gate seam) instead of direct Neon @workspace/codes.
 */

export function isBrokerageBriefViaGateEnabled(): boolean {
  const raw = process.env.BROKERAGE_BRIEF_VIA_GATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Effective BRIEF_CODE_RETRIEVAL mode for brokerage brief runs. */
export function brokerageBriefRetrievalMode(): "neon" | "gate" {
  if (isBrokerageBriefViaGateEnabled()) return "gate";
  const mode = (process.env.BRIEF_CODE_RETRIEVAL ?? "neon").toLowerCase();
  return mode === "gate" || mode === "mcp" ? "gate" : "neon";
}
