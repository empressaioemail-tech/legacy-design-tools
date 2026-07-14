/**
 * Minimal streaming RFC-4180 CSV reader (quoted fields, embedded
 * commas/quotes/newlines). Hand-rolled so the ingest package adds no
 * CSV dependency to the workspace; the CAD exports are large enough
 * that whole-file parsing is off the table.
 */

import { createReadStream } from "node:fs";

export type CsvRow = string[];

/** Async-generate rows from a CSV file. */
export async function* readCsvRows(
  filePath: string,
  encoding: BufferEncoding = "utf8",
): AsyncGenerator<CsvRow> {
  const stream = createReadStream(filePath, { encoding });
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  /** True when the previous char inside quotes was a quote (possible escape). */
  let pendingQuote = false;
  let sawAny = false;

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
    const text = chunk as string;
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

/**
 * Case-insensitive header index. Lookup keys are lowercased and
 * whitespace-stripped so `SquareFootage` (Hays) and `squarefootage`
 * (WCAD Socrata) resolve identically.
 */
export class HeaderIndex {
  private readonly byName = new Map<string, number>();

  constructor(header: CsvRow) {
    header.forEach((h, i) => {
      const key = h.trim().toLowerCase().replace(/\s+/g, "");
      if (!this.byName.has(key)) this.byName.set(key, i);
    });
  }

  has(name: string): boolean {
    return this.byName.has(name.toLowerCase().replace(/\s+/g, ""));
  }

  /** Value of column `name` in `row`, or "" when absent. */
  get(row: CsvRow, name: string): string {
    const i = this.byName.get(name.toLowerCase().replace(/\s+/g, ""));
    if (i === undefined || i >= row.length) return "";
    return row[i] ?? "";
  }
}
