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
import { parseOrionExport } from "../orion/parser";
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
  it("joins property + owner + segment records", async () => {
    const { records, counters } = await collect({
      countyFips: "48209",
      propertyFile: fx("hays_property_sample.txt"),
      ownerFile: fx("hays_owner_sample.txt"),
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
      propertyUseCode: null,
    });

    // 0 sqft + no MA segment -> null living area / year built.
    const commercial = records.find((r) => r.propId === "12074");
    expect(commercial?.livingAreaSqft).toBeNull();
    expect(commercial?.yearBuilt).toBeNull();
    expect(commercial?.marketValue).toBe(927395); // Curr differs from plain

    // Empty ExemptionList -> null.
    expect(commercial?.exemptionCodes).toBeNull();

    // SquareFootage wins over segment sum when present.
    const withSqft = records.find((r) => r.propId === "11924");
    expect(withSqft?.livingAreaSqft).toBe(2647);
    expect(withSqft?.yearBuilt).toBe(1979);
  });
});

describe("Orion PropertyDataExport parser (WCAD Socrata variant)", () => {
  it("parses lowercased headers, pre-joined mailing, primary owners", async () => {
    const { records, counters } = await collect({
      countyFips: "48491",
      propertyFile: fx("wcad_property_sample.csv"),
      ownerFile: fx("wcad_owner_sample.csv"),
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
    });
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
