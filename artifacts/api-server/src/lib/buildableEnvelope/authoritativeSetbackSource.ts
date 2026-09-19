/**
 * Municipality-agnostic setback source resolution (WDLL setback geometry unification).
 *
 * Every city uses the same shape: collect eligible candidates, resolve under
 * R-1 (most-current source wins), serve the winner. No Bastrop-only branches.
 *
 * R-1 (`_decisions/2026-09-11_setback_source_most_current_wins.md`, shared
 * through `@empressaio/setback-corpus/resolve` by
 * `_decisions/2026-09-13_share_the_most_current_setback_resolver.md`): the
 * source with the most recent effective date wins, in every city. Authority
 * tier (codified-ordinance > gis-per-parcel > atom-chain) breaks a tie ONLY
 * when dates are equal or unreadable. This REPLACES the previous tier-first
 * ranking (tier decided first, date only broke a tie WITHIN one tier) --
 * that ranking was the exact bug R-1 exists to fix, and is deleted here, not
 * kept as a fallback. Dates are read AT SOURCE the same way the resolver's
 * own hauska-engine-side callers read them: a codified table's own
 * `effectiveDate` field (an "accessed ..." note is NOT an effective date --
 * it never was, and this file's own predecessor treating it as one was a
 * real R-1 violation, corrected here); an atom's `sourceVintage`, NEVER
 * `extractedAt` (extraction/emit time, not source time -- this file's own
 * predecessor read `extractedAt` first, another real violation corrected
 * here). A date that cannot be read this way is `dateBasis: "unreadable"`,
 * never a placeholder such as "1970-01-01".
 *
 * CONFLICT (unreadable-date disagreement, or two unattributed dates that
 * disagree): the resolver refuses to silently pick. This function still
 * serves ONE value on conflict (tier-highest among the disagreeing
 * candidates) for backward wire compatibility with every existing caller --
 * the same interim stance hauska-engine's `getSetbackTableForZoning` takes
 * (`display_meta.second_source`, disclosed not refused) -- but ALWAYS
 * attaches `conflict` naming every candidate and the reason, so a caller can
 * choose to refuse/disclose in a future row. Growing this function's return
 * into a true refusal-shaped type (no served value at all on conflict)
 * ripples into every caller listed above and is out of scope for this wave,
 * exactly as the engine's own equivalent growth is (P-154 wave 4 dispatch,
 * "Out of scope").
 */

import {
  getSetbackTableForZoning,
  type SetbackDistrict,
  type SetbackTable,
} from "@workspace/adapters";
import {
  dateFromAtomSourceVintage,
  dateFromTableEffectiveDate,
  resolveMostCurrentSetback,
  type SetbackCandidate,
  type SetbackDateBasis,
} from "@empressaio/setback-corpus/resolve";

import { mapDistrict, districtCodeHasExactRow, type DistrictMappingResult } from "./districtMapping";
import { plannedDevelopmentSetbackRefusalFor } from "./plannedDevelopmentSetback";

export type SetbackScalars = {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
  side_corner_ft?: number;
};

export type SetbackSourceKind =
  | "codified-ordinance"
  | "gis-per-parcel"
  | "atom-chain";

/** One candidate as named in a `conflict` disclosure — never a value the caller should treat as settled. */
export type SetbackConflictCandidate = {
  sourceLabel: string;
  sourceKind: SetbackSourceKind;
  scalars: SetbackScalars;
  sourceDate: string | null;
  dateBasis: SetbackDateBasis;
};

export type AuthoritativeSetbackResolution = {
  scalars: SetbackScalars;
  districtCode: string;
  sourceKind: SetbackSourceKind;
  sourceLabel: string;
  /** Wire-facing date string. "unreadable" (never a placeholder date) when the winner's date could not be read at source. */
  effectiveDate: string;
  /** How `effectiveDate` was established — see `SetbackDateBasis`. New field; additive. */
  dateBasis: SetbackDateBasis;
  citationUrl: string | null;
  table: SetbackTable;
  district: DistrictMappingResult;
  /**
   * Present ONLY when `resolveMostCurrentSetback` returned `conflict` for
   * this district: candidates disagreed and at least one side's date was
   * unreadable (or two unattributed dates disagreed). `scalars` above is
   * still populated (tier-highest, disclosed) for wire back-compat; a
   * caller that wants R-1's full "never a silent pick" behavior should
   * check this field before treating `scalars` as settled.
   */
  conflict?: {
    reason: string;
    candidates: ReadonlyArray<SetbackConflictCandidate>;
  };
};

