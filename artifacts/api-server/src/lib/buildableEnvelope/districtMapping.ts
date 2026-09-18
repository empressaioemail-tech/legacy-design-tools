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

import { isPlannedDevelopmentCode } from "./plannedDevelopmentSetback";

export type DistrictMatchKind =
  | "matched" // zoningCode matched a district code
  | "fallback-conservative" // no zoning stamp; used the most-conservative district
  | "single" // table has one district; used it
  | "atom-sourced"; // codified table has no row for this code; built by
  // authoritativeSetbackSource.ts from a winning atom-chain/GIS-per-parcel
  // candidate, never by this file's own mapDistrict (WDLL P-232).

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
 *
 * P-257: the REVERSE direction (`districtCode.startsWith(zoningCode)`) has no
 * such evidence requirement and is where the measured defect came from — a
 * two-character code swallowed a longer, unrelated row (`PD` ->
 * `PD-Z Zero Lot Line Garden Home District`, `48021:70907`, which then served
 * 20/100/100/100 through the standing gates). `mapDistrict` guards the
 * planned-development class against BOTH directions; the remaining reverse
 * cases are a separate, unmeasured shape (see the lane close's known holes).
 */
function isSafePrefixMatch(zoningCode: string, districtCode: string): boolean {
  const shorter = Math.min(zoningCode.length, districtCode.length);
  return (
    shorter >= 2 &&
    (zoningCode.startsWith(districtCode) || districtCode.startsWith(zoningCode))
  );
}

/**
 * Does this table row this exact code? Exact token equality after
 * {@link normalizeCode}, no prefix and no fallback — the first half of the
 * planned-development gate's ordering, exported so the gate lives in one place
 * and no second row matcher is ever written.
 */
export function districtCodeHasExactRow(
  table: SetbackTable,
  zoningCode: string | null | undefined,
): boolean {
  const code = (zoningCode ?? "").trim();
  if (!code || !table.districts.length) return false;
  const norm = normalizeCode(code);
  return table.districts.some((d) => districtCode(d) === norm);
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
    // P-257: a one-row table is not a licence to paint a planned-development
    // code as that row. The row still wins when it IS this code (exact), or
    // when the parcel carries no code at all (the conservative fallback below);
    // a planned-development code with no row of its own refuses.
    // (`zoningCode` rather than `code`: the trimmed local is declared below.)
    if (
      isPlannedDevelopmentCode(zoningCode) &&
      !districtCodeHasExactRow(table, zoningCode)
    ) {
      return null;
    }
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
    /**
     * P-257 — a planned-development code never resolves another district's row.
     *
     * Placed AFTER the exact-match loop and BEFORE the prefix fallback, which is
     * exactly the "base vocabulary first" order `zoning-base-code.ts` records as
     * its one deliberate divergence from the census: a district the table really
     * rows resolves as a district (Smithville's `PD-Z`, Grand County's `PUD`),
     * and only a code with no row of its own is read as planned development.
     *
     * This is the whole measured defect: `PD` (a planned-development code) has
     * no row in Smithville's table, and the prefix fallback crossed it into
     * `PD-Z Zero Lot Line Garden Home District` — kind "matched", confidence
     * 0.7 — which is how `48021:70907` was served 20/100/100/100.
     */
    if (isPlannedDevelopmentCode(code)) {
      return null;
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

  // No zoning stamp: conservative setback estimate only. Callers must not
  // stamp safe.district_name as a real district (see absentZoningHonesty.ts).
  const safe = mostConservative(districts);
  return {
    district: safe,
    kind: "fallback-conservative",
    confidence: 0.35,
    note:
      "No zoning stamp — conservative setback estimate only; not a district determination. Verify zoning with the city.",
    zoningCode: null,
  };
}
