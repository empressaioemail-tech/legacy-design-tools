/**
 * Tyler Orion PropertyDataExport parser tests against real rows copied
 * verbatim from:
 *  - Hays CAD "2025 PROPERTY DATA EXPORT FILES AS OF 6-29-2026"
 *    (property / owner / segment record files), and
 *  - the WCAD Socrata portal (data.wcad.org ij43-xknu property +
 *    bbia-wsxs owner datasets, lowercased-header variant).
 * All public record.
 */

import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyOrionHeader,
  parseOrionExport,
  readOrionLand,
  readOrionOwners,
} from "../orion/parser";
import { HeaderIndex } from "../csv";
import { newCounters } from "../types";
import type { CadPropertyRecord } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => join(here, "__fixtures__", name);

async function collect(opts: Parameters<typeof parseOrionExport>[0]) {
  const counters = newCounters();
  const records: CadPropertyRecord[] = [];
  for await (const rec of parseOrionExport(opts, counters)) records.push(rec);
  return { records, counters };
}

describe("Orion PropertyDataExport parser (Hays)", () => {
  it("joins property + owner + land + segment records", async () => {
    const { records, counters } = await collect({
      countyFips: "48209",
      propertyFile: fx("hays_property_sample.txt"),
      ownerFile: fx("hays_owner_sample.txt"),
      landFile: fx("hays_land_sample.txt"),
      segmentFile: fx("hays_segment_sample.txt"),
      taxYear: 2025,
    });
    expect(counters.rowsParsed).toBe(4);
    expect(counters.rowsSkipped).toBe(0);

    const rec = records.find((r) => r.propId === "12300");
    expect(rec).toMatchObject({
      countyFips: "48209",
      taxYear: 2025,
      ownerName: "LOPEZ JASMINE & SALINAS JOSE A",
      ownerMailingAddress: "3761 COTTON GIN RD, UHLAND, TX 78640-2911",
      situsAddress: "3761 COTTON GIN RD, UHLAND, TX 78640",
      situsCity: "UHLAND",
      situsZip: "78640",
      exemptionCodes: ["HS"],
      landValue: 206700,
      improvementValue: 54300,
      marketValue: 261000, // Curr* preferred over plain (290000)
      assessedValue: 261000,
      yearBuilt: 2003, // MA segment
      livingAreaSqft: 1568,
      landAcres: "1.0360",
      propertyUseCode: "A1", // record-3 Land StateCode
    });

    // 0 sqft + no MA segment -> null living area / year built.
    const commercial = records.find((r) => r.propId === "12074");
    expect(commercial?.livingAreaSqft).toBeNull();
    expect(commercial?.yearBuilt).toBeNull();
    expect(commercial?.marketValue).toBe(927395); // Curr differs from plain
    expect(commercial?.propertyUseCode).toBe("F1"); // commercial state code

    // Empty ExemptionList -> null.
    expect(commercial?.exemptionCodes).toBeNull();

    // Multiple land segments -> lowest Sequence (the primary) wins.
    // 11924 has A1 @ seq 1 and D1 @ seq 2; A1 is expected.
    const withSqft = records.find((r) => r.propId === "11924");
    expect(withSqft?.livingAreaSqft).toBe(2647);
    expect(withSqft?.yearBuilt).toBe(1979);
    expect(withSqft?.propertyUseCode).toBe("A1");

    // Property with no land row -> null (honest neutral, no fabrication).
    const noLand = records.find((r) => r.propId === "12350");
    expect(noLand?.propertyUseCode).toBeNull();
  });

  it("leaves property_use_code null when no land file is supplied", async () => {
    const { records } = await collect({
      countyFips: "48209",
      propertyFile: fx("hays_property_sample.txt"),
      ownerFile: fx("hays_owner_sample.txt"),
      segmentFile: fx("hays_segment_sample.txt"),
      taxYear: 2025,
    });
    for (const r of records) expect(r.propertyUseCode).toBeNull();
  });
});

describe("Orion Land file (record 3)", () => {
  it("picks the lowest-Sequence StateCode per property", async () => {
    const land = await readOrionLand(fx("hays_land_sample.txt"));
    expect(land.get("11924")).toBe("A1"); // seq 1 over seq 2 (D1)
    expect(land.get("12074")).toBe("F1");
    expect(land.get("12300")).toBe("A1");
    expect(land.has("12350")).toBe(false); // no row -> absent
  });

  it("classifies the record-3 Land header as \"land\"", () => {
    const haysLandHeader = new HeaderIndex([
      "RecordType",
      "PropertyID",
      "LandType",
      "Description",
      "StateCode",
      "Acres",
      "Sequence",
    ]);
    expect(classifyOrionHeader(haysLandHeader)).toBe("land");
  });
});

describe("Orion PropertyDataExport parser (WCAD Socrata variant)", () => {
  it("parses lowercased headers, pre-joined mailing, primary owners", async () => {
    const { records, counters } = await collect({
      countyFips: "48491",
      propertyFile: fx("wcad_property_sample.csv"),
      ownerFile: fx("wcad_owner_sample.csv"),
      landFile: fx("wcad_land_sample.csv"),
      taxYear: 2026,
    });
    expect(counters.rowsParsed).toBe(4);

    const rec = records.find((r) => r.propId === "63514");
    expect(rec).toMatchObject({
      countyFips: "48491",
      taxYear: 2026,
      ownerName: "ENGLISH  RICHARD A & NANCY M",
      ownerMailingAddress: "1602 PARKWOOD DR LEANDER TX 78641-8635",
      situsAddress: "1602 PARKWOOD DR, LEANDER, TX 78641",
      situsCity: "LEANDER",
      situsZip: "78641",
      exemptionCodes: ["HS"],
      landValue: 67500,
      improvementValue: 181132,
      marketValue: 248632, // currmarketvalue preferred over marketvalue
      assessedValue: 248632,
      livingAreaSqft: 1184,
      propertyUseCode: "A1", // lowercased-header land dataset
    });

    // Property with no land row in the sample -> null.
    const noLand = records.find((r) => r.propId === "63599");
    expect(noLand?.propertyUseCode).toBeNull();
  });

  it("splits space-separated ExemptionList codes (live WCAD 'HS OA')", async () => {
    // Live WCAD Socrata packs multiple exemption codes into one cell,
    // space-separated ("HS OA", "HS OV65 DV1"); the fixture with a
    // single code did not exercise this. Codes never contain internal
    // spaces, so whitespace is a safe delimiter alongside |,;.
    const owners = await readOrionOwners(fx("wcad_owner_multiexempt_sample.csv"));
    expect(owners.get("70001")?.exemptionCodes).toEqual(["HS", "OA"]);
    expect(owners.get("70002")?.exemptionCodes).toEqual(["HS", "OV65", "DV1"]);
    // Empty cell -> null (no bogus empty-string code).
    expect(owners.get("70003")?.exemptionCodes).toBeNull();
  });

  it("rejects a non-property file passed as the property file", async () => {
    await expect(
      collect({
        countyFips: "48491",
        propertyFile: fx("wcad_owner_sample.csv"),
        taxYear: 2026,
      }),
    ).rejects.toThrow(/expected an Orion property file/);
  });
});
