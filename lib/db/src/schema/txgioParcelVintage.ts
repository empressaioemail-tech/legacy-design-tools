import {
  pgTable,
  text,
  integer,
  jsonb,
  doublePrecision,
  numeric,
  timestamp,
  primaryKey,
  index,
  customType,
} from "drizzle-orm/pg-core";

/** PostGIS `geometry(Geometry,4326)`, same untyped declaration as `txgio_parcel.geom`. */
const geometryColumn = customType<{ data: string; default: false }>({
  dataType() {
    return "geometry(Geometry,4326)";
  },
});

/**
 * Parcel HISTORY: one row per (county, StratMap vintage, source feature),
 * from the TxGIO Land Parcels program's annual releases (stratmap19, 21-26).
 * Lets the ledger answer "what was this parcel in 2022" from the record
 * published that year: owner, situs, legal description, CAD values, the
 * roll's own tax year, year built, and the polygon.
 *
 * Append-only by construction. `txgio_parcel` holds ONE current vintage and
 * is replaced on reload; this table is never replaced or updated. A
 * re-load of a vintage that is already present inserts nothing
 * (ON CONFLICT DO NOTHING), so a vintage, once loaded, is exactly what was
 * published. Unlike `txgio_parcel` it is one row per feature, not per grid
 * cell: history is read by parcel id, never by map tile.
 *
 * `vintage_year` is the program year from the label (stratmap22 -> 2022).
 * `tax_year` is the CAD roll year the release carried (TAX_YEAR), which can
 * differ from the program year; both are kept and neither is inferred.
 * Values are numeric as published, NULL when the release leaves them blank.
 */
export const txgioParcelVintage = pgTable(
  "txgio_parcel_vintage",
  {
    countyFips: text("county_fips").notNull(),
    sourceVintage: text("source_vintage").notNull(),
    vintageYear: integer("vintage_year").notNull(),
    featureIndex: integer("feature_index").notNull(),
    propId: text("prop_id"),
    geoId: text("geo_id"),
    ownerName: text("owner_name"),
    situsAddress: text("situs_address"),
    situsCity: text("situs_city"),
    situsState: text("situs_state"),
    situsZip: text("situs_zip"),
    legalDesc: text("legal_desc"),
    landValue: numeric("land_value"),
    impValue: numeric("imp_value"),
    mktValue: numeric("mkt_value"),
    taxYear: integer("tax_year"),
    yearBuilt: integer("year_built"),
    geometry: jsonb("geometry").notNull(),
    geom: geometryColumn("geom"),
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    sourceFile: text("source_file").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.sourceVintage, t.featureIndex] }),
    propYearIdx: index("txgio_parcel_vintage_prop_year_idx").on(t.countyFips, t.propId, t.vintageYear),
  }),
);

export type TxgioParcelVintageRow = typeof txgioParcelVintage.$inferSelect;
export type TxgioParcelVintageInsert = typeof txgioParcelVintage.$inferInsert;