export type AtomChainSetbackWire = {
  front?: number;
  side?: number;
  rear?: number;
  /**
   * P-340 — the wire's OWN spelling. The atom chain serves
   * camelCase-with-`Ft` (`sideCornerFt`), live-confirmed 2026-09-18 on
   * `retrieval/property-nodes/:id/atom-chain` for all seven P-340 subjects;
   * `side_corner` / `sideCorner` below are historical spellings kept so an
   * older wire still reads. Before this field existed here, the route's atom
   * candidate dropped the corner axis entirely — so on three of the seven
   * measured subjects (Buda `48209:140047`, San Marcos `48209:166141`,
   * `48209:97658`) the route could not see that the atom rule and the
   * codified row DISAGREE about the corner, and the R-1 conflict those three
   * carry was never declared on this side.
   */
  sideCornerFt?: number;
  side_corner?: number;
  sideCorner?: number;
  districtCode?: string | null;
  sourceAdapter?: string | null;
  sourceCitation?: string | null;
  extractedAt?: string | null;
  sourceVintage?: string | null;
};

const TIER_RANK: Record<SetbackSourceKind, number> = {
  "codified-ordinance": 3,
  "gis-per-parcel": 2,
  "atom-chain": 1,
};

/**
 * Table-level effective date, read AT SOURCE only: the table's own
 * `effectiveDate` field. An "accessed ..." note in `table.note` records
 * when someone LOOKED, not when the law took effect, and is deliberately
 * NOT treated as an effective date (matching
 * `@empressaio/setback-corpus/resolve`'s own `dateFromTableEffectiveDate`
 * doc comment) — this file's own predecessor did treat it as one, which was
 * a real R-1 violation. Returns "unreadable" (never a placeholder date such
 * as "1970-01-01") when no real effective date is on the table.
 */
export function effectiveDateForTable(table: SetbackTable): string {
  const { sourceDate } = dateFromTableEffectiveDate(
    (table as { effectiveDate?: string }).effectiveDate,
  );
  return sourceDate ?? "unreadable";
}

function scalarsFromDistrict(d: SetbackDistrict): SetbackScalars {
  return {
    front_ft: d.front_ft,
    side_ft: d.side_ft,
    rear_ft: d.rear_ft,
    ...(typeof d.side_corner_ft === "number"
      ? { side_corner_ft: d.side_corner_ft }
      : {}),
  };
}

function scalarsFromAtomRule(rule: AtomChainSetbackWire): SetbackScalars | null {
  if (
    typeof rule.front !== "number" ||
    typeof rule.side !== "number" ||
    typeof rule.rear !== "number"
  ) {
    return null;
  }
  // P-340: the wire's own spelling first (`sideCornerFt`), then the historical
  // ones — see `AtomChainSetbackWire`'s doc for why reading only the older two
  // made the route blind to a corner disagreement on three measured subjects.
  const corner =
    typeof rule.sideCornerFt === "number"
      ? rule.sideCornerFt
      : typeof rule.side_corner === "number"
        ? rule.side_corner
        : typeof rule.sideCorner === "number"
          ? rule.sideCorner
          : undefined;
  return {
    front_ft: rule.front,
    side_ft: rule.side,
    rear_ft: rule.rear,
    ...(typeof corner === "number" ? { side_corner_ft: corner } : {}),
  };
}

function atomSourceKind(rule: AtomChainSetbackWire): SetbackSourceKind {
  const adapter = (rule.sourceAdapter ?? rule.sourceCitation ?? "").toLowerCase();
  if (
    adapter.includes("layer-23") ||
    adapter.includes("per-parcel") ||
    adapter.includes("onclick")
  ) {
    return "gis-per-parcel";
  }
  return "atom-chain";
}

