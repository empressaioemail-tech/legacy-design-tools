import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";

/** Same declaration as `sourceFeature.ts`'s `geometryColumn` -- see that file's comment. */
const geometryColumn = customType<{ data: string; default: false }>({
  dataType() {
    return "geometry(Geometry,4326)";
  },
});

/**
 * The staging half of the stage-check-swap write path for `source_feature`
 * (P-499, OPS-16 A-382/A-383; design section 3; migration
 * `0111_source_feature.sql`, which carries the full rationale).
 *
 * Same columns as `source_feature` (`sourceFeature.ts`), with
 * `load_run_id` folded into the primary key so several runs can stage
 * side by side without colliding. A load writes here first; the live
 * table is untouched while it loads. Gate 1 (factory) checks the staged
 * row count against the registry's expected count; only on a pass does
 * `swapStagedCounty()` (`lib/db/src/sourceFeatureSwap.ts`) delete the
 * live (provider, county) rows, insert this run's staged rows into
 * `source_feature`, and delete this run's rows from this table. A
 * refused swap leaves the staged rows here for diagnosis and the live
 * county untouched.
 *
 * Deliberately NOT partitioned (migration 0111's header explains why):
 * every read of this table is scoped to (provider, county_fips,
 * load_run_id), which is exactly this table's own primary-key prefix, so
 * a plain table with no partitioning serves that scan with no pruning
 * needed. The primary key column order is chosen for the same reason --
 * `provider`, `county_fips`, `load_run_id` are the leading three columns,
 * ahead of `provider_object_id`, so the scoped query is a PK-prefix index
 * scan and no secondary index exists on this table.
 */
export const sourceFeatureStage = pgTable(
  "source_feature_stage",
  {
    provider: text("provider").notNull(),
    providerObjectId: text("provider_object_id").notNull(),
    stateFips: text("state_fips").notNull(),
    countyFips: text("county_fips").notNull(),
    vintage: text("vintage").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    loadRunId: text("load_run_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    geom: geometryColumn("geom"),
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.provider, t.countyFips, t.loadRunId, t.providerObjectId],
    }),
  }),
);

export type SourceFeatureStageRow = typeof sourceFeatureStage.$inferSelect;
export type SourceFeatureStageInsert = typeof sourceFeatureStage.$inferInsert;
