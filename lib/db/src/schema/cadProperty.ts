import {
  pgTable,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * County appraisal-district (CAD) property-attribute store.
 *
 * Provider-neutral rows loaded from free CAD bulk exports (PACS 8.0.x
 * fixed-width appraisal exports for Travis/Bastrop/Caldwell, Tyler Orion
 * PropertyDataExport CSVs for Hays, and the WCAD Socrata portal for
 * Williamson). Loaded by the `@workspace/cad-ingest` batch CLI; consumed
 * by follow-up Property Brief slot adapters (owner, mailing address,
 * situs, exemptions, improvements, values).
 *
 * Keyed (county_fips, prop_id, tax_year):
 *  - `county_fips` is the 5-digit county FIPS (e.g. `48453` Travis) so
 *    prop_ids from different CADs never collide.
 *  - `prop_id` is the CAD's own property id, normalized to a decimal
 *    string with leading zeros stripped (PACS pads to 12).
 *  - `tax_year` is the appraisal year the row describes; re-ingesting a
 *    fresher export for the same year upserts in place (idempotent), a
 *    new year adds rows alongside the old ones.
 *
 * Values are whole dollars (bigint). `land_acres` keeps the CAD's 4
 * implied decimals. `exemption_codes` carries normalized short codes
 * (HS, OV65, DV1, EX, ...). `source_file` + `source_vintage` say which
 * export drop a row came from; `ingested_at` is bumped on every upsert.
 *
 * Privacy: CADs redact Tax Code §25.025 confidential-address records
 * upstream; no extra filtering is applied here.
 */
export const cadProperty = pgTable(
  "cad_property",
  {
    /** 5-digit county FIPS, e.g. `48453` (Travis). */
    countyFips: text("county_fips").notNull(),
    /** CAD property id, leading zeros stripped (e.g. `10001`). */
    propId: text("prop_id").notNull(),
    /** Appraisal / tax year the row describes. */
    taxYear: integer("tax_year").notNull(),
    ownerName: text("owner_name"),
    /** Single normalized mailing-address line (street, city, state, zip). */
    ownerMailingAddress: text("owner_mailing_address"),
    /** Single situs line (number, street, suffix, unit). */
    situsAddress: text("situs_address"),
    situsCity: text("situs_city"),
    situsZip: text("situs_zip"),
    legalDescription: text("legal_description"),
    /** Normalized exemption short codes, e.g. `{HS,OV65}`. */
    exemptionCodes: text("exemption_codes").array(),
    /** Whole dollars. Land market incl. ag/timber market components. */
    landValue: bigint("land_value", { mode: "number" }),
    improvementValue: bigint("improvement_value", { mode: "number" }),
    marketValue: bigint("market_value", { mode: "number" }),
    /** Appraised minus HS cap. */
    assessedValue: bigint("assessed_value", { mode: "number" }),
    /** Year built of the main living area, when improvement data present. */
    yearBuilt: integer("year_built"),
    /** Sum of main-living-area improvement segments, sqft. */
    livingAreaSqft: integer("living_area_sqft"),
    landAcres: numeric("land_acres", { precision: 14, scale: 4 }),
    /** CAD/PTAD state or use code (e.g. `A1`, `E`), when the export has one. */
    propertyUseCode: text("property_use_code"),
    /** Basename of the export file the row was parsed from. */
    sourceFile: text("source_file").notNull(),
    /** Export drop label, e.g. `2026-preliminary-supp0`. */
    sourceVintage: text("source_vintage").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.propId, t.taxYear] }),
  }),
);

export type CadPropertyRow = typeof cadProperty.$inferSelect;
export type CadPropertyInsert = typeof cadProperty.$inferInsert;
