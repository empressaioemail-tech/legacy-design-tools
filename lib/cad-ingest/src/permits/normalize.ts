/**
 * Normalization of raw municipal issued-permit CSV rows into
 * `permit_record` inserts (feat/permits-brief-slot).
 *
 * Two source shapes, both from the Wave-3 public-record acquisition
 * (raw CSVs in `gs://hauska-calibration-raw/backtest/{metro}/permit/
 * open_data/acquired=2026-06-21/data/`, headers verified against the
 * live objects 2026-07-15):
 *
 *   austin_tx        `issued_construction_permits.csv` — Socrata export
 *                    of data.austintexas.gov 3syk-w9eu. Dates are
 *                    `YYYY/MM/DD` (some columns `MM/DD/YYYY`);
 *                    valuation columns are plain numerics; the situs
 *                    line is `Original Address 1` (no commas); `TCAD ID`
 *                    carries the export's geo-format appraisal id.
 *   san_antonio_tx   `permits_issued_2020_2024.csv` +
 *                    `permits_issued_current.csv` — CKAN exports of
 *                    data.sanantonio.gov. Dates are ISO
 *                    (`YYYY-MM-DDTHH:MM:SS` or bare `YYYY-MM-DD`);
 *                    literal `NULL` strings mean empty; the ADDRESS
 *                    column embeds city/state/zip after the first comma
 *                    (and some dirty rows embed the ZIP in the street
 *                    line); the same PERMIT # repeats across trade
 *                    sub-permits (each kept as its own row).
 *
 * Honest-normalization rules: no interpretation beyond field mapping —
 * unparseable dates/valuations become null (never guessed), rows
 * without a permit number are skipped and counted, and the raw street
 * line is preserved beside the normalized match key
 * (`permitStreetKey` from `@workspace/adapters/local/permits` — THE
 * shared normalization; the adapter applies the same function to the
 * subject address at query time).
 */

import { createHash } from "node:crypto";
import type { PermitRecordInsert } from "@workspace/db/schema";
import { permitStreetKey } from "@workspace/adapters/local/permits";
import { HeaderIndex, type CsvRow } from "../csv";

export type PermitMetro = "austin_tx" | "san_antonio_tx";

export interface PermitParseCounters {
  rowsRead: number;
  rowsEmitted: number;
  skippedNoPermitNumber: number;
  /** Rows whose street line produced no usable match key (kept, key null). */
  rowsWithoutMatchKey: number;
}

export function newPermitCounters(): PermitParseCounters {
  return {
    rowsRead: 0,
    rowsEmitted: 0,
    skippedNoPermitNumber: 0,
    rowsWithoutMatchKey: 0,
  };
}

/** "" and the literal string NULL (any case) are empty. */
function cell(v: string): string | null {
  const t = v.trim();
  if (!t || /^null$/i.test(t)) return null;
  return t;
}

/**
 * Parse the exports' date shapes to ISO `YYYY-MM-DD`:
 * `YYYY/MM/DD`, `MM/DD/YYYY`, `YYYY-MM-DD[THH:MM:SS...]`. Anything
 * else → null, never guessed.
 */
export function parsePermitDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[T\s].*)?$/))) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if ((match = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    y = Number(match[3]);
    m = Number(match[1]);
    d = Number(match[2]);
  } else {
    return null;
  }
  if (y < 1800 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a declared-valuation cell ("3500000.0", "$12,345.67") to a
 * 2-decimal string for the numeric(14,2) column. Non-numeric or
 * negative → null.
 */
export function parsePermitValuation(raw: string | null): string | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  // numeric(14,2) precision guard — anything at/over a trillion dollars
  // is a data error, not a valuation.
  if (n >= 1e12) return null;
  return n.toFixed(2);
}

/** SHA-256 hex over (metro + raw row) — the idempotency/dedupe key. */
export function permitRecordHash(metro: PermitMetro, row: CsvRow): string {
  const h = createHash("sha256");
  h.update(metro);
  for (const field of row) {
    h.update("\x1f");
    h.update(field);
  }
  return h.digest("hex");
}

export interface NormalizePermitRowInput {
  metro: PermitMetro;
  header: HeaderIndex;
  row: CsvRow;
  sourceFile: string;
  acquiredDate: string;
}

/**
 * Map one raw CSV row to a `permit_record` insert, or null when the
 * row has no permit number (counted by the caller). `ingestedAt` is
 * left to the column default.
 */
export function normalizePermitRow(
  input: NormalizePermitRowInput,
): PermitRecordInsert | null {
  const { metro, header, row, sourceFile, acquiredDate } = input;
  const g = (name: string) => cell(header.get(row, name));

  if (metro === "austin_tx") {
    const permitNumber = g("Permit Num");
    if (!permitNumber) return null;
    const addressRaw = g("Original Address 1");
    return {
      metro,
      recordHash: permitRecordHash(metro, row),
      permitNumber,
      permitType: g("Permit Type Desc"),
      workClass: g("Work Class"),
      permitClass: g("Permit Class Mapped"),
      description: g("Description"),
      status: g("Status Current"),
      appliedDate: parsePermitDate(g("Applied Date")),
      issuedDate: parsePermitDate(g("Issued Date")),
      valuation: parsePermitValuation(g("Total Job Valuation")),
      addressRaw,
      addressNormalized: permitStreetKey(addressRaw),
      tcadId: g("TCAD ID"),
      sourceFile,
      acquiredDate,
    };
  }

  // san_antonio_tx
  const permitNumber = g("PERMIT #");
  if (!permitNumber) return null;
  const addressFull = g("ADDRESS");
  // Preserve the street line (first comma-segment) as the raw situs;
  // the full string's tail is city/state/zip boilerplate.
  const addressRaw = addressFull ? (addressFull.split(",")[0] ?? "").trim() || null : null;
  return {
    metro,
    recordHash: permitRecordHash(metro, row),
    permitNumber,
    permitType: g("PERMIT TYPE"),
    workClass: g("WORK TYPE"),
    permitClass: null,
    description: g("PROJECT NAME"),
    // The SA exports are issuance feeds with no status column — null,
    // never fabricated.
    status: null,
    appliedDate: parsePermitDate(g("DATE SUBMITTED")),
    issuedDate: parsePermitDate(g("DATE ISSUED")),
    valuation: parsePermitValuation(g("DECLARED VALUATION")),
    addressRaw,
    addressNormalized: permitStreetKey(addressFull),
    tcadId: null,
    sourceFile,
    acquiredDate,
  };
}

/** Expected header sanity probe — fail fast on the wrong CSV. */
export function assertPermitHeader(metro: PermitMetro, header: HeaderIndex): void {
  const required =
    metro === "austin_tx"
      ? ["Permit Num", "Permit Type Desc", "Issued Date", "Original Address 1"]
      : ["PERMIT #", "PERMIT TYPE", "DATE ISSUED", "ADDRESS"];
  const missing = required.filter((c) => !header.has(c));
  if (missing.length > 0) {
    throw new Error(
      `CSV header does not look like a ${metro} permit export — missing column(s): ${missing.join(", ")}`,
    );
  }
}
