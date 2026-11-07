import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-publisher ETJ source register — one row per enumerated city
 * (feat/p241-etj-acquisition, P-241 acquisition half).
 *
 * ETJ coverage is per municipality, not statewide, so a point outside every
 * ingested ring has two very different meanings:
 *
 *   - the point lies inside a publisher's own published ETJ extent and no
 *     ring contains it -> `absent` (checked, and the ETJ really does not
 *     reach here);
 *   - the point lies outside every source's published extent, or its city
 *     publishes no ETJ layer at all -> `unresolved` (there is no source to
 *     check), which is the honest answer and is NOT a confirmed absence.
 *
 * Only the publishers' own statements can separate those two, so this table
 * stores them: `extent_*` is the layer's own published extent read at ingest
 * with `returnExtentOnly=true&outSR=4326` (these publishers return layer
 * metadata extents in their own projected SR — 102739, 102740, 102100,
 * 102383, 103160 all appear across the registry — so the extent is requested
 * in WGS84 rather than converted by hand).
 *
 * `mode` is the enumeration outcome for the city, verbatim from the
 * registry: `combined` (ETJ and city limits in one layer, separated by an
 * attribute value), `etj_layer` (the layer is ETJ only), or
 * `city_limits_only` (enumerated and searched, publisher exposes city
 * limits and no ETJ layer). A `city_limits_only` row is what makes
 * "this city publishes no ETJ" checkable rather than assumed; it is the
 * difference between the Round Rock case and a city never looked at.
 */
export const txEtjSource = pgTable(
  "tx_etj_source",
  {
    /** Registry key, e.g. `austin-tx`. Primary key. */
    cityKey: text("city_key").notNull(),
    /** Display name, e.g. `Austin`. */
    cityName: text("city_name").notNull(),
    /** CPA place geo_id when known (informational join to tx_city_boundary). */
    cityGeoId: text("city_geo_id"),
    /** `combined` | `etj_layer` | `city_limits_only`. */
    mode: text("mode").notNull(),
    /** The layer URL queried for this city's ETJ rings (null: no layer). */
    layerUrl: text("layer_url"),
    /** The publisher's own layer name, verbatim. */
    layerName: text("layer_name"),
    /** True when this published source yields ETJ rings. */
    hasEtjRings: boolean("has_etj_rings").notNull(),
    /** Extent of the published rings in WGS84 (null: no layer / unreadable). */
    westLng: doublePrecision("west_lng"),
    southLat: doublePrecision("south_lat"),
    eastLng: doublePrecision("east_lng"),
    northLat: doublePrecision("north_lat"),
    /** ETJ rings this source contributed at ingest (0 for city_limits_only). */
    etjRingCount: integer("etj_ring_count").notNull().default(0),
    /** Publisher's last edit timestamp when the layer publishes one. */
    layerLastEditAt: timestamp("layer_last_edit_at", { withTimezone: true }),
    /** Acquisition vintage label recorded at ingest. */
    sourceVintage: text("source_vintage").notNull(),
    /** Canonical service URL citation (layer-specific). */
    sourceCitation: text("source_citation").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.cityKey] }),
    extentIdx: index("tx_etj_source_extent_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
  }),
);

export type TxEtjSourceRow = typeof txEtjSource.$inferSelect;
export type TxEtjSourceInsert = typeof txEtjSource.$inferInsert;
