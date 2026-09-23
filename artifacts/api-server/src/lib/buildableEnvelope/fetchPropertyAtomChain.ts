/**
 * Retrieval property atom-chain fetch for buildable-envelope derive.
 */

import { requireRetrievalBaseUrl } from "../retrievalEndpoint";

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
    /**
     * P-340: the wire's OWN spelling, served by the atom chain (live-confirmed
     * 2026-09-18 for all seven P-340 subjects). Carried here — and read by
     * `authoritativeSetbackSource.ts` — so the route does not silently drop a
     * corner axis it was served; see that file's `AtomChainSetbackWire` doc.
     */
    sideCornerFt?: number;
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
  const key =
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim() ||
    // P-366: the deployed cortex-api mounts BRIEF_RETRIEVAL_API_KEY, not the
    // two names above, so this read was dead in production. Same fallback,
    // same reason as parcelRecordReaderClient.ts and placeCoverageSource.ts.
    process.env.BRIEF_RETRIEVAL_API_KEY?.trim();
  if (!key) return null;

  // D-25: no default host. The key gate above keeps its existing meaning --
  // "this reader is not armed on this deployment", a soft skip -- while a
  // deployment that armed the key and left the ADDRESS unset now refuses by
  // name instead of calling the retired GCP host. Deliberately placed after the
  // key gate and before the try: after, so the unarmed-reader contract is
  // unchanged; before, so the refusal is never laundered into `null`, which
  // callers read as "the service says this parcel has no atom chain" -- a
  // fabricated absence.
  const baseUrl = requireRetrievalBaseUrl();

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
