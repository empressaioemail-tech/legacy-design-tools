/**
 * Parser / normalizer unit tests against real-shaped fixture rows
 * copied verbatim from the live 2026-06-21 open-data drops (Austin
 * issued_construction_permits, San Antonio permits_issued_current +
 * permits_issued_2020_2024). No DB required.
 */

import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMIT_SOURCES } from "../sources";
import { normalizePermitRow, parsePermitStream, toCalendarDate } from "../normalize";
import { rowToRecord, readCsvFile } from "../csv";
import { newCounters } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "__fixtures__", name);

async function collect(source: (typeof PERMIT_SOURCES)[keyof typeof PERMIT_SOURCES], file: string) {
  const counters = newCounters();
  const out = [];
  for await (const rec of parsePermitStream(source, Readable.from(readFileSync(file)), counters)) {
    out.push(rec);
  }
  return { records: out, counters };
}

describe("toCalendarDate", () => {
  it("parses Austin slash dates to YYYY-MM-DD", () => {
    expect(toCalendarDate("2026/05/20")).toBe("2026-05-20");
  });
  it("parses SA ISO timestamps to the date part", () => {
    expect(toCalendarDate("2020-07-20T00:00:00")).toBe("2020-07-20");
    expect(toCalendarDate("2025-01-01")).toBe("2025-01-01");
  });
  it("returns null for empty / NULL / N/A", () => {
    expect(toCalendarDate("")).toBeNull();
    expect(toCalendarDate("  ")).toBeNull();
    expect(toCalendarDate("N/A")).toBeNull();
    expect(toCalendarDate(undefined)).toBeNull();
  });
});

describe("Austin permit normalization (real fixture)", () => {
  it("maps Permit Num / TCAD ID / Work Class / dates", async () => {
    const { records, counters } = await collect(
      PERMIT_SOURCES.austin,
      fixture("austin_permits_sample.csv"),
    );
    expect(counters.rowsParsed).toBeGreaterThan(0);
    const first = records[0]!;
    expect(first.countyFips).toBe("48453");
    expect(first.permitId).toBe("2026-061052 EP");
    expect(first.propId).toBe("0330430122"); // TCAD ID = Travis CAD prop id
    expect(first.workClass).toBe("Wall");
    expect(first.issuedDate).toBe("2026-06-11");
    expect(first.appliedDate).toBe("2026-05-20");
    expect(first.status).toBe("Active");
    expect(first.permitType).toBe("Electrical Permit");
    expect(first.description).toBe("Mi Casa Family Dentistry");
  });
});

describe("San Antonio permit normalization (real fixtures)", () => {
  it("maps PERMIT # / WORK TYPE / DATE ISSUED (current file, no parcel)", async () => {
    const { records, counters } = await collect(
      PERMIT_SOURCES["san-antonio"],
      fixture("san_antonio_permits_current_sample.csv"),
    );
    expect(counters.rowsParsed).toBeGreaterThan(0);
    const first = records[0]!;
    expect(first.countyFips).toBe("48029");
    expect(first.permitId).toBe("BLDG-GS-PMT-13814068");
    expect(first.propId).toBe(""); // SA open-data has no parcel column
    expect(first.issuedDate).toBe("2025-01-01");
    expect(first.appliedDate).toBe("2025-01-01");
    expect(first.status).toBeNull(); // no STATUS column
    expect(first.permitType).toBe("Garage Sale");
  });

  it("treats NULL sentinels as empty (2020-2024 file)", async () => {
    const { records } = await collect(
      PERMIT_SOURCES["san-antonio"],
      fixture("san_antonio_permits_2020_2024_sample.csv"),
    );
    const first = records[0]!;
    expect(first.permitId).toBe("BLDG-GS-PMT-13801279");
    expect(first.issuedDate).toBe("2020-07-20");
    // WORK TYPE cell is the literal "NULL" -> normalized to null
    expect(first.workClass).toBeNull();
  });

  it("dedups repeated PERMIT # across trade lines to one row", async () => {
    const { records, counters } = await collect(
      PERMIT_SOURCES["san-antonio"],
      fixture("san_antonio_permits_current_sample.csv"),
    );
    const ids = records.map((r) => r.permitId);
    // The Taco Palenque project appears as both a building and an
    // electrical trade line sharing COM-BLG-PMT24-40200788.
    const dupId = "COM-BLG-PMT24-40200788";
    expect(ids.filter((id) => id === dupId)).toHaveLength(1);
    expect(counters.duplicateRows).toBeGreaterThanOrEqual(1);
  });
});

describe("malformed-row skip", () => {
  const source = PERMIT_SOURCES.austin;
  it("skips a row with no permit id and records a sample", async () => {
    const header = "Permit Num,TCAD ID,Issued Date,Work Class";
    const good = "2026-1,PARCELA,2026/01/02,New";
    const noId = ",PARCELB,2026/01/03,New"; // empty Permit Num
    const csv = [header, good, noId].join("\n");
    const counters = newCounters();
    const out = [];
    for await (const rec of parsePermitStream(source, Readable.from(csv), counters)) {
      out.push(rec);
    }
    expect(out).toHaveLength(1);
    expect(counters.rowsRead).toBe(2);
    expect(counters.rowsParsed).toBe(1);
    expect(counters.rowsSkipped).toBe(1);
    expect(counters.skipSamples.length).toBe(1);
  });

  it("normalizePermitRow returns null when permit id missing", () => {
    expect(
      normalizePermitRow(source, { "TCAD ID": "X", "Issued Date": "2026/01/01" }),
    ).toBeNull();
  });
});

describe("csv rowToRecord", () => {
  it("zips header and row, first duplicate header wins", () => {
    const rec = rowToRecord(["a", "b", "a"], ["1", "2", "3"]);
    expect(rec).toEqual({ a: "1", b: "2" });
  });

  it("streaming reader handles quoted embedded commas", async () => {
    const rows = [];
    // write a tiny temp is overkill; reuse the SA fixture which has
    // quoted addresses with embedded commas.
    for await (const r of readCsvFile(fixture("san_antonio_permits_current_sample.csv"))) {
      rows.push(r);
      if (rows.length >= 2) break;
    }
    // header + first row both parse to the same column count (16).
    expect(rows[0]!.length).toBe(rows[1]!.length);
    expect(rows[0]!.length).toBe(16);
  });
});
