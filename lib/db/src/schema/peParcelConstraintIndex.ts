import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  numeric,
  timestamp,
  uuid,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";

/**
 * The five rail-state words, frozen here and in migration 0094's CHECK
 * constraints. They are `SMART_SITE_RAIL_STATES` in
 * `artifacts/api-server/src/lib/smartSiteStub.ts`; lib/db cannot import from
 * artifacts, so the list is repeated once, in one place, next to the
 * constraint that enforces it. `parcelConstraintProjection.ts` imports the
 * artifacts-side constant, and a test pins the two lists identical, which is
 * the divergence test for the one rule with two implementations.
 */
export const PARCEL_CONSTRAINT_RAIL_STATE_SQL =
  "('present','absent-verified','unknown','refused','unread')";

/** A rail's state column must carry one of the five words and nothing else. */
function stateCheck(name: string, column: string) {
  return check(name, sql.raw(`${column} IN ${PARCEL_CONSTRAINT_RAIL_STATE_SQL}`));
}

/**
 * A value exists if and only if the state is `present`. BOTH directions,
 * deliberately: left-to-right refuses a value smuggled in under an unmeasured
 * state, right-to-left refuses a `present` with nothing behind it.
 */
function valueStateCheck(name: string, valueColumn: string, stateColumn: string) {
  return check(
    name,
    sql.raw(`(${valueColumn} IS NOT NULL) = (${stateColumn} = 'present')`),
  );
}

/**
 * P-106 parcel constraint index: the filterable projection of already-baked
 * facets, one row per parcel per county in scope.
 *
 * It is a CACHE. `builtAt` is when the row was projected; `bakeSnapshotAt` is
 * the `place_layer_snapshots.snapshot_at` of the tier-1 row it was projected
 * from. Both are kept because reporting the first as the freshness of the
 * facts would be wrong by exactly the distance between them, and a stale
 * projection served as current is the defect this table's own card names.
 *
 * EVERY RAIL IS A PAIR: a nullable value and a NOT NULL state. The state
 * words are `SMART_SITE_RAIL_STATES` from
 * `artifacts/api-server/src/lib/smartSiteStub.ts`, the same five
 * `get_smart_site` publishes. The store enforces "a value exists if and only
 * if the state is present" in DDL (see migration 0094), in both directions,
 * so no writer that skips the TypeScript can smuggle a value in under an
 * unmeasured state or assert a `present` with nothing behind it.
 *
 * `etj` is declared ahead and has no source in this store as of 2026-09-02.
 * Its state is `unread` on every row and every filter over it is refused.
 */
