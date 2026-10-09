import {
  pgTable,
  text,
  timestamp,
  jsonb,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";

/**
 * PostGIS `geometry(Geometry,4326)` -- drizzle-orm/pg-core has no built-in
 * geometry type. Same declaration as `txgioParcel.ts`'s `geometryColumn`
 * (duplicated rather than shared, matching this schema directory's
 * existing per-file convention -- see also `sheets.ts`,
 * `deliverableLetterRenders.ts`). Untyped at the TS level; every consumer
 * goes through raw SQL (the swap in `lib/db/src/sourceFeatureSwap.ts`
 * copies it column-for-column and never decodes it in JS).
 */
const geometryColumn = customType<{ data: string; default: false }>({
  dataType() {
    return "geometry(Geometry,4326)";
  },
});

/**
 * One national source-table shape, keyed on the provider's own id
 * (P-499, OPS-16 A-382/A-383; design
 * `_design/2026-10-09_P-499_source_shape_and_address_from_record.md`
 * section 3; migration `0111_source_feature.sql`, which carries the full
 * rationale -- read that header before this one).
 *
 * `provider` is a `lib/source-registry` key (e.g.
 * `txgio.address-points`), never a state name: Texas is a column value,
 * not a table-name prefix. LIST-partitioned on `provider` at the SQL
 * level (migration 0111) -- drizzle-orm has no declarative partition
 * support, so this `pgTable` only describes the shape every partition
 * shares; the actual `PARTITION BY LIST` and per-partition indexes live
 * in SQL (migration 0111's header, and `lib/source-registry`'s
 * `partitionDdlForProvider()` for the partitions a later card adds).
 *
 * `provider_object_id` is TEXT (not integer) so a non-numeric provider id
 * fits, and is the provider's OWN id, scoped to (provider, county_fips) --
 * never compared bare across counties or providers (the same lesson
 * migration 0110 learned for `txgio_address.object_id`). A provider with
 * no usable id registers a DECLARED key rule in the registry instead
 * (content-derived, never positional, never a bigserial); this column
 * still holds that declared value as text either way.
 *
 * `geom` is nullable: non-spatial providers (permit/attribute-only
 * layers) never populate it. `payload` carries the provider's attributes
 * verbatim -- no renaming or dropping at this layer; typed access happens
 * in the derived rails/indexes that read this table (design section 3,
 * "Cost"), not here.
 *
 * Write semantics are stage-check-swap, never delete-then-insert --
 * see `source_feature_stage` (`sourceFeatureStage.ts`) and
 * `swapStagedCounty()` (`lib/db/src/sourceFeatureSwap.ts`).
 */
export const sourceFeature = pgTable(
  "source_feature",
  {
    /** Registry key, e.g. `txgio.address-points`. Partition key. */
    provider: text("provider").notNull(),
    /** The provider's own feature id, as text; scoped to (provider, county_fips). */
    providerObjectId: text("provider_object_id").notNull(),
    /** National 2-digit state FIPS, e.g. `48` (Texas). */
    stateFips: text("state_fips").notNull(),
    /** National 5-digit county FIPS, e.g. `48053` (Burnet). */
    countyFips: text("county_fips").notNull(),
    /** The provider's own vintage label, verbatim. */
    vintage: text("vintage").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Cluster Job name / run id. Ties every row to the run that wrote it. */
    loadRunId: text("load_run_id").notNull(),
    /** The layer or file this row came from. */
    sourceUrl: text("source_url").notNull(),
    /** Nullable: non-spatial providers never populate this. */
    geom: geometryColumn("geom"),
    /** The provider's attributes, verbatim. No renaming or dropping here. */
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.countyFips, t.providerObjectId] }),
  }),
);

export type SourceFeatureRow = typeof sourceFeature.$inferSelect;
export type SourceFeatureInsert = typeof sourceFeature.$inferInsert;
