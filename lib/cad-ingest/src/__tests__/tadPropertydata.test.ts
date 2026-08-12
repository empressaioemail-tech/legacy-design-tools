/**
 * TAD PropertyData(Delimited) parser tests against real rows copied
 * verbatim from PropertyData(Delimited)_R.ZIP (Tarrant 48439).
 */

import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTadPropertyExport } from "../vendors/tad-propertydata/parser";
import { newCounters } from "../types";
import type { CadPropertyRecord } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => join(here, "__fixtures__", name);

async function collect(limit?: number) {
  const counters = newCounters();
  const records: CadPropertyRecord[] = [];
  for await (const rec of parseTadPropertyExport(
    {
      countyFips: "48439",
      propertyFile: fx("tadPropertyDataR.txt"),
      limit,
    },
    counters,
  )) {
    records.push(rec);
  }
  return { records, counters };
}

describe("TAD PropertyData parser", () => {
  it("uses GIS_Link as prop_id and maps structural fields", async () => {
    const { records, counters } = await collect();
    expect(counters.rowsParsed).toBe(20);
    expect(counters.rowsSkipped).toBe(0);

    const rec = records.find((r) => r.propId === "14437-29-32");
    expect(rec).toMatchObject({
      countyFips: "48439",
      propId: "14437-29-32",
      taxYear: 2026,
      ownerName: "TODD & MELISSA DAILEY",
      ownerMailingAddress: "704 E WEATHERFORD ST FORT WORTH , TX 76102",
      situsAddress: "704 E WEATHERFORD ST",
      propertyUseCode: "A",
      landValue: 110000,
      improvementValue: 446381,
      marketValue: 556381,
      assessedValue: 556381,
      yearBuilt: 1910,
      livingAreaSqft: 2550,
      landAcres: "0.1148",
    });
  });

  it("maps zero year_built and living_area to null", async () => {
    const { records } = await collect();
    const vacant = records.find((r) => r.propId === "14437-124-1D");
    expect(vacant?.yearBuilt).toBeNull();
    expect(vacant?.livingAreaSqft).toBeNull();
    expect(vacant?.landAcres).toBe("0.0510");
  });
});