/** Build the codified-ordinance SetbackCandidate for the resolver. */
function codifiedCandidate(
  table: SetbackTable,
  mapped: DistrictMappingResult,
): SetbackCandidate {
  return {
    id: "codified-ordinance",
    sourceKind: "codified-ordinance",
    sourceLabel: table.jurisdictionDisplayName,
    scalars: scalarsFromDistrict(mapped.district),
    citationUrl: mapped.district.citation_url ?? null,
    ...dateFromTableEffectiveDate(
      (table as { effectiveDate?: string }).effectiveDate,
    ),
  };
}

/**
 * Build the atom-chain/gis-per-parcel SetbackCandidate for the resolver, or
 * null if the wire payload carries no usable scalars. Date is read from
 * `sourceVintage` ONLY, never `extractedAt` (emit time, not source time —
 * see `@empressaio/setback-corpus/resolve`'s `dateFromAtomSourceVintage`).
 */
function atomCandidate(rule: AtomChainSetbackWire): SetbackCandidate | null {
  const scalars = scalarsFromAtomRule(rule);
  if (!scalars) return null;
  return {
    id: "atom-chain",
    sourceKind: atomSourceKind(rule),
    sourceLabel:
      rule.sourceCitation ?? rule.sourceAdapter ?? "property atom-chain setback-rule",
    scalars,
    citationUrl: null,
    ...dateFromAtomSourceVintage(rule.sourceVintage),
  };
}

/** Tier-highest among a disagreeing set — used ONLY to pick the still-served value on a disclosed conflict, never to rank a clean resolution (that is `resolveMostCurrentSetback`'s job). */
function tierHighest(candidates: ReadonlyArray<SetbackCandidate>): SetbackCandidate {
  return [...candidates].sort(
    (a, b) => TIER_RANK[b.sourceKind] - TIER_RANK[a.sourceKind],
  )[0]!;
}

function districtFromScalars(
  mapped: DistrictMappingResult,
  scalars: SetbackScalars,
): DistrictMappingResult {
  return {
    ...mapped,
    district: {
      ...mapped.district,
      front_ft: scalars.front_ft,
      side_ft: scalars.side_ft,
      rear_ft: scalars.rear_ft,
      side_corner_ft: scalars.side_corner_ft ?? mapped.district.side_corner_ft,
    },
  };
}

/**
 * Build a DistrictMappingResult from the winning candidate when the codified
 * table has no row for this district at all (WDLL P-232: the atom candidate
 * becomes REACHABLE, not automatically the winner — R-1 in
 * `resolveMostCurrentSetback` still decides that upstream of this call).
 * There is no codified `mapped` row to overlay onto here, unlike
 * `districtFromScalars` above.
 *
 * `max_height_ft` / `max_lot_coverage_pct` / `max_impervious_pct` are not
 * part of a setback rule's wire shape (`AtomChainSetbackWire`) — marked
 * `not_specified` rather than given an invented bulk-standards number,
 * the same convention the codified tables already use for a genuinely
 * absent scalar (e.g. bastrop-development-code.json's own
 * `max_lot_coverage_pct` rows).
 */
function districtFromAtomOnly(
  districtCode: string,
  winner: SetbackCandidate,
): DistrictMappingResult {
  const cornerKnown = typeof winner.scalars.side_corner_ft === "number";
  return {
    district: {
      district_name: districtCode,
      front_ft: winner.scalars.front_ft,
      side_ft: winner.scalars.side_ft,
      rear_ft: winner.scalars.rear_ft,
      side_corner_ft: cornerKnown ? winner.scalars.side_corner_ft! : 0,
      max_height_ft: 0,
      max_lot_coverage_pct: 0,
      max_impervious_pct: 0,
      citation_url: winner.citationUrl ?? "",
      provenance: {
        ...(cornerKnown ? {} : { side_corner_ft: { not_specified: true } }),
        max_height_ft: { not_specified: true },
        max_lot_coverage_pct: { not_specified: true },
        max_impervious_pct: { not_specified: true },
      },
    },
    kind: "atom-sourced",
    confidence: 0.85,
    note:
      `Zoning "${districtCode}" has no row in the codified ordinance table; ` +
      `served from ${winner.sourceLabel} (property atom chain / per-parcel ` +
      `GIS), not the ordinance chart.`,
    zoningCode: districtCode,
  };
}

