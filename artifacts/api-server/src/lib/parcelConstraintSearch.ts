/**
 * P-106 items 3, 4 and 5. Constraint search over the parcel constraint index:
 * a geographic bound plus a filter set, answered as THREE SETS.
 *
 * THE ONE IDEA THIS FILE EXISTS TO GET RIGHT.
 * A filter over a rail with gaps has three answers per parcel, never two:
 *
 *   matched       every filter was evaluable on this parcel and every one passed
 *   excluded      at least one filter was evaluable and DEFINITIVELY failed
 *   notEvaluated  no filter definitively failed, and at least one could not be
 *                 evaluated at all, so this parcel might qualify and we do not
 *                 know
 *
 * Including the not-evaluated set in `matched` fabricates a claim. Dropping it
 * silently hides parcels that might qualify while the caller believes they saw
 * everything. Both are the defect this operation is named against, so a
 * response that omits or merges any of the three is refused by the type: all
 * three counts are required fields.
 *
 * PRECEDENCE, AND WHY EXCLUDED BEATS NOT-EVALUATED.
 * A parcel with one acre and no flood determination, asked for "two acres or
 * more, outside the floodplain", is EXCLUDED. It fails on acreage whatever the
 * flood answer turns out to be, so calling it not-evaluated would overstate the
 * uncertainty as badly as the reverse understates it. Not-evaluated is reserved
 * for parcels whose qualification genuinely turns on a rail nobody measured.
 *
 * COUNTING RULE FOR `byRail`, stated here because it is the one number a reader
 * will misread: `notEvaluated.byRail[r]` counts PARCELS in the not-evaluated set
 * whose rail `r` could not be evaluated. A parcel missing two rails increments
 * both, so the byRail values SUM TO MORE than `notEvaluated.count` and are not a
 * partition. Same rule for `excluded.byRail`. The set counts are the partition;
 * the byRail maps are per-rail attributions.
 *
 * SQL SHAPE. `buildConstraintSearchSql` is pure and returns `{ text, params }`.
 * No caller value is ever interpolated into the text: rails and operators index
 * into closed tables defined here, and every literal is a bind parameter. That
 * is testable without a database, which is why the SQL lives in a pure function
 * rather than inside the route.
 */

import {
  CONSTRAINT_RAILS,
  type ConstraintRail,
} from "./parcelConstraintProjection";

export const CONSTRAINT_SEARCH_CAP = 50;
export const CONSTRAINT_SEARCH_MAX_CAP = 200;

/**
 * The six Central Texas counties the v1 projection covers. A county outside
 * this list is REFUSED, never answered with an empty set: an empty result is
 * not an absence, and "no parcels in Harris County match" would be a false
 * claim about a county the projection has never been built for.
 */
export const CONSTRAINT_SEARCH_COUNTIES = [
  "48021",
  "48055",
  "48209",
  "48309",
  "48453",
  "48491",
] as const;

/**
 * How stale a projection may be before the response says so. This is a
 * DECLARATION, not a refusal: the rows are still true as of `builtAt`, and
 * hiding the age is the defect, not serving it. 26 hours admits a daily
 * rebuild that slipped, and nothing more.
 */
export const CONSTRAINT_PROJECTION_STALE_AFTER_HOURS = 26;

/** Operators, closed set, per rail kind. */
export const NUMERIC_OPS = ["gte", "lte", "eq"] as const;
export const TEXT_OPS = ["eq", "in", "absent"] as const;
export const FLAG_OPS = ["is_true", "is_false"] as const;

export type ConstraintFilter =
  | { rail: ConstraintRail; op: (typeof NUMERIC_OPS)[number]; number: number }
  | { rail: ConstraintRail; op: "eq"; text: string }
  | { rail: ConstraintRail; op: "in"; texts: string[] }
  /** Matches only a POSITIVE verified absence. Never an unmeasured cell. */
  | { rail: ConstraintRail; op: "absent" }
  | { rail: ConstraintRail; op: (typeof FLAG_OPS)[number] };

export type ConstraintSearchRefuse = {
  refused: true;
  code:
    | "constraint_bound_missing"
    | "constraint_county_out_of_scope"
    | "constraint_single_address"
    | "constraint_filters_missing"
    | "constraint_rail_unknown"
    | "constraint_op_unsupported"
    | "constraint_cap_invalid"
    | "constraint_rail_unmeasured"
    | "constraint_projection_missing";
  reason: string;
  /** Present on constraint_rail_unmeasured: the number the refusal rests on. */
  detail?: Record<string, unknown>;
};

