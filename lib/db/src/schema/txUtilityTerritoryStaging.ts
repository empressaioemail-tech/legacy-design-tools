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
 * L22 utility who-serves staging — schema 0076.
 *
 * Acquisition table `tx_utility_territory_staging` (PUCT water/sewer CCN,
 * HIFLD electric retail, TWDB PWS, TCEQ additive water-districts). P-75
 * promotes it to a serve-time PIP read. Not a rail, cell, or atom source.
 *
 * Table name is pinned to migration
 * `lib/db/drizzle/0076_tx_utility_territory_staging.sql`. Do not query a
 * guessed name. TCEQ rows stay `service_kind=water-district`; they are
 * complementary who-governs and are not remapped to water CCN.
 */
export const TX_UTILITY_TERRITORY_STAGING_TABLE =
  "tx_utility_territory_staging" as const;

export const txUtilityTerritoryStaging = pgTable(
  TX_UTILITY_TERRITORY_STAGING_TABLE,
  {
    stagingRowId: text("staging_row_id").notNull(),
    sourceKey: text("source_key").notNull(),
    serviceKind: text("service_kind").notNull(),
    territoryId: text("territory_id").notNull(),
    territoryName: text("territory_name"),
    countyName: text("county_name"),
    countyFips: text("county_fips"),
    geometry: jsonb("geometry").notNull(),
    geometryCrs: text("geometry_crs").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceLayerId: text("source_layer_id").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    sourceTiers: jsonb("source_tiers").notNull(),
    sourceTierSatisfied: jsonb("source_tier_satisfied").notNull(),
    sourceVintage: text("source_vintage").notNull(),
    sourceCitation: text("source_citation").notNull(),
    passthroughAttributes: jsonb("passthrough_attributes").notNull(),
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    objectId: text("object_id").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.stagingRowId] }),
    sourceIdx: index("tx_utility_territory_staging_source_idx").on(t.sourceKey),
    countyIdx: index("tx_utility_territory_staging_county_idx").on(t.countyFips),
    bboxIdx: index("tx_utility_territory_staging_bbox_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
  }),
);

export type TxUtilityTerritoryStagingRow =
  typeof txUtilityTerritoryStaging.$inferSelect;
export type TxUtilityTerritoryStagingInsert =
  typeof txUtilityTerritoryStaging.$inferInsert;
