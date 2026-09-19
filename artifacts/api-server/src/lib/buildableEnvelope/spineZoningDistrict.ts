/**
 * Resolve zoning district from the property spine when GIS parcel props lack
 * `zoningCode`. Reads the stamp the LEDGER serves first — the parcel-record
 * rail's `zoningDistrict` cell, through the same gated reader the facets
 * route uses (`loadZoningFactForServe`) — then the baked node-facet snapshot,
 * then the retrieval atom-chain `zoningFact`. Never invents a district:
 * returns null when every source is absent.
 *
 * P-366 (2026-09-19). Before this change the drawing route had NO read of the
 * parcel-record rail at all, so it declined `no-zoning-stamp` on parcels whose
 * district the card was serving from that very rail ({serve:"record",
 * atomBacked:false} on all five measured parcels). The card and the route now
 * read the same source in the same precedence: `structuralFactToFacetsWire`
 * applies the record's zoning over the baked stamp, and so does this module.
 */

export type SpineZoningSource = "parcel-record" | "baked-snapshot" | "atom-chain";

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
    process.env.BRIEF_RETRIEVAL_API_URL?.trim() ||
    DEFAULT_RETRIEVAL
  ).replace(/\/$/, "");
  const key =
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim() ||
    // P-366: the deployed cortex-api mounts BRIEF_RETRIEVAL_API_KEY, not the
    // two names above, so this branch was dead in production and every
    // atom-chain fallback here silently returned null. Same fallback, same
    // reason as parcelRecordReaderClient.ts and placeCoverageSource.ts.
    process.env.BRIEF_RETRIEVAL_API_KEY?.trim();
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
 * The stamp the LEDGER serves: the parcel-record rail's own `zoningDistrict`
 * cell, read through the same gated serve reader the facets route uses, so the
 * draw path honours the (county, rail) slate and never opens a second,
 * ungated read. `null` when the pair is unslated, when the cell is absent or
 * refused, or when a present cell's value is unreadable — never invented.
 */
async function districtFromParcelRecord(
  parcelNodeId: string,
): Promise<string | null> {
  const { loadZoningFactForServe } = await import(
    "../zoningFactServeCutover.js"
  );
  const read = await loadZoningFactForServe(parcelNodeId);
  if (!read || read.state !== "present") return null;
  const trimmed = read.district.trim();
  return trimmed || null;
}

/**
 * When GIS `zoningCode` is blank, read district from the parcel-record rail
 * (the ledger stamp, preferred), then the baked facets, then the atom-chain
 * zoningFact. Returns null when GIS already carries a code or when no source
 * holds a district.
 */
export async function resolveSpineZoningWhenGisAbsent(
  parcelNodeId: string | null,
  gisZoningCode: string | null | undefined,
): Promise<SpineZoningResolution | null> {
  const gis = (gisZoningCode ?? "").trim();
  if (gis) return null;
  if (!parcelNodeId) return null;

  // Record first: this is the same precedence the card composes with
  // (structuralFactToFacetsWire applies parcelRecordZoningFact OVER the baked
  // stamp), so a parcel's district is the same value on the card and the route.
  const recordDistrict = await districtFromParcelRecord(parcelNodeId);
  if (recordDistrict) {
    return {
      district: recordDistrict,
      source: "parcel-record",
    };
  }

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
  if (resolution.source === "parcel-record") {
    return (
      `Zoning district ${resolution.district} read from the parcel record rail ` +
      `(GIS parcel.zoningCode absent; not invented).`
    );
  }
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