export type ConstraintSearchHit = {
  parcelNodeId: string;
  countyFips: string;
  /**
   * Only rails the caller filtered on, so a hit never smuggles an unasked rail.
   * `value` is the rail's own value; `flag` is the separate boolean a rail may
   * carry alongside it. Flood is the one rail with both, and its DETERMINATION
   * is the flag (`inSpecialFloodHazardArea`) while `value` is the zone letter,
   * which can legitimately be null under a present determination. They are two
   * fields rather than one because collapsing them would drop whichever was
   * written second.
   */
  rails: Record<
    string,
    {
      state: string;
      value: string | number | null;
      flag?: boolean | null;
    }
  >;
};

export type ConstraintSearchOk = {
  countyFips: string;
  filters: ConstraintFilter[];
  matched: {
    count: number;
    cap: number;
    received: number;
    truncated: boolean;
    parcels: ConstraintSearchHit[];
  };
  excluded: { count: number; byRail: Record<string, number> };
  notEvaluated: { count: number; byRail: Record<string, number> };
  /** matched.count + excluded.count + notEvaluated.count. The partition's total. */
  countyParcels: number;
  /**
   * Per filtered rail, the share of the WHOLE county that rail could not be
   * evaluated on. Reported on success as well as in a refusal, because a
   * result that passed the ceiling still owes the caller the coverage it
   * rests on.
   */
  unmeasuredPctByRail: Record<string, number>;
  countingRule: string;
  projection: {
    builtAt: string;
    ageHours: number;
    stale: boolean;
    staleAfterHours: number;
  };
};

export type ConstraintSearchResult = ConstraintSearchOk | ConstraintSearchRefuse;

/**
 * A query that names one street address is a LOOKUP, and `find_parcel` is the
 * tool for it. Refusing here rather than answering is the point: two tools that
 * both accept an address are two tools a caller has to guess between.
 */
const HOUSE_NUMBER_PREFIX_RE = /^\s*\d+[A-Za-z]?\s+\S/;

export function readsAsSingleAddress(value: string | undefined): boolean {
  if (!value) return false;
  return HOUSE_NUMBER_PREFIX_RE.test(value);
}

export function isConstraintSearchCounty(fips: string): boolean {
  return (CONSTRAINT_SEARCH_COUNTIES as readonly string[]).includes(fips);
}

/* ------------------------------------------------------------------ */
/* Column mapping. One place, so a rename cannot half-land.            */
/* ------------------------------------------------------------------ */

const RAIL_COLUMNS: Record<
  ConstraintRail,
  { state: string; number?: string; text?: string; flag?: string }
> = {
  acreage: { state: "acreage_state", number: "acreage_acres" },
  landUse: { state: "land_use_state", text: "land_use_code" },
  cityLimits: { state: "city_limits_state", text: "city_limits" },
  etj: { state: "etj_state", text: "etj" },
  zoningDistrict: { state: "zoning_state", text: "zoning_district" },
  flood: { state: "flood_state", text: "flood_zone", flag: "flood_in_sfha" },
  specialDistrict: {
    state: "special_district_state",
    text: "special_district_id",
  },
  marketValue: { state: "market_value_state", number: "market_value" },
  landValue: { state: "land_value_state", number: "land_value" },
  improvementValue: {
    state: "improvement_value_state",
    number: "improvement_value",
  },
  yearBuilt: { state: "year_built_state", number: "year_built" },
};

export const CONSTRAINT_INDEX_TABLE = "pe_parcel_constraint_index";

export function railColumns(rail: ConstraintRail) {
  return RAIL_COLUMNS[rail];
}

