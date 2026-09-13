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

import { mapDistrict, type DistrictMappingResult } from "./districtMapping";

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
  const corner =
    typeof rule.side_corner === "number"
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
 * Resolve setbacks for derive: codified table vs atom-chain/GIS, under R-1
 * (most-current source wins), same rule for every municipality — the
 * tier-first ranking this function used to run is deleted, not kept as a
 * fallback path.
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

  const mapped = mapDistrict(table, districtCode);
  if (!mapped || mapped.kind === "fallback-conservative") return null;

  const candidates: SetbackCandidate[] = [codifiedCandidate(table, mapped)];
  const atomC = args.atomRule ? atomCandidate(args.atomRule) : null;
  if (atomC) candidates.push(atomC);

  const resolution = resolveMostCurrentSetback(candidates);

  const winnerCandidate =
    resolution.status === "resolved"
      ? resolution.winner
      : tierHighest(resolution.candidates);

  const districtWithScalars = districtFromScalars(mapped, winnerCandidate.scalars);

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
