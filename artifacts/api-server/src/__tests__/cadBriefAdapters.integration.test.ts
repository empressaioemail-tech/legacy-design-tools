/**
 * cad:* brief adapters against a REAL local Postgres — proves the
 * api-server accessor injection end to end: seed `cad_property` rows,
 * build `makeCadPropertyLookup` over the test schema, run the real
 * (unmocked) adapter runner with the real accessor + a stubbed county
 * GIS fetch, and assert the three brief layers emerge populated.
 *
 * Same withTestSchema harness as the #245 cad-ingest integration suite.
 * Skipped when no DATABASE_URL / TEST_DATABASE_URL is available locally;
 * CI always provides one.
 */

import { describe, expect, it, vi } from "vitest";
import { withTestSchema } from "@workspace/db/testing";
import { cadProperty } from "@workspace/db/schema";
import { runAdapters } from "@workspace/adapters";
import { CAD_ADAPTERS, summarizeCadPayload } from "@workspace/adapters/local/cad";
import { makeCadPropertyLookup, normalizeCadPropId } from "../lib/cadPropertyLookup";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

/** Real-shaped Caldwell CAD 2026 rows (see @workspace/cad-ingest fixtures). */
const SEED_ROWS = [
  {
    countyFips: "48055",
    propId: "10001",
    taxYear: 2025,
    ownerName: "PRIOR-YEAR OWNER (must not win)",
    ownerMailingAddress: "15 SUNRISE ST, DALE, TX 78616",
    situsAddress: "15 SUNRISE ST",
    situsCity: "DALE",
    situsZip: "78616",
    legalDescription: "O.T. LYTTON SPRINGS",
    exemptionCodes: null,
    landValue: 120000,
    improvementValue: 200000,
    marketValue: 320000,
    assessedValue: 320000,
    yearBuilt: 1962,
    livingAreaSqft: 1176,
    landAcres: "1.7716",
    propertyUseCode: "E1",
    sourceFile: "caldwell_2025.txt",
    sourceVintage: "2025-certified",
  },
  {
    countyFips: "48055",
    propId: "10001",
    taxYear: 2026,
    ownerName: "HERNANDEZ-SOLIS J JESUS &",
    ownerMailingAddress:
      "RAMIREZ GILBERTA RAMIREZ, 15 SUNRISE ST, DALE, TX 78616-2586",
    situsAddress: "15 SUNRISE ST",
    situsCity: "DALE",
    situsZip: "78616",
    legalDescription: "O.T. LYTTON SPRINGS, BLOCK 21, ACRES 1.7716",
    exemptionCodes: ["HS"],
    landValue: 145090,
    improvementValue: 252170,
    marketValue: 397260,
    assessedValue: 397260,
    yearBuilt: 1962,
    livingAreaSqft: 1176,
    landAcres: "1.7716",
    propertyUseCode: "E1",
    sourceFile: "caldwell_appraisal_info_sample.txt",
    sourceVintage: "2026-june-5",
  },
];

/** Dale, TX — inside the Caldwell routing bbox. */
const DALE_POINT = { latitude: 29.94, longitude: -97.57 };

describe.skipIf(!hasDb)("cad:* adapters over a real cad_property store", () => {
  it("seeds a row and produces the three populated brief layers via runAdapters + the real accessor", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(cadProperty).values(SEED_ROWS);

      const cadLookup = makeCadPropertyLookup(db);

      // County GIS point lookup stubbed (exit-bounded test, no live
      // network); everything after the propId resolution is real.
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("Caldwell_CAD_Parcel_Map")) {
          return new Response(
            // Zero-padded PACS-style id — exercises normalizeCadPropId.
            JSON.stringify({ features: [{ attributes: { Prop_ID: "000010001" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      });

      const outcomes = await runAdapters({
        adapters: [...CAD_ADAPTERS],
        context: {
          parcel: { ...DALE_POINT, state: "TX" },
          jurisdiction: { stateKey: "texas", localKey: null },
          fetchImpl,
          cadLookup,
        },
      });

      const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));
      for (const key of ["cad:property", "cad:tax", "cad:owner-occupancy"]) {
        expect(byKey[key]?.status, key).toBe("ok");
        expect(byKey[key]?.result?.provider).toBe(
          "Caldwell County Appraisal District",
        );
      }

      // Latest tax year (2026) wins over the seeded 2025 row.
      const property = byKey["cad:property"].result?.payload as Record<string, unknown>;
      expect(property.taxYear).toBe(2026);
      expect(property.ownerName).toBe("HERNANDEZ-SOLIS J JESUS &");
      expect(property.marketValue).toBe(397260);
      expect(property.sourceVintage).toBe("2026-june-5");
      expect(property.valueBasis).toBe("county-assessed");

      const tax = byKey["cad:tax"].result?.payload as Record<string, unknown>;
      expect(tax.assessedValue).toBe(397260);
      expect(tax.exemptions).toEqual([{ code: "HS", label: "Homestead" }]);

      const occ = byKey["cad:owner-occupancy"].result?.payload as Record<string, unknown>;
      expect(occ.signal).toBe("likely-owner-occupied");
      expect(occ.homesteadExemption).toBe(true);

      // The summaries the brief renders carry the honesty labels.
      expect(summarizeCadPayload("cad-property", property)).toContain(
        "CAD market value (assessed): $397,260",
      );
      expect(summarizeCadPayload("cad-owner-occupancy", occ)).toContain(
        "derived from CAD homestead exemption + mailing/situs comparison",
      );
    });
  });

  it("is an honest no-coverage when the parcel has no ingested roll row", async () => {
    await withTestSchema(async ({ db }) => {
      const cadLookup = makeCadPropertyLookup(db);
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ features: [{ attributes: { Prop_ID: "99999" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      const outcomes = await runAdapters({
        adapters: [...CAD_ADAPTERS],
        context: {
          parcel: { ...DALE_POINT, state: "TX" },
          jurisdiction: { stateKey: "texas", localKey: null },
          fetchImpl,
          cadLookup,
        },
      });
      for (const o of outcomes) {
        expect(o.status).toBe("no-coverage");
        expect(o.error?.message).toMatch(/roll row ingested/);
      }
    });
  });

  it("normalizeCadPropId mirrors the ingest-side stripLeadingZeros", () => {
    expect(normalizeCadPropId("000010001")).toBe("10001");
    expect(normalizeCadPropId(" 10001 ")).toBe("10001");
    expect(normalizeCadPropId("R-12345")).toBe("R-12345");
    expect(normalizeCadPropId("0")).toBe("0");
  });
});