export function isConstraintRail(value: string): value is ConstraintRail {
  return (CONSTRAINT_RAILS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Filter validation                                                    */
/* ------------------------------------------------------------------ */

export function validateFilters(
  filters: ConstraintFilter[],
): ConstraintSearchRefuse | null {
  if (filters.length === 0) {
    return {
      refused: true,
      code: "constraint_filters_missing",
      reason:
        "At least one filter is required. A county with no filter is not a search; use the county's parcel list.",
    };
  }
  for (const filter of filters) {
    if (!isConstraintRail(filter.rail)) {
      return {
        refused: true,
        code: "constraint_rail_unknown",
        reason: `Unknown rail ${String(filter.rail)}. Known rails: ${CONSTRAINT_RAILS.join(", ")}.`,
      };
    }
    const cols = RAIL_COLUMNS[filter.rail];
    if (filter.op === "gte" || filter.op === "lte") {
      if (!cols.number) {
        return {
          refused: true,
          code: "constraint_op_unsupported",
          reason: `Rail ${filter.rail} carries no ordered value, so ${filter.op} cannot be applied to it.`,
        };
      }
      continue;
    }
    if (filter.op === "is_true" || filter.op === "is_false") {
      if (!cols.flag) {
        return {
          refused: true,
          code: "constraint_op_unsupported",
          reason: `Rail ${filter.rail} carries no boolean flag, so ${filter.op} cannot be applied to it.`,
        };
      }
      continue;
    }
    if (filter.op === "in") {
      if (!cols.text) {
        return {
          refused: true,
          code: "constraint_op_unsupported",
          reason: `Rail ${filter.rail} carries no categorical value, so in cannot be applied to it.`,
        };
      }
      if (!("texts" in filter) || filter.texts.length === 0) {
        return {
          refused: true,
          code: "constraint_op_unsupported",
          reason: `Rail ${filter.rail} filter op in requires a non-empty texts list.`,
        };
      }
      continue;
    }
    if (filter.op === "eq") {
      const isNumberEq = "number" in filter;
      if (isNumberEq && !cols.number) {
        return {
          refused: true,
          code: "constraint_op_unsupported",
          reason: `Rail ${filter.rail} carries no ordered value, so a numeric eq cannot be applied to it.`,
        };
      }
      if (!isNumberEq && !cols.text) {
        return {
          refused: true,
          code: "constraint_op_unsupported",
          reason: `Rail ${filter.rail} carries no categorical value, so a text eq cannot be applied to it.`,
        };
      }
      continue;
    }
    if (filter.op === "absent") continue;
    return {
      refused: true,
      code: "constraint_op_unsupported",
      reason: `Unsupported op ${String((filter as { op: string }).op)}.`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The SQL. Pure; every value is a bind parameter.                      */
/* ------------------------------------------------------------------ */

type Bind = { text: string; params: unknown[] };

/**
 * A cell is EVALUABLE when somebody determined something about it: a value
 * (`present`) or a positive verified absence (`absent-verified`). `unknown`,
 * `unread` and `refused` are the three ways of not knowing, and they all make
 * the cell unevaluable. This predicate is the whole three-set mechanism; if it
 * ever admits a fourth state, the not-evaluated set silently drains into the
 * other two.
 */
function evaluableSql(stateColumn: string): string {
  return `${stateColumn} in ('present','absent-verified')`;
}

/**
 * Does this filter DEFINITIVELY pass on this row? Only ever true when the cell
 * is evaluable, so a NULL value can never satisfy a comparison.
 */
function passesSql(filter: ConstraintFilter, nextParam: () => string): string {
  const cols = RAIL_COLUMNS[filter.rail];
  const evaluable = evaluableSql(cols.state);
  switch (filter.op) {
    case "gte":
      return `(${evaluable} and ${cols.state} = 'present' and ${cols.number} >= ${nextParam()})`;
    case "lte":
      return `(${evaluable} and ${cols.state} = 'present' and ${cols.number} <= ${nextParam()})`;
    case "eq":
      return "number" in filter
        ? `(${evaluable} and ${cols.state} = 'present' and ${cols.number} = ${nextParam()})`
        : `(${evaluable} and ${cols.state} = 'present' and ${cols.text} = ${nextParam()})`;
    case "in":
      return `(${evaluable} and ${cols.state} = 'present' and ${cols.text} = any(${nextParam()}))`;
    case "absent":
      // Matches ONLY a positive verified absence. This is the operator that
      // makes "unzoned land" and "outside every special district" answerable,
      // and it must never widen to admit an unmeasured cell.
      return `(${cols.state} = 'absent-verified')`;
    case "is_true":
      return `(${evaluable} and ${cols.state} = 'present' and ${cols.flag} is true)`;
    case "is_false":
      // A verified absence of a flood determination IS "not in the SFHA": FEMA
      // mapped the area and drew no zone over this parcel. That is exactly the
      // value of keeping absent-verified separate from unmeasured, so it is
      // admitted here deliberately and only here.
      return `((${cols.state} = 'present' and ${cols.flag} is false) or ${cols.state} = 'absent-verified')`;
    default:
      throw new Error(`unsupported op ${String((filter as { op: string }).op)}`);
  }
}

export function buildConstraintSearchSql(input: {
  countyFips: string;
  filters: ConstraintFilter[];
  cap: number;
}): Bind {
  const params: unknown[] = [input.countyFips];
  const pass: string[] = [];
  const evaluable: string[] = [];
  for (const filter of input.filters) {
    const cols = RAIL_COLUMNS[filter.rail];
    const sql = passesSql(filter, () => {
      const placeholder = `$${params.length + 1}`;
      if (filter.op === "in") params.push((filter as { texts: string[] }).texts);
      else if ("number" in filter) params.push((filter as { number: number }).number);
      else if ("text" in filter) params.push((filter as { text: string }).text);
      return placeholder;
    });
    pass.push(sql);
    evaluable.push(
      filter.op === "absent"
        ? `${cols.state} in ('present','absent-verified')`
        : evaluableSql(cols.state),
    );
  }
  const allPass = pass.map((p) => `(${p})`).join(" and ");
  // A parcel is EXCLUDED when at least one filter was evaluable and did not
  // pass. Written as "evaluable and not passing", per filter, so an unevaluable
  // cell can never contribute an exclusion.
  const anyDefiniteFail = input.filters
    .map((filter, i) => `(${evaluable[i]} and not (${pass[i]}))`)
    .join(" or ");
  const anyUnevaluable = input.filters
    .map((_, i) => `(not (${evaluable[i]}))`)
    .join(" or ");

  const perRailNotEvaluated = input.filters
    .map(
      (filter, i) =>
        `count(*) filter (where verdict = 'notEvaluated' and not (${evaluable[i]})) as "ne_${filter.rail}_${i}"`,
    )
    .join(",\n         ");
  const perRailExcluded = input.filters
    .map(
      (filter, i) =>
        `count(*) filter (where verdict = 'excluded' and ${evaluable[i]} and not (${pass[i]})) as "ex_${filter.rail}_${i}"`,
    )
    .join(",\n         ");
  /**
   * The rail's unmeasured share over the WHOLE county, not only within the
   * not-evaluated set. This is what item 5's refusal rests on, and computing it
   * in the same statement as the answer means the number in the refusal and the
   * number in the result come from one snapshot rather than from a coverage
   * table somebody has to remember to refresh.
   */
  const perRailUnmeasured = input.filters
    .map(
      (filter, i) =>
        `count(*) filter (where not (${evaluable[i]})) as "un_${filter.rail}_${i}"`,
    )
    .join(",\n         ");

  const selectedColumns = [
    ...new Set(
      input.filters.flatMap((f) => {
        const c = RAIL_COLUMNS[f.rail];
        return [c.state, c.number, c.text, c.flag].filter(
          (x): x is string => typeof x === "string",
        );
      }),
    ),
  ];

  const capPlaceholder = `$${params.length + 1}`;
  params.push(input.cap);

  const text = `
with scoped as (
  select parcel_node_id, county_fips, built_at${selectedColumns.length ? ",\n         " + selectedColumns.join(",\n         ") : ""}
    from ${CONSTRAINT_INDEX_TABLE}
   where county_fips = $1
),
judged as (
  select *,
         case
           when (${anyDefiniteFail}) then 'excluded'
           when (${anyUnevaluable}) then 'notEvaluated'
           when (${allPass}) then 'matched'
           else 'notEvaluated'
         end as verdict
    from scoped
),
tally as (
  select count(*) as county_parcels,
         count(*) filter (where verdict = 'matched') as matched,
         count(*) filter (where verdict = 'excluded') as excluded,
         count(*) filter (where verdict = 'notEvaluated') as not_evaluated,
         min(built_at) as built_at_min,
         max(built_at) as built_at_max,
         ${perRailNotEvaluated},
         ${perRailExcluded},
         ${perRailUnmeasured}
    from judged
),
page as (
  select parcel_node_id, county_fips${selectedColumns.length ? ",\n         " + selectedColumns.join(",\n         ") : ""}
    from judged
   where verdict = 'matched'
   order by parcel_node_id
   limit ${capPlaceholder}
)
select (select row_to_json(tally) from tally) as tally,
       coalesce((select json_agg(row_to_json(page)) from page), '[]'::json) as page
`;
  return { text, params };
}

/**
 * Turn the two-row SQL answer into the wire shape. Kept separate from the SQL
 * so the three-set assembly is unit-testable against fixtures with no database.
 */
export function assembleConstraintSearchResult(input: {
  countyFips: string;
  filters: ConstraintFilter[];
  cap: number;
  tally: Record<string, unknown> | null;
  page: Array<Record<string, unknown>>;
  now: Date;
  /**
   * Item 5's ceiling, and the one number in this file that is NOT the lane's
   * to choose: a filter on a rail unmeasured above this share of the county is
   * refused, carrying the measured number. `null` means no operator ruling has
   * been made, and then NO gate applies — a default here would be exactly the
   * silently-picked threshold the card forbids.
   */
  unmeasuredRefuseAbovePct: number | null;
}): ConstraintSearchResult {
  if (!input.tally) {
    return {
      refused: true,
      code: "constraint_projection_missing",
      reason: `No constraint index rows exist for county ${input.countyFips}. The projection has not been built for it; that is not a claim that no parcels match.`,
    };
  }
  const tally = input.tally;
  const num = (key: string) => Number(tally[key] ?? 0);
  const countyParcels = num("county_parcels");
  if (countyParcels === 0) {
    return {
      refused: true,
      code: "constraint_projection_missing",
      reason: `No constraint index rows exist for county ${input.countyFips}. The projection has not been built for it; that is not a claim that no parcels match.`,
    };
  }
  // Item 5's refusal comes BEFORE the result is assembled, and it rests on a
  // number measured in the same statement that produced the answer.
  if (input.unmeasuredRefuseAbovePct != null) {
    const limit = input.unmeasuredRefuseAbovePct / 100;
    for (let i = 0; i < input.filters.length; i += 1) {
      const filter = input.filters[i];
      const share = num(`un_${filter.rail}_${i}`) / countyParcels;
      if (share > limit) {
        return {
          refused: true,
          code: "constraint_rail_unmeasured",
          reason:
            `Rail ${filter.rail} is unmeasured on ${(share * 100).toFixed(1)} percent of the ${countyParcels} parcels ` +
            `in county ${input.countyFips}, above the ${input.unmeasuredRefuseAbovePct} percent ceiling for a filter. ` +
            "Refusing rather than returning a search that evaluated a small fraction of the county.",
          detail: {
            rail: filter.rail,
            countyFips: input.countyFips,
            countyParcels,
            unmeasuredParcels: num(`un_${filter.rail}_${i}`),
            unmeasuredPct: Number((share * 100).toFixed(1)),
            ceilingPct: input.unmeasuredRefuseAbovePct,
          },
        };
      }
    }
  }
  const matched = num("matched");
  const excluded = num("excluded");
  const notEvaluated = num("not_evaluated");
  const neByRail: Record<string, number> = {};
  const exByRail: Record<string, number> = {};
  const unmeasuredPctByRail: Record<string, number> = {};
  input.filters.forEach((filter, i) => {
    const ne = num(`ne_${filter.rail}_${i}`);
    const ex = num(`ex_${filter.rail}_${i}`);
    if (ne) neByRail[filter.rail] = (neByRail[filter.rail] ?? 0) + ne;
    if (ex) exByRail[filter.rail] = (exByRail[filter.rail] ?? 0) + ex;
    unmeasuredPctByRail[filter.rail] = Number(
      ((num(`un_${filter.rail}_${i}`) / countyParcels) * 100).toFixed(1),
    );
  });
  const builtAtRaw = tally.built_at_max;
  const builtAt =
    builtAtRaw instanceof Date
      ? builtAtRaw.toISOString()
      : String(builtAtRaw ?? "");
  const ageHours = builtAt
    ? (input.now.getTime() - new Date(builtAt).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;
  const parcels: ConstraintSearchHit[] = input.page.map((row) => {
    const rails: ConstraintSearchHit["rails"] = {};
    for (const filter of input.filters) {
      const cols = RAIL_COLUMNS[filter.rail];
      const state = String(row[cols.state] ?? "unread");
      let value: string | number | null = null;
      if (cols.number && row[cols.number] != null) value = Number(row[cols.number]);
      else if (cols.text && row[cols.text] != null) value = String(row[cols.text]);
      const flag =
        cols.flag && row[cols.flag] != null ? Boolean(row[cols.flag]) : null;
      rails[filter.rail] = cols.flag ? { state, value, flag } : { state, value };
    }
    return {
      parcelNodeId: String(row.parcel_node_id),
      countyFips: String(row.county_fips),
      rails,
    };
  });
  return {
    countyFips: input.countyFips,
    filters: input.filters,
    matched: {
      count: matched,
      cap: input.cap,
      received: parcels.length,
      truncated: matched > parcels.length,
      parcels,
    },
    excluded: { count: excluded, byRail: exByRail },
    notEvaluated: { count: notEvaluated, byRail: neByRail },
    countyParcels,
    unmeasuredPctByRail,
    countingRule:
      "matched + excluded + notEvaluated = countyParcels, every parcel in exactly one set. byRail counts parcels per rail within its set, so a parcel failing or missing two rails increments two entries and the byRail values sum to more than the set count.",
    projection: {
      builtAt,
      ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : -1,
      stale: !(ageHours <= CONSTRAINT_PROJECTION_STALE_AFTER_HOURS),
      staleAfterHours: CONSTRAINT_PROJECTION_STALE_AFTER_HOURS,
    },
  };
}

export function clampConstraintCap(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return CONSTRAINT_SEARCH_CAP;
  return Math.min(Math.max(Math.floor(raw), 1), CONSTRAINT_SEARCH_MAX_CAP);
}

/* ------------------------------------------------------------------ */
/* Execution. A narrow seam so the SQL runs against a real store in     */
/* production and against a fixture in a test, with no drizzle session. */
/* ------------------------------------------------------------------ */

export interface ConstraintSearchQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * The whole serve path for one constraint search: refuse what must be refused
 * BEFORE touching the store, then one statement, then assemble.
 *
 * `countyFips` is required and there is no statewide path. That is not a
 * limitation dressed as a policy: `landing_parcel_jurisdiction` covers 981,405
 * of roughly 7.6M Texas parcels, so a statewide answer would be mostly
 * not-evaluated and would imply a coverage that does not exist.
 */
export async function runConstraintSearch(input: {
  countyFips: string;
  filters: ConstraintFilter[];
  cap?: number;
  query?: string;
  db: ConstraintSearchQueryable;
  now?: Date;
  unmeasuredRefuseAbovePct: number | null;
}): Promise<ConstraintSearchResult> {
  if (!input.countyFips) {
    return {
      refused: true,
      code: "constraint_bound_missing",
      reason:
        "A geographic bound is required. Give countyFips; there is no statewide constraint search, because incorporation is dispositioned for about 13 percent of Texas parcels and a statewide answer would imply coverage that does not exist.",
    };
  }
  if (!isConstraintSearchCounty(input.countyFips)) {
    return {
      refused: true,
      code: "constraint_county_out_of_scope",
      reason: `County ${input.countyFips} has no constraint index. In scope for v1: ${CONSTRAINT_SEARCH_COUNTIES.join(", ")}. Refusing rather than returning an empty set, which would read as "no parcels match".`,
    };
  }
  if (readsAsSingleAddress(input.query)) {
    return {
      refused: true,
      code: "constraint_single_address",
      reason:
        "That reads as one street address, which is a lookup rather than a constraint search. Use find_parcel for a single address.",
    };
  }
  const invalid = validateFilters(input.filters);
  if (invalid) return invalid;
  const cap = clampConstraintCap(input.cap);
  const { text, params } = buildConstraintSearchSql({
    countyFips: input.countyFips,
    filters: input.filters,
    cap,
  });
  const result = await input.db.query<{
    tally: Record<string, unknown> | null;
    page: Array<Record<string, unknown>>;
  }>(text, params);
  const row = result.rows[0];
  return assembleConstraintSearchResult({
    countyFips: input.countyFips,
    filters: input.filters,
    cap,
    tally: row?.tally ?? null,
    page: row?.page ?? [],
    now: input.now ?? new Date(),
    unmeasuredRefuseAbovePct: input.unmeasuredRefuseAbovePct,
  });
}

/**
 * The operator ruling, read from the environment rather than defaulted.
 * ABSENT MEANS NO GATE, and that is deliberate: a default here would be the
 * silently-picked threshold P-106 item 5 explicitly forbids, and it would be
 * invisible in every response. Unset, the response still carries
 * `unmeasuredPctByRail` on every result, so the coverage is never hidden — it
 * simply does not refuse until a human has ruled on the number.
 */
export function unmeasuredRefuseAbovePctFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.CONSTRAINT_SEARCH_UNMEASURED_REFUSE_ABOVE_PCT?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return parsed;
}
