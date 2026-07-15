import { pgTable, text, date, timestamp, primaryKey } from "drizzle-orm/pg-core";

/**
 * Municipal building-permit store.
 *
 * Provider-neutral rows loaded from free open-data permit exports
 * (Austin's issued-construction-permits Socrata drop for Travis 48453,
 * San Antonio's permits-issued open-data CSVs for Bexar 48029). Loaded
 * by the `@workspace/permit-ingest` batch CLI; consumed by a follow-up
 * Property Brief `permits:*` slot adapter (not built in this lane).
 *
 * Keyed (county_fips, prop_id, permit_id):
 *  - `county_fips` is the 5-digit county FIPS (e.g. `48453` Travis,
 *    `48029` Bexar) so permit ids from different jurisdictions never
 *    collide.
 *  - `prop_id` is the parcel key the permit hangs on, taken verbatim
 *    from the source (`TCAD ID` for Austin — the same Travis CAD prop
 *    id `cad_property` uses; `PARCEL` for San Antonio). May be empty
 *    string when the source row carries no parcel; the permit still
 *    lands (permits without a parcel are common and still countable).
 *  - `permit_id` is the jurisdiction's own permit number (`Permit Num`
 *    for Austin, `PERMIT` for San Antonio).
 *
 * Re-ingesting the same drop (or a fresher drop of the same corpus)
 * upserts in place (idempotent): attribute columns are overwritten and
 * `ingested_at` is bumped so row age tracks the latest load.
 *
 * `issued_date` / `applied_date` are calendar dates (no time). Free
 * text columns (`work_class`, `status`, `description`, `permit_type`)
 * are stored as the source presents them, normalized only for
 * whitespace. `source_file` + `source_vintage` say which export drop a
 * row came from.
 *
 * The column mapping (which raw CSV column feeds each field, per city)
 * is factored out of `@workspace/calibration-engines/k2`'s permit
 * normalizers so this store and the K2 calibration harness read the
 * same corpus identically.
 */
export const buildingPermits = pgTable(
  "building_permits",
  {
    /** 5-digit county FIPS, e.g. `48453` (Travis), `48029` (Bexar). */
    countyFips: text("county_fips").notNull(),
    /**
     * Parcel key the permit hangs on, verbatim from source (`TCAD ID`
     * Austin / `PARCEL` San Antonio). Empty string when the source row
     * has no parcel.
     */
    propId: text("prop_id").notNull(),
    /** Jurisdiction permit number (`Permit Num` / `PERMIT`). */
    permitId: text("permit_id").notNull(),
    /** Date the permit was issued, when present. */
    issuedDate: date("issued_date"),
    /** Date the permit application was filed, when present. */
    appliedDate: date("applied_date"),
    /** Free-text work class / work type (e.g. `New`, `Addition`). */
    workClass: text("work_class"),
    /** Free-text current status (e.g. `Active`, `Final`, `Void`). */
    status: text("status"),
    /** Free-text permit description, when the source carries one. */
    description: text("description"),
    /** Free-text permit type/category, when the source carries one. */
    permitType: text("permit_type"),
    /** Basename of the export file the row was parsed from. */
    sourceFile: text("source_file").notNull(),
    /** Export drop label, e.g. `issued_construction_permits`. */
    sourceVintage: text("source_vintage").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.propId, t.permitId] }),
  }),
);

export type BuildingPermitRow = typeof buildingPermits.$inferSelect;
export type BuildingPermitInsert = typeof buildingPermits.$inferInsert;
