/**
 * District mapping (Problem B): map a parcel's zoningCode onto ITS setback
 * district row in the jurisdiction table.
 *
 * Matched codes use the matched row. Absent zoning (null/blank) still uses the
 * most-conservative district with a low-confidence verify note — that path is
 * for parcels that have a jurisdiction but no stamp yet. An explicit GIS code
 * that matches nothing returns null so callers decline with
 * setback-table-pending instead of inventing a wrong district (WDLL 51: PDD
 * must not paint as CLB/RHD).
 */

import type { SetbackDistrict, SetbackTable } from "@workspace/adapters";

export type DistrictMatchKind =
  | "matched" // zoningCode matched a district code
  | "fallback-conservative" // no zoning stamp; used the most-conservative district
  | "single"; // table has one district; used it

export interface DistrictMappingResult {
  district: SetbackDistrict;
  kind: DistrictMatchKind;
  /** 0..1 confidence contribution from the district mapping. */
  confidence: number;
  note: string;
  /** The zoningCode we tried to map, echoed for the disclosure. */
  zoningCode: string | null;
}

/** Leading code token of a district_name ("R-MD Residential ..." -> "R-MD"). */
export function districtCode(district: SetbackDistrict): string {
  const first = district.district_name.trim().split(/\s+/)[0] ?? "";
  return normalizeCode(first);
}

/** Normalize a zoning code for comparison: upper, strip spaces + punctuation. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * "Combined setback" size proxy — front + rear + 2*side. Larger => more
 * conservative (smaller buildable area). Used to pick the safe fallback when
 * zoning is absent.
 */
function combinedSetback(d: SetbackDistrict): number {
  return d.front_ft + d.rear_ft + 2 * d.side_ft;
}

/** The most-conservative district (largest combined setback). */
function mostConservative(districts: SetbackDistrict[]): SetbackDistrict {
  return districts.reduce((a, b) =>
    combinedSetback(b) > combinedSetback(a) ? b : a,
  );
}

/**
 * Prefixes are a deliberately weak fallback for suffix variants such as
 * `R-1A` against a table's `R-1` row. A one-character token is never enough
 * evidence: it would collapse `P-5` (a Bastrop B3 place type) into the
 * unrelated `P Public/Institutional` row.
 */
function isSafePrefixMatch(zoningCode: string, districtCode: string): boolean {
  const shorter = Math.min(zoningCode.length, districtCode.length);
  return (
    shorter >= 2 &&
    (zoningCode.startsWith(districtCode) || districtCode.startsWith(zoningCode))
  );
}

/**
 * Map a zoningCode to a district.
 * - Exact / guarded-prefix match -> matched.
 * - Blank/absent zoning on a multi-row table -> conservative fallback.
 * - Explicit unmatched code -> null (caller declines; do not invent).
 */
export function mapDistrict(
  table: SetbackTable,
  zoningCode: string | null | undefined,
): DistrictMappingResult | null {
  const districts = table.districts;
  if (!districts.length) return null;

  if (districts.length === 1) {
    return {
      district: districts[0]!,
      kind: "single",
      confidence: 0.8,
      note: `Jurisdiction has a single setback district (${districts[0]!.district_name}).`,
      zoningCode: zoningCode ?? null,
    };
  }

  const code = (zoningCode ?? "").trim();
  if (code) {
    const norm = normalizeCode(code);
    let exact: SetbackDistrict | null = null;
    let prefix: SetbackDistrict | null = null;
    let prefixLen = -1;
    for (const d of districts) {
      const dc = districtCode(d);
      if (!dc) continue;
      if (dc === norm) {
        exact = d;
        break;
      }
      if (isSafePrefixMatch(norm, dc) && dc.length > prefixLen) {
        prefix = d;
        prefixLen = dc.length;
      }
    }

    if (exact) {
      return {
        district: exact,
        kind: "matched",
        confidence: 0.9,
        note: `Zoning "${code}" matched district ${exact.district_name}.`,
        zoningCode: code,
      };
    }
    if (prefix) {
      return {
        district: prefix,
        kind: "matched",
        confidence: 0.7,
        note: `Zoning "${code}" mapped to district ${prefix.district_name} by code prefix.`,
        zoningCode: code,
      };
    }
    // Explicit GIS stamp with no table row: decline rather than invent.
    return null;
  }

  // No zoning stamp: conservative fallback with verify note.
  const safe = mostConservative(districts);
  return {
    district: safe,
    kind: "fallback-conservative",
    confidence: 0.35,
    note: `No zoning on this parcel — using the most-conservative district (${safe.district_name}). Verify the district.`,
    zoningCode: null,
  };
}
