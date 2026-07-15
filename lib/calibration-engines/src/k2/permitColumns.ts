/**
 * Canonical permit column mapping — the single source of truth for
 * which raw open-data CSV column feeds each logical permit field, per
 * city.
 *
 * Factored out of the K2 outcome normalizers (`normalizeAustinPermitRow`
 * / `normalizeSanAntonioPermitRow`) so the `@workspace/permit-ingest`
 * store loader and the K2 calibration harness read the exact same corpus
 * identically. If a city's export changes a column header, fix it here
 * once and both consumers follow.
 *
 * These extractors are intentionally provider-shaped and calibration-
 * neutral: they only pull and whitespace-trim raw strings. Date parsing,
 * outcome labelling, and I-Code partitioning stay in the harness
 * (`normalizeOutcome`/`permitPartition`); the store keeps the raw source
 * values.
 */

export type RawPermitRow = Record<string, string>;

/** A permit as read from a source row, before any date parsing. */
export interface RawPermitFields {
  /** Jurisdiction permit number. Empty string when absent. */
  permitId: string;
  /** Parcel key the permit hangs on. Empty string when absent. */
  parcelKey: string;
  /** Raw issued-date string (unparsed), or "" when absent. */
  issuedDateRaw: string;
  /** Raw applied-date string (unparsed), or "" when absent. */
  appliedDateRaw: string;
  /** Raw work class / work type, or "" when absent. */
  workClass: string;
  /** Raw current status, or "" when absent. */
  status: string;
  /** Raw description, or "" when absent. */
  description: string;
  /** Raw permit type/category, or "" when absent. */
  permitType: string;
}

/** `NULL` / `NUL` / `N/A` string sentinels that mean "no value". */
function isSentinel(v: string): boolean {
  const u = v.trim().toUpperCase();
  return u === "" || u === "NULL" || u === "NUL" || u === "N/A" || u === "NONE";
}

function first(row: RawPermitRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) {
      const s = String(v).trim();
      if (!isSentinel(s)) return s;
    }
  }
  return "";
}

/**
 * Austin issued-construction-permits Socrata drop (Travis 48453).
 *
 * Parcel key is `TCAD ID` (the Travis CAD prop id `cad_property` uses);
 * permit id is `Permit Num`; dates are `Issued Date` / `Applied Date`;
 * status is `Status Current`; work class is `Work Class`. Lowercase
 * `snake_case` aliases cover the API/export-variant column names.
 */
export function extractAustinPermitFields(row: RawPermitRow): RawPermitFields {
  return {
    permitId: first(row, "Permit Num", "permit_number", "Permit Number"),
    parcelKey: first(row, "TCAD ID", "tcad_id"),
    issuedDateRaw: first(row, "Issued Date", "issued_date"),
    appliedDateRaw: first(row, "Applied Date", "applied_date"),
    workClass: first(row, "Work Class", "work_class"),
    status: first(row, "Status Current", "status"),
    description: first(row, "Description", "description", "Permit Class", "permit_class"),
    permitType: first(row, "Permit Type Desc", "permit_type_desc", "Permit Type", "permit_type"),
  };
}

/**
 * San Antonio permits-issued open-data CSVs (Bexar 48029).
 *
 * Verified against the live 2026-06-21 open-data drops
 * (permits_issued_2020_2024.csv, permits_issued_current.csv): the real
 * headers are `PERMIT #` (permit id), `WORK TYPE`, `DATE ISSUED`,
 * `DATE SUBMITTED` (applied), `PERMIT TYPE` (category, used as the
 * description), and `PROJECT NAME`. These files carry NO parcel column
 * and NO status column, and use the string sentinel `NULL` for empty
 * cells (handled by `isSentinel`). The `PARCEL`/`ISSUEDATE`/`STATUS`/
 * `WORK_TYPE` legacy aliases are kept for any older/underscored export
 * variant. `PERMIT #` is not unique across trade lines of one project
 * (a building + electrical + plumbing row can share it); the store
 * dedups on (prop_id, permit_id) so those collapse to one row.
 */
export function extractSanAntonioPermitFields(row: RawPermitRow): RawPermitFields {
  return {
    permitId: first(row, "PERMIT #", "PERMIT", "Permit Number", "PERMIT_NUMBER"),
    parcelKey: first(row, "PARCEL", "Parcel", "parcel"),
    issuedDateRaw: first(row, "DATE ISSUED", "ISSUEDATE", "Issue Date", "issue_date", "PERMIT_DATE"),
    appliedDateRaw: first(row, "DATE SUBMITTED", "APPLIEDDATE", "Applied Date", "applied_date", "SUBMITDATE"),
    workClass: first(row, "WORK TYPE", "WORK_TYPE", "Work Type", "work_type"),
    status: first(row, "STATUS", "Status"),
    description: first(row, "PROJECT NAME", "DESCRIPTION", "Description"),
    permitType: first(row, "PERMIT TYPE", "PERMIT_TYPE", "Permit Type", "permit_type", "PERMITTYPE"),
  };
}
