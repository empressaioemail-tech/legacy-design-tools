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
  /**
   * The setback jurisdiction the SAME source names as the district's own, when
   * it names one (P-339/P-366 residual, 2026-09-21). The ledger's zoning cell
   * carries a jurisdiction key beside the district because the two are written
   * together, from one city's zoning layer: `pflugerville-tx` + `SF-S` come off
   * Pflugerville's `Zoning_Districts/0`, and the setback row for `SF-S` lives in
   * that jurisdiction's table, not in whichever city the situs or a geocode
   * names. Absent — never invented — when the source that held the district
   * does not name one, so the derivation keeps its own city-state derivation.
   */
  jurisdictionKey?: string | null;
  /** Present when `source === "baked-snapshot"`. */
  snapshotAt?: string | null;
}

const DEFAULT_RETRIEVAL =
  "https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app";

/** A trimmed, non-empty string, or null. Never widens a value into existence. */
function readKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function districtFromFacets(facets: unknown): {
  district: string;
  jurisdictionKey: string | null;
} | null {
  if (!facets || typeof facets !== "object") return null;
  const zoning = (facets as Record<string, unknown>).zoning;
  if (!zoning || typeof zoning !== "object") return null;
  const district = (zoning as Record<string, unknown>).district;
  if (typeof district !== "string") return null;
  const trimmed = district.trim();
  if (!trimmed) return null;
  return {
    district: trimmed,
    jurisdictionKey: readKey((zoning as Record<string, unknown>).jurisdictionKey),
  };
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
 *
 * The rail's `zoningJurisdictionKey` cell is read BESIDE the district and
 * travels with it (P-339/P-366 residual): the district's own source city is the
 * jurisdiction whose setback table governs it.
 */
async function districtFromParcelRecord(
  parcelNodeId: string,
): Promise<{ district: string; jurisdictionKey: string | null } | null> {
  const { loadZoningFactForServe } = await import(
    "../zoningFactServeCutover.js"
  );
  const read = await loadZoningFactForServe(parcelNodeId);
  if (!read || read.state !== "present") return null;
  const trimmed = read.district.trim();
  if (!trimmed) return null;
  return {
    district: trimmed,
    jurisdictionKey: readKey(read.jurisdictionKey),
  };
}

/** Comparison form for a district code: trimmed, lowercased, inner runs collapsed. */
function districtCompareForm(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The jurisdiction the RECORD names beside the district it stamps — read for the
 * district the derivation is about to probe, and only when the two are the SAME
 * district (P-339/P-366 residual, 2026-09-21).
 *
 * WHY THIS EXISTS BESIDE `resolveSpineZoningWhenGisAbsent`. That function reads
 * the record rail only when the county parcel source carries NO `zoningCode` —
 * and the Travis/Caldwell parcel sources DO carry one ("Travis County parcels
 * (TxGIO/StratMap)" answered `payload.parcel.zoningCode: "SF"` for
 * `48453:367134` and `"SF-S"` for `48453:280210`, measured live 2026-09-21). So
 * on those parcels the record's cell — the one the CARD is served from, and the
 * only source that names a jurisdiction at all — was never read by the draw
 * path, and the key fell to the situs city (absent on CAD lines like
 * `1006 WISTERIA CIR`) or to the county-wide district-uniqueness guess, which
 * answers nothing when two cities in the county share a code. Measured live on
 * the identity path: `48453:239852` (record: SF-3 / austin-tx) `no-district`,
 * `48453:523600` (SU / cedar-park-tx) `no-district`, `48055:40428`
 * (P / san-marcos-tx) `no-district`, `48055:27929` (R1 / martindale-tx)
 * `no-district` — while the card drew all four and the corpus carries each row.
 *
 * THE RULE. The jurisdiction belongs to the district, and the record names the
 * two together. When the record's own district IS the district that will be
 * probed — exactly, or the widening of a base code that the district table
 * resolves (`SF` -> `SF-3`, the shape P-340 names) — its `jurisdictionKey` keys
 * the table. When the record's district is a DIFFERENT district, this returns
 * null and the caller's derivation is unchanged: this reads a value beside the
 * district, it never searches jurisdictions for one that answers.
 */
export async function recordJurisdictionKeyForDistrict(
  parcelNodeId: string | null,
  districtSignal: string | null | undefined,
): Promise<string | null> {
  if (!parcelNodeId) return null;
  const signal = districtCompareForm(districtSignal ?? "");
  if (!signal) return null;
  const pair = await districtFromParcelRecord(parcelNodeId);
  if (!pair || !pair.jurisdictionKey) return null;
  const recordDistrict = districtCompareForm(pair.district);
  if (!recordDistrict) return null;
  const sameDistrict =
    recordDistrict === signal ||
    (signal.length > 1 && recordDistrict.startsWith(signal));
  return sameDistrict ? pair.jurisdictionKey : null;
}

/**
 * When GIS `zoningCode` is blank, read district from the parcel-record rail
 * (the ledger stamp, preferred), then the baked facets, then the atom-chain
 * zoningFact. Returns null when GIS already carries a code or when no source
 * holds a district.
 *
 * `jurisdictionKey` is carried from whichever source held the district. The
 * atom-chain rail is the one source that does not name one on the wire this
 * build reads, so a district from there resolves its table the way it always
 * has (the caller's own city-state derivation); nothing is guessed for it.
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
  const recordZoning = await districtFromParcelRecord(parcelNodeId);
  if (recordZoning) {
    return {
      district: recordZoning.district,
      source: "parcel-record",
      jurisdictionKey: recordZoning.jurisdictionKey,
    };
  }

  const { loadBakedNodeFacetSnapshot } = await import(
    "../../routes/brokerageNodeFacets.js"
  );
  const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
  const bakedZoning = districtFromFacets(snapshot?.facets);
  if (bakedZoning) {
    return {
      district: bakedZoning.district,
      source: "baked-snapshot",
      jurisdictionKey: bakedZoning.jurisdictionKey,
      snapshotAt: snapshot?.snapshotAt ?? null,
    };
  }

  const chainDistrict = await districtFromAtomChain(parcelNodeId);
  if (chainDistrict) {
    return {
      district: chainDistrict,
      source: "atom-chain",
      jurisdictionKey: null,
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
