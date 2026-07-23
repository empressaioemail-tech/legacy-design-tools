/**
 * District mapping (Problem B): map a parcel's zoningCode onto ITS setback
 * district row in the jurisdiction table, with an HONEST no-match decline.
 *
 * The setback table has many district rows (`district_name` like
 * "R-MD Residential Medium Density"). A parcel carries a free-text `zoningCode`
 * (from Cotality site-location enrichment or GIS stamps) like "R-MD", "R-1",
 * "SF-1". We map the code onto a district by normalized-code match; when the
 * code is absent or matches nothing, we do NOT invent a district row — callers
 * decline with setback-table-pending / no-district. (WDLL 51: no silent
 * conservative substitution for unmatched GIS codes.)
 */

import type { SetbackDistrict, SetbackTable } from "@workspace/adapters";

export type DistrictMatchKind =
  | "matched" // zoningCode matched a district code
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
 * Map a zoningCode to a district. Returns null when the code is absent or
 * unmatched so the envelope path can decline honestly instead of inventing a
 * district.
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
  if (!code) return null;

  const norm = normalizeCode(code);
  // Exact code match first, then a guarded segment/stem prefix match (e.g.
  // "R-1" matches "R-1A"). One-character tokens never prefix-match: "P"
  // must not map B3 "P-5" to "P Public/Institutional".
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
    // A multi-character shared stem is a weaker signal; keep the longest
    // matching district code.
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

  return null;
}
