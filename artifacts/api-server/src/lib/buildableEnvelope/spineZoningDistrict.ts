/**
 * Resolve zoning district from the property spine when GIS parcel props lack
 * `zoningCode`. Reads the same baked node-facet snapshot the facets route
 * serves, then optionally the retrieval atom-chain `zoningFact`. Never invents
 * a district — returns null when both sources are absent.
 */

export type SpineZoningSource = "baked-snapshot" | "atom-chain";

export interface SpineZoningResolution {
  district: string;
  source: SpineZoningSource;
  /** Present when `source === "baked-snapshot"`. */
  snapshotAt?: string | null;
}

const DEFAULT_RETRIEVAL =
  "https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app";

function districtFromFacets(facets: unknown): string | null {
  if (!facets || typeof facets !== "object") return null;
  const zoning = (facets as Record<string, unknown>).zoning;
  if (!zoning || typeof zoning !== "object") return null;
  const district = (zoning as Record<string, unknown>).district;
  if (typeof district !== "string") return null;
  const trimmed = district.trim();
  return trimmed || null;
}

async function districtFromAtomChain(
  parcelNodeId: string,
): Promise<string | null> {
  const baseUrl = (
    process.env.HAUSKA_RETRIEVAL_API_URL?.trim() ||
    process.env.RETRIEVAL_API_URL?.trim() ||
    DEFAULT_RETRIEVAL
  ).replace(/\/$/, "");
  const key =
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim();
  if (!key) return null;

  type AtomChainZoningWire = {
    zoningFact?: {
      district?: string | null;
      absence?: { kind?: string } | null;
    } | null;
    setbackRule?: { districtCode?: string | null } | null;
  };

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
    const chain = (await upstream.json()) as AtomChainZoningWire;
    if (chain.zoningFact?.absence?.kind === "no-zoning-stamp") return null;
    if (typeof chain.zoningFact?.district === "string") {
      const trimmed = chain.zoningFact.district.trim();
      if (trimmed) return trimmed;
    }
    if (typeof chain.setbackRule?.districtCode === "string") {
      const trimmed = chain.setbackRule.districtCode.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * When GIS `zoningCode` is blank, read district from baked facets (preferred)
 * or atom-chain zoningFact. Returns null when GIS already carries a code or
 * when no spine district exists.
 */
export async function resolveSpineZoningWhenGisAbsent(
  parcelNodeId: string | null,
  gisZoningCode: string | null | undefined,
): Promise<SpineZoningResolution | null> {
  const gis = (gisZoningCode ?? "").trim();
  if (gis) return null;
  if (!parcelNodeId) return null;

  const { loadBakedNodeFacetSnapshot } = await import(
    "../../routes/brokerageNodeFacets.js"
  );
  const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
  const bakedDistrict = districtFromFacets(snapshot?.facets);
  if (bakedDistrict) {
    return {
      district: bakedDistrict,
      source: "baked-snapshot",
      snapshotAt: snapshot?.snapshotAt ?? null,
    };
  }

  const chainDistrict = await districtFromAtomChain(parcelNodeId);
  if (chainDistrict) {
    return {
      district: chainDistrict,
      source: "atom-chain",
    };
  }

  return null;
}

export function spineZoningProvenanceNote(
  resolution: SpineZoningResolution,
): string {
  if (resolution.source === "baked-snapshot") {
    const at = resolution.snapshotAt ? ` @ ${resolution.snapshotAt}` : "";
    return (
      `Zoning district ${resolution.district} read from baked node-facet snapshot` +
      `${at} (GIS parcel.zoningCode absent; not invented).`
    );
  }
  return (
    `Zoning district ${resolution.district} read from property atom-chain ` +
    `(GIS parcel.zoningCode absent; not invented).`
  );
}
