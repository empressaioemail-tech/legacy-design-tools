/**
 * Retrieval property atom-chain fetch for buildable-envelope derive.
 */

const DEFAULT_RETRIEVAL =
  "https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app";

export type PropertyAtomChainWire = {
  zoningFact?: {
    district?: string | null;
    absence?: { kind?: string } | null;
    atomDid?: string | null;
  } | null;
  setbackRule?: {
    front?: number;
    side?: number;
    rear?: number;
    side_corner?: number;
    sideCorner?: number;
    districtCode?: string | null;
    sourceAdapter?: string | null;
    sourceCitation?: string | null;
    extractedAt?: string | null;
    sourceVintage?: string | null;
    atomDid?: string | null;
  } | null;
  buildableEnvelope?: {
    outcome?: { kind?: string; areaSqFt?: number; reason?: string } | null;
    readContract?: {
      axes?: { assertedConfidence?: { estimate?: number } };
    } | null;
    atomDid?: string | null;
    /**
     * P-249 (2026-09-16). The verification signal, named correctly: the atom
     * field is `depthWarmPromotion` (value `"depth-warm-promoted-v1"` means
     * ground-truth verified). There is NO `depthWarmPromoted` field on the
     * atom — hauska-map merely writes a flag by that name into its own output,
     * which nothing reads (A-184). This wire type carried neither field until
     * P-249, so LDT could not tell a verified envelope atom from a shape-only
     * breadth-bake record and treated both as authoritative.
     */
    depthWarmPromotion?: string | null;
    /**
     * P-249: the citation fallback. Some promoted atoms carry no marker but a
     * `sourceCitation` naming depth-warm verification; the predicate in
     * `reconcileAtomEnvelope.ts` reads this only when the marker is absent
     * (precedence stated there and in the divergence fixture).
     */
    sourceCitation?: string | null;
  } | null;
  codeSections?: Array<{
    atomDid?: string | null;
    sectionNumber?: string | null;
    title?: string | null;
  }> | null;
};

export async function fetchPropertyAtomChain(
  parcelNodeId: string,
): Promise<PropertyAtomChainWire | null> {
  const baseUrl = (
    process.env.HAUSKA_RETRIEVAL_API_URL?.trim() ||
    process.env.RETRIEVAL_API_URL?.trim() ||
    DEFAULT_RETRIEVAL
  ).replace(/\/$/, "");
  const key =
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim();
  if (!key) return null;

  try {
    const upstream = await fetch(
      `${baseUrl}/property-nodes/${encodeURIComponent(parcelNodeId)}/atom-chain`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      },
    );
    if (!upstream.ok) return null;
    return (await upstream.json()) as PropertyAtomChainWire;
  } catch {
    return null;
  }
}