export const peParcelConstraintIndex = pgTable(
  "pe_parcel_constraint_index",
  {
    countyFips: text("county_fips").notNull(),
    propId: text("prop_id").notNull(),
    parcelNodeId: text("parcel_node_id").notNull(),

    /** When THIS row was projected. */
    builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
    /** The bake snapshot the row was projected from. */
    bakeSnapshotAt: timestamp("bake_snapshot_at", { withTimezone: true }),
    /** Joins to pe_parcel_constraint_index_builds. */
    buildRunId: uuid("build_run_id").notNull(),

    acreageAcres: numeric("acreage_acres", { precision: 14, scale: 4 }),
    acreageState: text("acreage_state").notNull(),

    landUseCode: text("land_use_code"),
    landUseState: text("land_use_state").notNull(),

    /** `in-city` or `unincorporated`; `unresolved` is a refusal, not a place. */
    cityLimits: text("city_limits"),
    cityLimitsState: text("city_limits_state").notNull(),

    etj: text("etj"),
    etjState: text("etj_state").notNull(),

    zoningDistrict: text("zoning_district"),
    zoningState: text("zoning_state").notNull(),

    floodZone: text("flood_zone"),
    /** The determination. `present` means this is non-null, not floodZone. */
    floodInSfha: boolean("flood_in_sfha"),
    floodState: text("flood_state").notNull(),

    specialDistrictId: text("special_district_id"),
    specialDistrictState: text("special_district_state").notNull(),

    marketValue: bigint("market_value", { mode: "number" }),
    marketValueState: text("market_value_state").notNull(),

    landValue: bigint("land_value", { mode: "number" }),
    landValueState: text("land_value_state").notNull(),

    improvementValue: bigint("improvement_value", { mode: "number" }),
    improvementValueState: text("improvement_value_state").notNull(),

    yearBuilt: integer("year_built"),
    yearBuiltState: text("year_built_state").notNull(),
  },
  (table) => [
    primaryKey({
      name: "pe_parcel_constraint_index_pk",
      columns: [table.countyFips, table.propId],
    }),
    index("pe_pci_county_idx").on(table.countyFips),
    index("pe_pci_county_acreage_idx").on(
      table.countyFips,
      table.acreageState,
      table.acreageAcres,
    ),
    index("pe_pci_county_flood_idx").on(
      table.countyFips,
      table.floodState,
      table.floodInSfha,
    ),
    stateCheck("pe_pci_acreage_state_chk", "acreage_state"),
    stateCheck("pe_pci_land_use_state_chk", "land_use_state"),
    stateCheck("pe_pci_city_limits_state_chk", "city_limits_state"),
    stateCheck("pe_pci_etj_state_chk", "etj_state"),
    stateCheck("pe_pci_zoning_state_chk", "zoning_state"),
    stateCheck("pe_pci_flood_state_chk", "flood_state"),
    stateCheck("pe_pci_special_district_state_chk", "special_district_state"),
    stateCheck("pe_pci_market_value_state_chk", "market_value_state"),
    stateCheck("pe_pci_land_value_state_chk", "land_value_state"),
    stateCheck("pe_pci_improvement_value_state_chk", "improvement_value_state"),
    stateCheck("pe_pci_year_built_state_chk", "year_built_state"),
    valueStateCheck("pe_pci_acreage_value_state_chk", "acreage_acres", "acreage_state"),
    valueStateCheck("pe_pci_land_use_value_state_chk", "land_use_code", "land_use_state"),
    valueStateCheck("pe_pci_city_limits_value_state_chk", "city_limits", "city_limits_state"),
    valueStateCheck("pe_pci_etj_value_state_chk", "etj", "etj_state"),
    valueStateCheck("pe_pci_zoning_value_state_chk", "zoning_district", "zoning_state"),
    valueStateCheck(
      "pe_pci_special_district_value_state_chk",
      "special_district_id",
      "special_district_state",
    ),
    valueStateCheck("pe_pci_market_value_value_state_chk", "market_value", "market_value_state"),
    valueStateCheck("pe_pci_land_value_value_state_chk", "land_value", "land_value_state"),
    valueStateCheck(
      "pe_pci_improvement_value_value_state_chk",
      "improvement_value",
      "improvement_value_state",
    ),
    valueStateCheck("pe_pci_year_built_value_state_chk", "year_built", "year_built_state"),
    /**
     * Flood's determination is the BOOLEAN, not the zone letter:
     * `floodHazardFactRead`'s present shape allows a null `floodZone` under a
     * non-null `inSpecialFloodHazardArea`, so the flag is what `present` means
     * here and the letter is free to be absent under it.
     */
    check(
      "pe_pci_flood_value_state_chk",
      sql.raw("(flood_in_sfha IS NOT NULL) = (flood_state = 'present')"),
    ),
    check(
      "pe_pci_flood_zone_needs_flag_chk",
      sql.raw("flood_zone IS NULL OR flood_in_sfha IS NOT NULL"),
    ),
    /**
     * `unresolved` is NOT a place. The jurisdiction run looking at a parcel and
     * failing to place it is a refusal, carried in the state column.
     */
    check(
      "pe_pci_city_limits_grammar_chk",
      sql.raw("city_limits IS NULL OR city_limits IN ('in-city','unincorporated')"),
    ),
    check("pe_pci_county_fips_chk", sql.raw("county_fips ~ '^[0-9]{5}$'")),
    /**
     * `prop_id` `0` is the live degenerate key: `48021:0` carries a `", ,"`
     * situs and a bake row and is not a parcel. Refused for the same reason
     * `landing_parcel_jurisdiction` refuses it.
     */
    check("pe_pci_prop_id_chk", sql.raw("btrim(prop_id) <> '' AND prop_id <> '0'")),
    check(
      "pe_pci_node_id_shape_chk",
      sql.raw("parcel_node_id = county_fips || ':' || prop_id"),
    ),
  ],
);

/**
 * The build ledger. A build that cannot write its row does not run: a count is
 * not a record, and a refusal that leaves no name is how an unattributed
 * mutation becomes unanswerable. `propIdLo` / `propIdHi` are the scope actually
 * walked, which is what "the items acted on" means for half a million rows.
 */
export const peParcelConstraintIndexBuilds = pgTable(
  "pe_parcel_constraint_index_builds",
  {
    buildRunId: uuid("build_run_id").primaryKey(),
    countyFips: text("county_fips").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** The command that produced this build, verbatim. */
    invocation: text("invocation").notNull(),
    propIdLo: text("prop_id_lo"),
    propIdHi: text("prop_id_hi"),
    bakeRowsRead: bigint("bake_rows_read", { mode: "number" }),
    rowsWritten: bigint("rows_written", { mode: "number" }),
    bakeSnapshotMax: timestamp("bake_snapshot_max", { withTimezone: true }),
    /** `started` | `succeeded` | `failed` | `refused`. */
    outcome: text("outcome").notNull(),
    /** Required when outcome is `refused`; enforced in DDL. */
    refusalReason: text("refusal_reason"),
  },
  (table) => [
    index("pe_pci_builds_county_started_idx").on(
      table.countyFips,
      table.startedAt,
    ),
    check(
      "pe_pci_builds_outcome_chk",
      sql.raw("outcome IN ('started','succeeded','failed','refused')"),
    ),
    /**
     * A refusal without a reason is how an unattributed mutation becomes
     * unanswerable. Refusals are recorded the same way successes are.
     */
    check(
      "pe_pci_builds_refusal_chk",
      sql.raw("outcome <> 'refused' OR btrim(coalesce(refusal_reason,'')) <> ''"),
    ),
  ],
);
