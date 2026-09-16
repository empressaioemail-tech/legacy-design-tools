import {
  pgTable,
  text,
  jsonb,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Published extraterritorial-jurisdiction (ETJ) ring store — per-publisher
 * ETJ layers (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * ETJ does not exist as a statewide layer the way city limits do. TxGIO
 * City_Boundaries publishes incorporated places only, and the eight sites
 * that serve ETJ in the product today return the literal string
 * `unresolved` because no ETJ geometry has ever been acquired. Each
 * municipality publishes its own ETJ layer on its own ArcGIS host, so this
 * table holds rings acquired one publisher at a time through
 * `@workspace/cad-ingest`'s etj-ingest CLI, keyed by the publishing city.
 *
 * Mirrors `tx_city_boundary`'s column shape (geo-key + name + GeoJSON +
 * per-feature bbox + source bookkeeping) because that shape is the working
 * precedent one file away; the differences are the ones ETJ actually forces:
 *
 *   - the key is `etj_id` = `<city_key>:<publisher object id>`, since rings
 *     are identified by their publisher, never by a statewide place code;
 *   - `ring_label` stores the publisher's own label verbatim
 *     (`AUSTIN 2 MILE ETJ`, `KYLE ETJ`, ...). Nothing here is derived from
 *     a statute: Texas Government Code §42.021 buffers are deliberately NOT
 *     computed, because Austin's real ETJ is shaped by individual
 *     development agreements and disannexation actions a formula contradicts;
 *   - `city_geo_id` carries the CPA place id when the publisher's city can
 *     be joined to `tx_city_boundary` (nullable — the join is informational,
 *     never required, and never invented).
 *
 * A zero-row table is `unresolved` (no ETJ source has been ingested), never
 * "not in the ETJ". `tx_etj_source` carries per-publisher coverage so
 * "checked, no ETJ here" and "no source to check" stay distinguishable.
 */
export const txEtjBoundary = pgTable(
  "tx_etj_boundary",
  {
    /** `<city_key>:<publisher object id>`, e.g. `austin-tx:22`. Primary key. */
    etjId: text("etj_id").notNull(),
    /** Registry key of the publishing city, e.g. `austin-tx`. */
    cityKey: text("city_key").notNull(),
    /** Display name of the publishing city, e.g. `Austin`. */
    cityName: text("city_name").notNull(),
    /** CPA place geo_id when the publisher's city joins to tx_city_boundary. */
    cityGeoId: text("city_geo_id"),
    /** Publisher's own ring label, verbatim, e.g. `AUSTIN 2 MILE ETJ`. */
    ringLabel: text("ring_label").notNull(),
    /** GeoJSON geometry (WGS84). */
    geometry: jsonb("geometry").notNull(),
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    /** Owning organization label as published, e.g. `City of Austin`. */
    source: text("source").notNull(),
    /** Acquisition vintage label recorded at ingest. */
    sourceVintage: text("source_vintage").notNull(),
    /** Canonical service URL citation (layer-specific). */
    sourceCitation: text("source_citation").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.etjId] }),
    bboxIdx: index("tx_etj_boundary_bbox_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
    cityIdx: index("tx_etj_boundary_city_idx").on(t.cityKey),
  }),
);

export type TxEtjBoundaryRow = typeof txEtjBoundary.$inferSelect;
export type TxEtjBoundaryInsert = typeof txEtjBoundary.$inferInsert;
