/**
 * Streaming RFC-4180 CSV reader (quoted fields, embedded
 * commas/quotes/newlines), adapted from `@workspace/cad-ingest`'s
 * hand-rolled parser so this package adds no CSV dependency.
 *
 * The permit exports are large (Austin ~2.36M rows), so whole-file
 * parsing is off the table — rows are yielded as they stream in. The
 * reader works from any Node `Readable` string/buffer stream, which
 * lets the CLI feed it either a local file (`createReadStream`) or the
 * stdout of a `gcloud storage cat` child process, through one code
 * path. A proper RFC-4180 parser (not a per-line split) matters here:
 * permit descriptions carry embedded commas and newlines inside quotes.
 */

import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

export type CsvRow = string[];

/** Async-generate rows from any Readable emitting string/Buffer chunks. */
export async function* readCsvStream(
  stream: Readable,
): AsyncGenerator<CsvRow> {
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  /** True when the previous char inside quotes was a quote (possible escape). */
  let pendingQuote = false;
  let sawAny = false;
  /** Strip a leading UTF-8 BOM from the very first character. */
  let atStart = true;

  function endField() {
    row.push(field);
    field = "";
  }

  const rows: CsvRow[] = [];
  function endRow() {
    endField();
    // Swallow completely empty trailing lines.
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  }

  for await (const chunk of stream) {
    sawAny = true;
    let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (atStart) {
      atStart = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          // The quote closed the field; fall through to unquoted handling.
          inQuotes = false;
          // no continue — process ch below
        } else if (ch === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"' && field.length === 0) {
        inQuotes = true;
      } else if (ch === ",") {
        endField();
      } else if (ch === "\n") {
        // Handle \r\n by trimming a trailing \r from the field.
        if (field.endsWith("\r")) field = field.slice(0, -1);
        endRow();
      } else {
        field += ch;
      }
    }
    while (rows.length > 0) {
      yield rows.shift() as CsvRow;
    }
  }
  // Flush a final unterminated row.
  if (sawAny && (field.length > 0 || row.length > 0)) {
    if (field.endsWith("\r")) field = field.slice(0, -1);
    endRow();
    while (rows.length > 0) {
      yield rows.shift() as CsvRow;
    }
  }
}

/** Async-generate rows from a local CSV file. */
export function readCsvFile(
  filePath: string,
  encoding: BufferEncoding = "utf8",
): AsyncGenerator<CsvRow> {
  return readCsvStream(createReadStream(filePath, { encoding }));
}

/**
 * Zip a header row and a data row into a `Record<string, string>`, the
 * shape the shared column extractors consume. Later duplicate header
 * names lose to the first (matches the harness's forward-fill).
 */
export function rowToRecord(header: CsvRow, row: CsvRow): Record<string, string> {
  const rec: Record<string, string> = {};
  for (let i = 0; i < header.length; i++) {
    const key = header[i] ?? "";
    if (key === "") continue;
    if (rec[key] === undefined) rec[key] = row[i] ?? "";
  }
  return rec;
}
