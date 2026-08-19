/**
 * The STATEWIDE SERVING SWEEP record, as cortex-api validates and serves it.
 *
 * The type half of this file is a mirror of the record FROZEN by the planner
 * on 2026-08-18 at doc_repo `_catalog/parcel_fact_sheet_contract/serving-sweep.ts`.
 * Command Center carries the same mirror at
 * `apps/command-center/src/admin/control/panels/servingSweepTypes.ts`. Three
 * copies of one frozen shape is the divergence risk this file is most exposed
 * to, so the validator below is written to reject anything the console's own
 * parser would flag as a problem: whatever this endpoint serves must parse
 * cleanly there, or the pipe is worse than no pipe.
 *
 * A change to any shape goes back to the planner. It is not negotiated here.
 *
 * WHY VALIDATE AT INGEST RATHER THAN AT READ. An unvalidated blob that lands
 * in the store is served to a human later, by which time the producer's run is
 * gone and there is nothing to compare against. Rejecting at the door with the
 * problem's path is the only point at which the producer can still act on it.
 */
import { z } from "zod/v4";
import { TEXAS_COUNTY_COUNT } from "@workspace/db/manifest";

export const FIELD_KEYS = [
  "geometry",
  "situsAddress",
  "apn",
  "landUse",
  "zoning",
  "setbacks",
  "envelope",
  "flood",
  "frontage",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const CONTRADICTION_KINDS = [
  "envelope-not-derived-but-area-shown",
  "flood-zone-disagreement",
  "field-unavailable-but-present-upstream",
  "address-absent-but-on-cad-roll",
  "setbacks-present-card-absent-brief",
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/**
 * Tally of Fact states across every parcel in the county for one field.
 * `unresolved` is lookup FAILURE and is a fourth measured class — never
 * folded into an absence (CONTRACT_RULES I4).
 */
export interface FieldTally {
  present: number;
  absentCovered: number;
  absentUncovered: number;
  unresolved: number;
}

export interface ContradictionTally {
  kind: ContradictionKind;
  count: number;
  exampleParcelNodeIds: string[];
}

export interface AbsenceCluster {
  field: FieldKey;
  label: string;
  parcelCount: number;
  bbox: [number, number, number, number];
}

export interface CountyServingSweep {
  countyFips: string;
  countyName: string;
  sweptAt: string;
  resolverVersion: string;
  parcelsTotal: number;
  parcelsUnresolvable: number;
  fields: Record<FieldKey, FieldTally>;
  singleFamily: { parcelsTotal: number; fields: Record<FieldKey, FieldTally> };
  contradictions: ContradictionTally[];
  multiZoneFloodParcels: number;
  absenceClusters: AbsenceCluster[];
  sourcesByField: Partial<
    Record<FieldKey, { source: string; vintage: string | null }>
  >;
}

export interface StatewideServingSweep {
  sweptAt: string;
  resolverVersion: string;
  countiesTotal: number;
  countiesSwept: number;
  parcelsTotal: number;
  counties: CountyServingSweep[];
}

// -- Validation ---------------------------------------------------------------

const nonNegInt = z.number().int().nonnegative();

const FieldTallySchema = z.strictObject({
  present: nonNegInt,
  absentCovered: nonNegInt,
  absentUncovered: nonNegInt,
  unresolved: nonNegInt,
});

/**
 * Written out key by key rather than generated from FIELD_KEYS so a missing
 * field and an unknown field are BOTH loud: the frozen record requires every
 * FieldKey, and a tenth key is a shape change that must reach the planner
 * rather than land silently in a store.
 */
const FieldsSchema = z.strictObject({
  geometry: FieldTallySchema,
  situsAddress: FieldTallySchema,
  apn: FieldTallySchema,
  landUse: FieldTallySchema,
  zoning: FieldTallySchema,
  setbacks: FieldTallySchema,
  envelope: FieldTallySchema,
  flood: FieldTallySchema,
  frontage: FieldTallySchema,
});

const SourceEntrySchema = z.strictObject({
  source: z.string().min(1),
  vintage: z.string().nullable(),
});

const SourcesByFieldSchema = z.strictObject({
  geometry: SourceEntrySchema.optional(),
  situsAddress: SourceEntrySchema.optional(),
  apn: SourceEntrySchema.optional(),
  landUse: SourceEntrySchema.optional(),
  zoning: SourceEntrySchema.optional(),
  setbacks: SourceEntrySchema.optional(),
  envelope: SourceEntrySchema.optional(),
  flood: SourceEntrySchema.optional(),
  frontage: SourceEntrySchema.optional(),
});

/**
 * An ISO-8601-parseable instant. It lands in a timestamptz column, so an
 * unparseable string would otherwise be a write failure at ingest time
 * rather than a named 400 the producer can act on.
 */
const InstantSchema = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "expected an ISO-8601 timestamp",
  });

const ContradictionSchema = z.strictObject({
  kind: z.enum(CONTRADICTION_KINDS),
  count: nonNegInt,
  /**
   * The frozen record says "up to 20 parcel node ids", and the console flags
   * a longer list as a problem. Rejected here rather than served.
   */
  exampleParcelNodeIds: z.array(z.string().min(1)).max(20),
});

