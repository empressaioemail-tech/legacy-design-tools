/**
 * District mapping (Problem B): map a parcel's zoningCode onto ITS setback
 * district row in the jurisdiction table, with an HONEST fallback.
 *
 * The setback table has many district rows (`district_name` like
 * "R-MD Residential Medium Density"). A parcel carries a free-text `zoningCode`
 * (from Cotality site-location enrichment) like "R-MD", "R-1", "SF-1". We map
 * the code onto a district by normalized-code match; when the code is absent or
 * matches nothing, we do NOT silently pick a wrong district — we fall back to a
 * clearly-labeled MOST-CONSERVATIVE district (largest combined setbacks, which
 * yields the SMALLEST buildable envelope, the safe direction to be wrong on a
 * commitment-#1 surface) and flag the result "district unknown — verify".
 */

import type { SetbackDistrict, SetbackTable } from "@workspace/adapters";

export type DistrictMatchKind =
  | "matched" // zoningCode matched a district code
  | "fallback-conservative" // no match; used the most-conservative district
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
 * conservative (smaller buildable area). Used to pick the safe fallback.
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
 * Map a zoningCode to a district. Never returns a wrong-but-confident district:
 * an unmatched code degrades to the most-conservative district with a low
 * confidence and an explicit "verify" note.
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
      if (
        isSafePrefixMatch(norm, dc) &&
        dc.length > prefixLen
      ) {
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
  }

  // No zoning code, or it matched nothing. Fall back to the most-conservative
  // district (smallest resulting envelope — the safe direction) and flag it.
  const safe = mostConservative(districts);
  return {
    district: safe,
    kind: "fallback-conservative",
    confidence: 0.35,
    note: code
      ? `Zoning "${code}" did not match any district — using the most-conservative district (${safe.district_name}). Verify the district.`
      : `No zoning on this parcel — using the most-conservative district (${safe.district_name}). Verify the district.`,
    zoningCode: code || null,
  };
}