/**
 * Resolve setbacks for derive: codified table vs atom-chain/GIS, under R-1
 * (most-current source wins), same rule for every municipality — the
 * tier-first ranking this function used to run is deleted, not kept as a
 * fallback path.
 *
 * WDLL P-232: the atom candidate is built BEFORE the codified-row gate can
 * return, so a district the codified table has no row for still reaches the
 * resolver when the atom chain carries a usable dated rule. A district with
 * no usable candidate on EITHER side still returns null — this makes an
 * existing value reachable, it does not manufacture one.
 */
export function resolveAuthoritativeSetbacks(args: {
  jurisdictionKey: string | null;
  districtCode: string;
  atomRule: AtomChainSetbackWire | null;
}): AuthoritativeSetbackResolution | null {
  const districtCode = args.districtCode.trim();
  if (!districtCode) return null;
  const jurisdictionKey = args.jurisdictionKey?.trim() || null;
  if (!jurisdictionKey) return null;

  const table = getSetbackTableForZoning(jurisdictionKey, districtCode);
  if (!table?.districts.length) return null;

  /**
   * P-257 — a planned-development code resolves NOTHING, on either side.
   *
   * The gate is here, ahead of both the codified row gate and the atom
   * candidate, because a planned-development district's standards are in its
   * own ordinance and development plan and no candidate on either side can
   * supply them: a codified `PD` row would be a district schedule the code does
   * not have, and a per-parcel/atom-chain rule for a PUD is the same defect one
   * layer down (the measured `48021:70907` was served 20/100/100/100 from the
   * parcel record's own precomputed axes). `mapDistrict` refuses the codified
   * side by the same rule and the same ordering; this makes the atom side agree.
   *
   * `districtCodeHasExactRow` keeps a district the table really rows resolving
   * as a district — Smithville's `PD-Z` and Grand County's `PUD` are both real
   * rows and neither is refused.
   */
  if (
    plannedDevelopmentSetbackRefusalFor(
      { jurisdictionKey, districtCode },
      (code) => districtCodeHasExactRow(table, code),
    )
  ) {
    return null;
  }

  const mapped = mapDistrict(table, districtCode);
  const hasCodifiedRow = !!mapped && mapped.kind !== "fallback-conservative";

  const atomC = args.atomRule ? atomCandidate(args.atomRule) : null;

  // Neither side has a usable candidate: the honest decline this row must
  // not disturb (falsifier 1 — a district unusable on both sides still
  // refuses).
  if (!hasCodifiedRow && !atomC) return null;

  const candidates: SetbackCandidate[] = [];
  if (hasCodifiedRow && mapped) candidates.push(codifiedCandidate(table, mapped));
  if (atomC) candidates.push(atomC);

  const resolution = resolveMostCurrentSetback(candidates);

  const winnerCandidate =
    resolution.status === "resolved"
      ? resolution.winner
      : tierHighest(resolution.candidates);

  const districtWithScalars =
    hasCodifiedRow && mapped
      ? districtFromScalars(mapped, winnerCandidate.scalars)
      : districtFromAtomOnly(districtCode, winnerCandidate);

  return {
    scalars: winnerCandidate.scalars,
    districtCode,
    sourceKind: winnerCandidate.sourceKind,
    sourceLabel: winnerCandidate.sourceLabel,
    effectiveDate: winnerCandidate.sourceDate ?? "unreadable",
    dateBasis: winnerCandidate.dateBasis,
    citationUrl: winnerCandidate.citationUrl,
    table,
    district: districtWithScalars,
    ...(resolution.status === "conflict"
      ? {
          conflict: {
            reason: resolution.reason,
            candidates: resolution.candidates.map((c) => ({
              sourceLabel: c.sourceLabel,
              sourceKind: c.sourceKind,
              scalars: c.scalars,
              sourceDate: c.sourceDate,
              dateBasis: c.dateBasis,
            })),
          },
        }
      : {}),
  };
}
