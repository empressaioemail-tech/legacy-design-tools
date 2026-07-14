/**
 * PACS 8.0.x parser tests against real rows copied verbatim from the
 * 2026 Caldwell CAD export ("2026-Caldwell-CAD-export_June-5-2026.zip",
 * public record). The fixture carries 5 APPRAISAL_INFO rows and every
 * matching APPRAISAL_IMPROVEMENT_DETAIL row.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parsePacsExport } from "../pacs/parser";
import { newCounters } from "../types";
import type { CadPropertyRecord } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const INFO_FIXTURE = join(here, "__fixtures__", "caldwell_appraisal_info_sample.txt");
const DETAIL_FIXTURE = join(
  here,
  "__fixtures__",
  "caldwell_improvement_detail_sample.txt",
);

async function collect(opts: Parameters<typeof parsePacsExport>[0]) {
  const counters = newCounters();
  const records: CadPropertyRecord[] = [];
  const gen = parsePacsExport(opts, counters);
  for await (const rec of gen) records.push(rec);
  return { records, counters };
}

describe("PACS appraisal-export parser", () => {
  it("parses real Caldwell rows with improvement enrichment", async () => {
    const { records, counters } = await collect({
      countyFips: "48055",
      infoFile: INFO_FIXTURE,
      improvementDetailFile: DETAIL_FIXTURE,
    });
    expect(counters.rowsRead).toBe(5);
    expect(counters.rowsParsed).toBe(5);
    expect(counters.rowsSkipped).toBe(0);

    const first = records.find((r) => r.propId === "10001");
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      countyFips: "48055",
      propId: "10001",
      taxYear: 2026,
      ownerName: "HERNANDEZ-SOLIS J JESUS &",
      ownerMailingAddress:
        "RAMIREZ GILBERTA RAMIREZ, 15 SUNRISE ST, DALE, TX 78616-2586",
      situsAddress: "15 SUNRISE ST",
      situsCity: "DALE",
      situsZip: "78616",
      exemptionCodes: null,
      landValue: 145090,
      improvementValue: 252170,
      marketValue: 397260,
      assessedValue: 397260,
      yearBuilt: 1962,
      livingAreaSqft: 1176,
      landAcres: "1.7716",
      propertyUseCode: "E1",
    });
    expect(first?.legalDescription).toContain("O.T. LYTTON SPRINGS");

    // Homestead flags map to exemption codes.
    const hs = records.find((r) => r.propId === "10004");
    expect(hs?.exemptionCodes).toEqual(["HS"]);
    expect(hs?.assessedValue).toBe(276670); // appraised minus HS cap
    expect(hs?.marketValue).toBe(300700);
    expect(hs?.yearBuilt).toBe(2007);

    // PO-box mailing with no line1.
    const poBox = records.find((r) => r.propId === "10002");
    expect(poBox?.ownerMailingAddress).toBe("PO BOX 19493, AUSTIN, TX 78760-9493");
  });

  it("skips malformed rows without aborting and dedupes repeats", async () => {
    const fixture = await readFile(INFO_FIXTURE, "latin1");
    const lines = fixture.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const good = lines[0];
    const mangled = [
      good,
      good.slice(0, 1200), // truncated record
      "garbage line that is far too short",
      good, // duplicate (same prop_id + year)
      lines[1],
    ].join("\r\n");
    const dir = await mkdtemp(join(tmpdir(), "cad-test-"));
    const file = join(dir, "mangled.txt");
    await writeFile(file, mangled, "latin1");

    const { records, counters } = await collect({
      countyFips: "48055",
      infoFile: file,
    });
    expect(counters.rowsRead).toBe(5);
    expect(counters.rowsParsed).toBe(2);
    expect(counters.rowsSkipped).toBe(2);
    expect(counters.duplicateRows).toBe(1);
    expect(records.map((r) => r.propId)).toEqual(["10001", "10002"]);
    expect(counters.skipSamples.length).toBeGreaterThan(0);
  });

  it("honors the parse limit", async () => {
    const { records } = await collect({
      countyFips: "48055",
      infoFile: INFO_FIXTURE,
      limit: 2,
    });
    expect(records).toHaveLength(2);
  });
});
