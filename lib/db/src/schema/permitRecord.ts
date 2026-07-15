import {
  pgTable,
  text,
  date,
  numeric,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Municipal issued-permit records store (feat/permits-brief-slot).
 *
 * OWNED public-record corpus, acquired 2026-06-21 via the uniform
 * public-record process (calibrated-spine Wave 3) and landed raw in
 * `gs://hauska-calibration-raw/backtest/{metro}/permit/open_data/`:
 *
 *   - austin_tx       ~2.36M rows — City of Austin "Issued Construction
 *                     Permits" open-data export (data.austintexas.gov
 *                     resource 3syk-w9eu), issue dates 1921 → present.
 *   - san_antonio_tx  ~487K rows — City of San Antonio building-permit
 *                     open-data exports (data.sanantonio.gov), 2020-07 →
 *                     present (the pre-2020 Hansen legacy portal was not
 *                     bulk-acquirable; that gap is real and disclosed).
 *
 * Loaded by the `@workspace/cad-ingest` permits-ingest batch CLI from
 * local copies of those CSVs; consumed by the `permits:record` Property
 * Brief adapter (rehab-reality slot) via an injected accessor — same
 * pattern as `cad_property` / `cadLookup` (PR #245/#246).
 *
 * Keyed (metro, record_hash):
 *  - `metro` is the corpus jurisdiction slug (`austin_tx` /
 *    `san_antonio_tx`), matching the GCS landing layout.
 *  - `record_hash` is the SHA-256 hex of the raw CSV row (prefixed with
 *    the metro). Rows are immutable raw public records, so re-running an
 *    ingest is idempotent via ON CONFLICT DO NOTHING, and exact
 *    duplicate rows in the source export collapse. A synthetic hash key
 *    is used because neither export has a reliable natural key: San
 *    Antonio repeats the same PERMIT # across trade sub-permits, and
 *    Austin permit numbers recycle across export vintages.
 *
 * `address_normalized` is the match key the brief adapter queries:
 * the first comma-segment of the situs address, uppercased, punctuation
 * stripped, street suffix/directional tokens normalized (ST/DR/LN/...),
 * one trailing standalone ZIP token dropped. Address matching is fuzzy
 * by nature — unit-level permits, address rewrites, and range addresses
 * can miss; the adapter discloses that caveat rather than papering over
 * it. `tcad_id` (Austin only) is stored for a future verified id-join
 * but is NOT used for matching in v1: the county GIS point query
 * returns TCAD PROP_ID while this column carries the export's
 * geo-format TCAD ID, and the correspondence is unverified.
 *
 * `valuation` is the export's declared/job valuation in dollars —
 * applicant-declared, not an appraisal. `acquired_date` is the
 * public-record acquisition date (manifest `acquired=` partition);
 * `source_file` is the CSV basename inside that partition.
 */
export const permitRecord = pgTable(
  "permit_record",
  {
    /** Corpus jurisdiction slug: `austin_tx` | `san_antonio_tx`. */
    metro: text("metro").notNull(),
    /** SHA-256 hex of (metro + raw CSV row) — idempotency/dedupe key. */
    recordHash: text("record_hash").notNull(),
    /** Permit number as issued (NOT unique — SA trade sub-permits share it). */
    permitNumber: text("permit_number").notNull(),
    /** Austin "Permit Type Desc" / SA "PERMIT TYPE". */
    permitType: text("permit_type"),
    /** Austin "Work Class" / SA "WORK TYPE". */
    workClass: text("work_class"),
    /** Austin "Permit Class Mapped" (Residential/Commercial). SA: null. */
    permitClass: text("permit_class"),
    /** Austin "Description" / SA "PROJECT NAME". */
    description: text("description"),
    /** Austin "Status Current". SA exports carry no status → null. */
    status: text("status"),
    appliedDate: date("applied_date"),
    issuedDate: date("issued_date"),
    /** Declared/job valuation, dollars. Applicant-declared, not an appraisal. */
    valuation: numeric("valuation", { precision: 14, scale: 2 }),
    /** Situs line as shipped (first comma-segment for SA). */
    addressRaw: text("address_raw"),
    /** Normalized street-line match key (see module docstring). */
    addressNormalized: text("address_normalized"),
    /** Austin "TCAD ID" (geo-format). Stored, not matched on, in v1. */
    tcadId: text("tcad_id"),
    /** CSV basename in the acquisition partition. */
    sourceFile: text("source_file").notNull(),
    /** Public-record acquisition date (GCS `acquired=` partition), ISO. */
    acquiredDate: text("acquired_date").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.metro, t.recordHash] }),
    /** The brief adapter's read path: metro + match key, newest first. */
    addressIdx: index("permit_record_metro_address_issued_idx").on(
      t.metro,
      t.addressNormalized,
      t.issuedDate,
    ),
  }),
);

export type PermitRecordRow = typeof permitRecord.$inferSelect;
export type PermitRecordInsert = typeof permitRecord.$inferInsert;
