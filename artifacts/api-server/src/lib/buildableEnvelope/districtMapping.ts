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
 *
 * P-340: the remaining reverse case is measured now. Austin's `SF` — the
 * county store's base code, the value `brokeragePlaceBuildableEnvelope.ts`
 * reads as `effectiveZoningCode` for `48453:239852` and `48453:367134` — is a
 * prefix of six Austin rows, and the pre-P-340 longest-match rule crossed it
 * into `SF-4A` (15/3.5/5/10) while BOTH the city's own zoning layer and the
 * parcel's setback-rule atom name `SF-3`/`SF-2` (25/5/10/15). A code that
 * prefixes MORE THAN ONE row is not evidence of any one of them, so the
 * crossing is refused by {@link mapDistrict} rather than resolved to the
 * longest. This is the same doctrine already stated at the bottom of this
 * function ("an explicit GIS code that matches nothing returns null so callers
 * decline with setback-table-pending instead of inventing a wrong district"):
 * an ambiguous code matches no district either.
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
 * P-340 — pick the district code the route should RESOLVE with, out of the
 * ordered district-code signals, and never let a base code stand in for a
 * district it does not name.
 *
 * `signals` is most-specific-first (the parcel's own GIS zoning stamp, then
 * Spine's zoning fact, then the atom chain's zoning fact, then its setback
 * rule). The first signal that names a row in this jurisdiction's own table
 * wins; when NONE names a row the first signal is returned unchanged, so a
 * jurisdiction with no table, or a district no table rows, behaves exactly as
 * it did before this function existed.
 *
 * WHY THIS IS NOT A PRECEDENCE CHANGE. The jurisdiction is chosen from the
 * first signal, before and after (`brokeragePlaceBuildableEnvelope.ts` keeps
 * its own key derivation and passes it in), so a code that names no row can
 * never move a parcel between jurisdictions — it can only stop a base code
 * from being read as the longest row whose name it happens to begin.
 *
 * Measured, 2026-09-18: Austin's county-store stamp `SF` (base of `SF-1`..
 * `SF-6`, `SF-4A`) was crossed into `SF-4A` and served 15/3.5/5/10 for
 * `48453:239852` and `48453:367134`, whose city layer and whose own setback
 * atom both say `SF-3`/`SF-2` (25/5/10/15). With this function, `SF` names no
 * row, the atom chain's `SF-3` does, and both surfaces resolve the same row.
 */
export function firstResolvableDistrictCode(
  signals: ReadonlyArray<string | null | undefined>,
  jurisdictionKey: string | null,
  tableFor: (jurisdictionKey: string, districtCode: string) => SetbackTable | null,
): string {
  const codes = signals.map((c) => (c ?? "").trim()).filter((c) => c.length > 0);
  const first = codes[0] ?? "";
  if (!jurisdictionKey) return first;
  for (const code of codes) {
    const table = tableFor(jurisdictionKey, code);
    if (table && mapDistrict(table, code)) return code;
  }
  return first;
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
    const prefixMatches: SetbackDistrict[] = [];
    for (const d of districts) {
      const dc = districtCode(d);
      if (!dc) continue;
      if (dc === norm) {
        exact = d;
        break;
      }
      // P-340: a prefix crossing is evidence of a SPECIFIC row only when it
      // names exactly one. Collected rather than "longest wins" — see
      // `isSafePrefixMatch`.
      if (isSafePrefixMatch(norm, dc)) prefixMatches.push(d);
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
    /**
     * P-340 — an AMBIGUOUS prefix crossing is refused. `SF` names six Austin
     * rows, so it names none of them: the pre-P-340 rule took the longest
     * (`SF-4A`) and served 15/3.5/5/10 for two parcels whose city layer says
     * `SF-3`/`SF-2`. The codified candidate is dropped here and the atom-chain
     * candidate (which carries the city layer's own district) serves — the same
     * absence/decline path an unmatched code already takes, never an invented
     * district.
     */
    if (prefixMatches.length > 1) return null;
    const prefix = prefixMatches[0];
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