const AbsenceClusterSchema = z.strictObject({
  field: z.enum(FIELD_KEYS),
  label: z.string(),
  parcelCount: nonNegInt,
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

export const CountyServingSweepSchema = z.strictObject({
  countyFips: z.string().regex(/^\d{5}$/, "expected a 5-digit county FIPS"),
  countyName: z.string().min(1),
  sweptAt: InstantSchema,
  resolverVersion: z.string().min(1),
  parcelsTotal: nonNegInt,
  parcelsUnresolvable: nonNegInt,
  fields: FieldsSchema,
  singleFamily: z.strictObject({
    parcelsTotal: nonNegInt,
    fields: FieldsSchema,
  }),
  contradictions: z.array(ContradictionSchema),
  multiZoneFloodParcels: nonNegInt,
  absenceClusters: z.array(AbsenceClusterSchema),
  sourcesByField: SourcesByFieldSchema,
});

export const StatewideServingSweepSchema = z.strictObject({
  sweptAt: InstantSchema,
  resolverVersion: z.string().min(1),
  countiesTotal: nonNegInt,
  countiesSwept: nonNegInt,
  parcelsTotal: nonNegInt,
  counties: z.array(CountyServingSweepSchema),
});

export interface SweepParseResult {
  ok: boolean;
  counties: CountyServingSweep[];
  /** Every problem found, by path. Never empty when ok is false. */
  problems: string[];
  /** Which of the two accepted body shapes was read. */
  shape: "county" | "statewide" | "unrecognized";
}

function issuesToProblems(err: z.ZodError, prefix: string): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length
      ? prefix + "." + issue.path.join(".")
      : prefix;
    return path + ": " + issue.message;
  });
}

/**
 * Read an ingest body that is EITHER one CountyServingSweep or a whole
 * StatewideServingSweep, and return the county records it carries.
 *
 * The two shapes are told apart by the presence of `counties`, not by
 * guessing: a body carrying a `counties` key is read as statewide and a body
 * without one is read as a county. A body that is neither is reported as
 * `unrecognized` with a named reason rather than accepted as empty — an
 * empty result is not an absence.
 */
export function parseServingSweepIngestBody(raw: unknown): SweepParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      counties: [],
      problems: [
        "root: expected a CountyServingSweep or StatewideServingSweep object",
      ],
      shape: "unrecognized",
    };
  }
  const hasCounties = Object.prototype.hasOwnProperty.call(raw, "counties");
  if (hasCounties) {
    const parsed = StatewideServingSweepSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        counties: [],
        problems: issuesToProblems(parsed.error, "root"),
        shape: "statewide",
      };
    }
    const problems: string[] = [];
    // Two numbers that should agree and do not is a free finding
    // (DEV_PROCESS 1.4). It is reported, never rounded off.
    if (parsed.data.countiesSwept !== parsed.data.counties.length) {
      problems.push(
        "root.countiesSwept: says " +
          String(parsed.data.countiesSwept) +
          " but counties[] carries " +
          String(parsed.data.counties.length),
      );
    }
    const fipsSeen = new Set<string>();
    for (const county of parsed.data.counties) {
      if (fipsSeen.has(county.countyFips)) {
        problems.push(
          "root.counties: countyFips " +
            county.countyFips +
            " appears more than once",
        );
      }
      fipsSeen.add(county.countyFips);
    }
    if (problems.length > 0) {
      return { ok: false, counties: [], problems, shape: "statewide" };
    }
    return {
      ok: true,
      counties: parsed.data.counties as CountyServingSweep[],
      problems: [],
      shape: "statewide",
    };
  }
  const parsed = CountyServingSweepSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      counties: [],
      problems: issuesToProblems(parsed.error, "root"),
      shape: "county",
    };
  }
  return {
    ok: true,
    counties: [parsed.data as CountyServingSweep],
    problems: [],
    shape: "county",
  };
}

// -- Statewide assembly -------------------------------------------------------

export interface StoredCountySweep {
  countyFips: string;
  payload: CountyServingSweep;
}

/**
 * Assemble the served StatewideServingSweep from the county rows that exist.
 *
 * Every scalar here carries its counting rule, because each one is a place
 * where a plausible-looking number could be invented:
 *
 *   sweptAt         the MOST RECENT county sweep in this assembly. The
 *                   envelope must never claim a freshness newer than any
 *                   sweep it contains, so the read time is NOT used (it goes
 *                   in the X-Sweep-Assembled-At response header instead,
 *                   which leaves the frozen shape untouched).
 *   resolverVersion the single version when every county agrees; otherwise
 *                   "mixed: a | b", never one county's version standing for
 *                   all of them.
 *   countiesTotal   254, the Texas county count (TEXAS_COUNTY_COUNT). A
 *                   denominator about Texas, not about our data.
 *   countiesSwept   MEASURED as counties.length, never a stored claim. The
 *                   console cross-checks these two and a stored value could
 *                   drift away from the array actually served.
 *   parcelsTotal    SUM of parcelsTotal over the SWEPT counties only. It is
 *                   not a statewide parcel count and must not be read as one.
 */
export function assembleStatewideSweep(
  rows: readonly StoredCountySweep[],
): StatewideServingSweep {
  const counties = [...rows]
    .sort((a, b) => a.countyFips.localeCompare(b.countyFips))
    .map((r) => r.payload);

  const sweptAtMs = counties
    .map((c) => Date.parse(c.sweptAt))
    .filter((n) => !Number.isNaN(n));
  const sweptAt =
    sweptAtMs.length > 0 ? new Date(Math.max(...sweptAtMs)).toISOString() : "";

  const versions = Array.from(new Set(counties.map((c) => c.resolverVersion)));
  const resolverVersion =
    versions.length === 1
      ? versions[0]
      : versions.length === 0
        ? ""
        : "mixed: " + versions.join(" | ");

  return {
    sweptAt,
    resolverVersion,
    countiesTotal: TEXAS_COUNTY_COUNT,
    countiesSwept: counties.length,
    parcelsTotal: counties.reduce((sum, c) => sum + c.parcelsTotal, 0),
    counties,
  };
}
