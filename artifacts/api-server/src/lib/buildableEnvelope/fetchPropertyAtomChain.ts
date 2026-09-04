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
    outcome?: { kind?: string; areaSqFt?: number } | null;
    readContract?: {
      axes?: { assertedConfidence?: { estimate?: number } };
    } | null;
    atomDid?: string | null;
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
