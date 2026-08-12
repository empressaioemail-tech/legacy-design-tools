/**
 * DCAD certified comma-delimited parser tests against real rows copied
 * verbatim from DCAD2026_CERTIFIED_07232026.zip (Dallas 48113).
 */

import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyDcadHeader,
  parseDcadCertifiedExport,
} from "../vendors/dcad-certified/parser";
import { HeaderIndex } from "../csv";
import { newCounters } from "../types";
import type { CadPropertyRecord } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => join(here, "__fixtures__", name);

async function collect() {
  const counters = newCounters();
  const records: CadPropertyRecord[] = [];
  for await (const rec of parseDcadCertifiedExport(
    {
      countyFips: "48113",
      accountInfoFile: fx("dcad_account_info.csv"),
      resDetailFile: fx("dcad_res_detail.csv"),
      apprlYearFile: fx("dcad_account_apprl_year.csv"),
      landFile: fx("dcad_land.csv"),
    },
    counters,
  )) {
    records.push(rec);
  }
  return { records, counters };
}

describe("DCAD certified parser", () => {
  it("classifies ACCOUNT_INFO headers", () => {
    const header = new HeaderIndex([
      "ACCOUNT_NUM",
      "APPRAISAL_YR",
      "OWNER_NAME1",
      "FULL_STREET_NAME",
    ]);
    expect(classifyDcadHeader(header)).toBe("account-info");
  });

  it("joins account info with res detail and values on ACCOUNT_NUM", async () => {
    const { records, counters } = await collect();
    expect(counters.rowsParsed).toBe(3);
    expect(counters.rowsSkipped).toBe(0);

    const rec = records.find((r) => r.propId === "00000231091000000");
    expect(rec).toMatchObject({
      countyFips: "48113",
      taxYear: 2026,
      yearBuilt: 1924,
      livingAreaSqft: 5136,
      landValue: 1779190,
      improvementValue: 270810,
      marketValue: 2050000,
      assessedValue: 2050000,
      propertyUseCode: "A11",
    });
    expect(rec?.landAcres).not.toBeNull();
  });
});
