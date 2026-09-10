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
    //
    // DECLARED LAST, ON PURPOSE. The test schema fixture
    // (lib/db/src/__tests__/__fixtures__/schema.sql.template) is a pg_dump of
    // what `drizzle-kit push` builds from THIS file, and CI diffs it. A fresh
    // push emits columns in declaration order while migration 0099's
    // `ALTER TABLE ... ADD COLUMN` appends them to the live table. Declaring
    // them last is what makes those two orders identical, so the fixture
    // describes the real production table rather than only the CI one.
    /**
     * The CAD's OTHER two published identifiers for the same account, when
     * the export carries them (P-124 CTX-HAYS-REBIND, 2026-09-10).
     *
     * EVIDENCE, NOT KEYS. The primary key stays
     * (county_fips, prop_id, tax_year) so no existing consumer moves.
     *
     * Tyler Orion publishes three ids per account in adjacent columns:
     * `PropertyID` (what `prop_id` above holds), `QuickRefID` (the R/P/M/N
     * account number, e.g. `R26199`) and `PropertyNumber` (the county's
     * Geographic ID, e.g. `11-2520-0000-03100-2`). Until this column existed
     * the parser read the first and dropped the other two, and the program
     * had no way to say that Hays CAD account 40138 and TxGIO parcel 26199
     * are the SAME parcel -- because TxGIO publishes Hays parcels under the
     * QuickRefID number with the R stripped at source, into the same
     * bare-numeric space PropertyID occupies. That collision is why 30,862
     * Hays parcel nodes draw another parcel's polygon today.
     *
     * `propertyNumber` is the join key to `txgio_parcel.geo_id`;
     * `quickRefId` is the SECOND, independently derived identifier that
     * corroborates it against `txgio_parcel.prop_id`. Two published columns
     * on each side, so a bind is a meaning-shaped agreement between two
     * derivations rather than a presence check on one.
     *
     * Nullable and honestly null: an export that does not publish them
     * writes NULL, never an empty string. A NULL here means "this export did
     * not publish it", which is distinct from a published blank. Measured
     * rather than assumed: WCAD's Socrata property dataset DOES publish both
     * (propertyid 63514 carries quickrefid R002338 and propertynumber
     * R-17-W338-401P-0013-0006), so Williamson is not a county without a
     * key. It is a county whose GEOMETRY publisher carries no geo_id at all
     * (0 non-blank of 304,298 txgio_parcel rows, staging and production,
     * read-only 2026-09-10), which is what actually leaves it unchanged.
     */
    quickRefId: text("quick_ref_id"),
    propertyNumber: text("property_number"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.propId, t.taxYear] }),
  }),
);

export type CadPropertyRow = typeof cadProperty.$inferSelect;
export type CadPropertyInsert = typeof cadProperty.$inferInsert;
