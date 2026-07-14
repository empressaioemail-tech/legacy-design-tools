/**
 * cad:* Property Brief adapter tests — county appraisal-district slots
 * from the cad_property store. Fixture rows are real-shaped copies of
 * the Caldwell 2026 PACS export rows used by @workspace/cad-ingest's
 * parser tests (public record).
 */

import { describe, expect, it, vi } from "vitest";
import {
  CAD_ADAPTERS,
  CAD_OWNER_OCCUPANCY_METHOD,
  cadOwnerOccupancyAdapter,
  cadPropertyAdapter,
  cadTaxAdapter,
  compareMailingToSitus,
  decodeExemptionCode,
  deriveOwnerOccupancy,
  summarizeCadPayload,
} from "../local/cad";
import { runAdapters } from "../runner";
import { jsonResponse, arcgisEmpty } from "../__fixtures__/arcgisFixtures";
import type {
  AdapterContext,
  CadPropertyLookup,
  CadPropertyLookupRow,
} from "../types";

/** Real-shaped row: Caldwell CAD 2026 export, prop 10001 (no exemption data). */
const ROW_10001: CadPropertyLookupRow = {
  countyFips: "48055",
  propId: "10001",
  taxYear: 2026,
  ownerName: "HERNANDEZ-SOLIS J JESUS &",
  ownerMailingAddress: "RAMIREZ GILBERTA RAMIREZ, 15 SUNRISE ST, DALE, TX 78616-2586",
  situsAddress: "15 SUNRISE ST",
  situsCity: "DALE",
  situsZip: "78616",
  legalDescription: "O.T. LYTTON SPRINGS, BLOCK 21, ACRES 1.7716",
  exemptionCodes: null,
  landValue: 145090,
  improvementValue: 252170,
  marketValue: 397260,
  assessedValue: 397260,
  yearBuilt: 1962,
  livingAreaSqft: 1176,
  landAcres: "1.7716",
  propertyUseCode: "E1",
  sourceVintage: "2026-june-5",
};

/** Real-shaped row: Caldwell prop 10004 (homestead, HS-capped assessed). */
const ROW_10004: CadPropertyLookupRow = {
  ...ROW_10001,
  propId: "10004",
  ownerName: "SAMPLE HOMESTEAD OWNER",
  ownerMailingAddress: "200 OAK MEADOW DR, LOCKHART, TX 78644",
  situsAddress: "200 OAK MEADOW DR",
  situsCity: "LOCKHART",
  situsZip: "78644",
  exemptionCodes: ["HS", "OV65"],
  marketValue: 300700,
  assessedValue: 276670,
  yearBuilt: 2007,
  livingAreaSqft: 1228,
};

const CALDWELL_POINT = { latitude: 29.94, longitude: -97.57 }; // Dale, TX
const TRAVIS_POINT = { latitude: 30.2672, longitude: -97.7431 }; // Austin, TX
const BOULDER_POINT = { latitude: 40.0102, longitude: -105.2705 }; // Boulder, CO
const HOUSTON_POINT = { latitude: 29.7604, longitude: -95.3698 }; // Harris Co (unsupported)

function caldwellCtx(
  cadLookup: CadPropertyLookup,
  propId = "10001",
): AdapterContext {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("Caldwell_CAD_Parcel_Map")) {
      return jsonResponse({ features: [{ attributes: { Prop_ID: propId } }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return {
    parcel: { ...CALDWELL_POINT, state: "TX" },
    jurisdiction: { stateKey: "texas", localKey: null },
    fetchImpl,
    cadLookup,
  };
}

describe("cad:* adapters — happy path (Caldwell)", () => {
  it("emits populated property/tax/owner-occupancy layers from the store row", async () => {
    const cadLookup = vi.fn(async () => ROW_10001);
    const outcomes = await runAdapters({
      adapters: [...CAD_ADAPTERS],
      context: caldwellCtx(cadLookup),
    });
    const byKey = Object.fromEntries(outcomes.map((o) => [o.adapterKey, o]));

    for (const key of ["cad:property", "cad:tax", "cad:owner-occupancy"]) {
      expect(byKey[key].status, key).toBe("ok");
      // The specific CAD is named as the cited source.
      expect(byKey[key].result?.provider).toBe(
        "Caldwell County Appraisal District",
      );
      expect(byKey[key].result?.sourceKind).toBe("local-adapter");
      expect(byKey[key].result?.payload.sourceVintage).toBe("2026-june-5");
      expect(byKey[key].result?.payload.taxYear).toBe(2026);
    }
    // Accessor receives the county FIPS + the GIS-resolved prop id.
    expect(cadLookup).toHaveBeenCalledWith("48055", "10001");

    const property = byKey["cad:property"].result?.payload as Record<string, unknown>;
    expect(property.ownerName).toBe("HERNANDEZ-SOLIS J JESUS &");
    expect(property.situsAddress).toBe("15 SUNRISE ST");
    expect(property.legalDescription).toContain("O.T. LYTTON SPRINGS");
    expect(property.yearBuilt).toBe(1962);
    expect(property.livingAreaSqft).toBe(1176);
    expect(property.landAcres).toBeCloseTo(1.7716);
    expect(property.propertyUseCode).toBe("E1");
    expect(property.landValue).toBe(145090);
    expect(property.improvementValue).toBe(252170);
    expect(property.marketValue).toBe(397260);
    expect(property.valueBasis).toBe("county-assessed");

    const tax = byKey["cad:tax"].result?.payload as Record<string, unknown>;
    expect(tax.assessedValue).toBe(397260);
    expect(tax.exemptionCodes).toBeNull();

    const occ = byKey["cad:owner-occupancy"].result?.payload as Record<string, unknown>;
    // No exemption data (null) but the mailing line contains the situs
    // street — the disclosed comparison alone decides, weakly.
    expect(occ.signal).toBe("likely-owner-occupied");
    expect(occ.homesteadExemption).toBeNull();
    expect(occ.mailingMatchesSitus).toBe("same");
    expect(occ.method).toBe(CAD_OWNER_OCCUPANCY_METHOD);
  });

  it("routes Travis points to TCAD and normalizes numeric PROP_ID attributes", async () => {
    const cadLookup = vi.fn(async () => ({
      ...ROW_10001,
      countyFips: "48453",
      propId: "123456",
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("TCAD_public")) {
        return jsonResponse({ features: [{ attributes: { PROP_ID: 123456 } }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const outcomes = await runAdapters({
      adapters: [cadPropertyAdapter],
      context: {
        parcel: { ...TRAVIS_POINT, state: "TX" },
        jurisdiction: { stateKey: "texas", localKey: null },
        fetchImpl,
        cadLookup,
      },
    });
    expect(outcomes[0].status).toBe("ok");
    expect(outcomes[0].result?.provider).toBe(
      "Travis Central Appraisal District",
    );
    expect(cadLookup).toHaveBeenCalledWith("48453", "123456");
  });
});

describe("cad:* honesty labels", () => {
  it("labels values as county assessed figures, never an AVM / market estimate", async () => {
    const outcomes = await runAdapters({
      adapters: [cadPropertyAdapter, cadTaxAdapter],
      context: caldwellCtx(async () => ROW_10001),
    });
    const property = outcomes.find((o) => o.adapterKey === "cad:property");
    const tax = outcomes.find((o) => o.adapterKey === "cad:tax");

    const propertySummary = summarizeCadPayload(
      "cad-property",
      property?.result?.payload,
    );
    expect(propertySummary).toContain("CAD market value (assessed): $397,260");
    expect(propertySummary).toContain("(land $145,090 + improvements $252,170)");
    expect(propertySummary).toContain("Caldwell County Appraisal District 2026 roll");
    expect(propertySummary).not.toMatch(/AVM|market estimate|opinion of value/i);

    const taxSummary = summarizeCadPayload("cad-tax", tax?.result?.payload);
    expect(taxSummary).toContain("CAD assessed value $397,260 (tax year 2026)");
    expect(taxSummary).toContain("No exemptions on roll");
    expect(taxSummary).toContain("not a market estimate or tax bill");
  });

  it("decodes common exemption codes to human labels", async () => {
    const outcomes = await runAdapters({
      adapters: [cadTaxAdapter],
      context: caldwellCtx(async () => ROW_10004, "10004"),
    });
    const summary = summarizeCadPayload("cad-tax", outcomes[0].result?.payload);
    expect(summary).toContain("Exemptions: Homestead (HS), Over-65 (OV65)");
    expect(summary).toContain("CAD assessed value $276,670");

    expect(decodeExemptionCode("DV3")).toBe("Disabled veteran (50-69%)");
    expect(decodeExemptionCode("DVHS")).toBe("Disabled veteran homestead (100%)");
    expect(decodeExemptionCode("EX")).toBe("Exempt (total)");
    // Unknown codes pass through raw — no guessed labels.
    expect(decodeExemptionCode("SO")).toBe("SO");
  });

  it("owner-occupancy summary names the derivation method verbatim", async () => {
    const absenteeRow: CadPropertyLookupRow = {
      ...ROW_10001,
      exemptionCodes: [],
      ownerMailingAddress: "4800 GROVE DR, DALLAS, TX 75209",
    };
    const outcomes = await runAdapters({
      adapters: [cadOwnerOccupancyAdapter],
      context: caldwellCtx(async () => absenteeRow),
    });
    const summary = summarizeCadPayload(
      "cad-owner-occupancy",
      outcomes[0].result?.payload,
    );
    expect(summary).toContain("Likely absentee owner");
    expect(summary).toContain(
      "derived from CAD homestead exemption + mailing/situs comparison",
    );
    expect(summary).toContain("no homestead exemption");
    expect(summary).toContain("mailing differs from situs");
  });
});

describe("deriveOwnerOccupancy — table-driven", () => {
  const SITUS = "15 SUNRISE ST";
  const cases: Array<{
    name: string;
    exemptionCodes: string[] | null;
    mailing: string | null;
    situs: string | null;
    signal: string;
    cmp: string;
  }> = [
    {
      name: "HS present (mailing matches)",
      exemptionCodes: ["HS"],
      mailing: "15 SUNRISE ST, DALE, TX 78616",
      situs: SITUS,
      signal: "likely-owner-occupied",
      cmp: "same",
    },
    {
      name: "HS present wins over differing mailing (county-adjudicated)",
      exemptionCodes: ["HS"],
      mailing: "4800 GROVE DR, DALLAS, TX 75209",
      situs: SITUS,
      signal: "likely-owner-occupied",
      cmp: "different",
    },
    {
      name: "no HS + mailing differs => absentee",
      exemptionCodes: ["OV65"],
      mailing: "4800 GROVE DR, DALLAS, TX 75209",
      situs: SITUS,
      signal: "likely-absentee",
      cmp: "different",
    },
    {
      name: "no HS + mailing matches => conflicting, unknown",
      exemptionCodes: [],
      mailing: "15 SUNRISE ST, DALE, TX 78616",
      situs: SITUS,
      signal: "unknown",
      cmp: "same",
    },
    {
      name: "no HS + PO Box mailing (comparison unknown) => absentee on exemption leg alone",
      exemptionCodes: [],
      mailing: "PO BOX 19493, AUSTIN, TX 78760-9493",
      situs: SITUS,
      signal: "likely-absentee",
      cmp: "unknown",
    },
    {
      name: "exemption data missing + mailing differs => weak absentee",
      exemptionCodes: null,
      mailing: "4800 GROVE DR, DALLAS, TX 75209",
      situs: SITUS,
      signal: "likely-absentee",
      cmp: "different",
    },
    {
      name: "exemption data missing + mailing matches => weak owner-occupied",
      exemptionCodes: null,
      mailing: "15 SUNRISE ST, DALE, TX 78616",
      situs: SITUS,
      signal: "likely-owner-occupied",
      cmp: "same",
    },
    {
      name: "exemption data missing + mailing missing => unknown, never guessed",
      exemptionCodes: null,
      mailing: null,
      situs: SITUS,
      signal: "unknown",
      cmp: "unknown",
    },
    {
      name: "exemption data missing + situs missing => unknown, never guessed",
      exemptionCodes: null,
      mailing: "15 SUNRISE ST, DALE, TX 78616",
      situs: null,
      signal: "unknown",
      cmp: "unknown",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const derivation = deriveOwnerOccupancy({
        exemptionCodes: c.exemptionCodes,
        ownerMailingAddress: c.mailing,
        situsAddress: c.situs,
      });
      expect(derivation.signal).toBe(c.signal);
      expect(derivation.mailingMatchesSitus).toBe(c.cmp);
    });
  }
});

describe("compareMailingToSitus — conservative normalization", () => {
  it("treats suffix/punctuation variants as the same address", () => {
    expect(
      compareMailingToSitus("15 Sunrise Street, Dale, TX 78616", "15 SUNRISE ST"),
    ).toBe("same");
    expect(
      compareMailingToSitus("200 OAK MEADOW DRIVE LOCKHART TX", "200 Oak Meadow Dr"),
    ).toBe("same");
  });

  it("care-of prefix lines still match when the situs street is contained", () => {
    expect(
      compareMailingToSitus(
        "RAMIREZ GILBERTA RAMIREZ, 15 SUNRISE ST, DALE, TX 78616-2586",
        "15 SUNRISE ST",
      ),
    ).toBe("same");
  });

  it("different street segments compare as different", () => {
    expect(
      compareMailingToSitus("4800 GROVE DR, DALLAS, TX 75209", "15 SUNRISE ST"),
    ).toBe("different");
  });

  it("never guesses: PO boxes and missing sides are unknown", () => {
    expect(
      compareMailingToSitus("PO BOX 19493, AUSTIN, TX 78760-9493", "15 SUNRISE ST"),
    ).toBe("unknown");
    expect(compareMailingToSitus(null, "15 SUNRISE ST")).toBe("unknown");
    expect(compareMailingToSitus("15 SUNRISE ST, DALE, TX", null)).toBe("unknown");
    // No extractable house-number street segment on the mailing side.
    expect(compareMailingToSitus("C/O ACME PROPERTY MGMT", "15 SUNRISE ST")).toBe(
      "unknown",
    );
  });
});

describe("cad:* coverage gate", () => {
  const lookup: CadPropertyLookup = async () => ROW_10001;

  it("does not apply without the injected store accessor (engagement path)", () => {
    const ctx: AdapterContext = {
      parcel: { ...CALDWELL_POINT, state: "TX" },
      jurisdiction: { stateKey: "texas", localKey: null },
    };
    for (const adapter of CAD_ADAPTERS) {
      expect(adapter.appliesTo(ctx), adapter.adapterKey).toBe(false);
    }
  });

  it("does not apply outside the five supported counties (honest no-coverage)", async () => {
    for (const point of [BOULDER_POINT, HOUSTON_POINT]) {
      const ctx: AdapterContext = {
        parcel: { ...point },
        jurisdiction: { stateKey: null, localKey: null },
        cadLookup: lookup,
      };
      for (const adapter of CAD_ADAPTERS) {
        expect(adapter.appliesTo(ctx), `${adapter.adapterKey} ${point.latitude}`).toBe(
          false,
        );
      }
    }
    // Through the runner the skip surfaces as a no-coverage outcome.
    const outcomes = await runAdapters({
      adapters: [...CAD_ADAPTERS],
      context: {
        parcel: { ...BOULDER_POINT },
        jurisdiction: { stateKey: null, localKey: null },
        cadLookup: lookup,
      },
    });
    expect(outcomes).toHaveLength(3);
    for (const o of outcomes) {
      expect(o.status).toBe("no-coverage");
    }
  });

  it("rejects contexts whose resolved state contradicts Texas", () => {
    const ctx: AdapterContext = {
      parcel: { ...TRAVIS_POINT, state: "UT" },
      jurisdiction: { stateKey: "utah", localKey: null },
      cadLookup: lookup,
    };
    expect(cadPropertyAdapter.appliesTo(ctx)).toBe(false);
  });

  it("is no-coverage when the county GIS has no parcel at the point", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [cadPropertyAdapter],
      context: {
        parcel: { ...CALDWELL_POINT, state: "TX" },
        jurisdiction: { stateKey: "texas", localKey: null },
        fetchImpl,
        cadLookup: lookup,
      },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.message).toMatch(/No parcel at this point/);
  });

  it("is no-coverage when the county roll has not been ingested for the parcel", async () => {
    const outcomes = await runAdapters({
      adapters: [cadTaxAdapter],
      context: caldwellCtx(async () => null),
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.message).toMatch(
      /No Caldwell County Appraisal District roll row ingested/,
    );
  });
});

describe("cad:* store-backed counties (Hays/Comal via txgio_parcel)", () => {
  const SAN_MARCOS_POINT = { latitude: 29.8833, longitude: -97.9414 };

  /** Hays-shaped row (Orion ingest, PR #245/#246 conventions). */
  const HAYS_ROW: CadPropertyLookupRow = {
    ...ROW_10001,
    countyFips: "48209",
    propId: "12310",
    situsAddress: "707 UHLAND RD",
    situsCity: "SAN MARCOS",
    situsZip: "78666",
    ownerName: "DELEON FELIX",
  };

  function haysCtx(overrides: Partial<AdapterContext> = {}): AdapterContext {
    const fetchImpl = vi.fn(async () => {
      throw new Error("store-backed county must not hit the network");
    });
    return {
      parcel: { ...SAN_MARCOS_POINT, state: "TX" },
      jurisdiction: { stateKey: "texas", localKey: null },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cadLookup: async () => HAYS_ROW,
      parcelPointLookup: async () => ({
        propId: "12310",
        sourceUrl: "https://data.geographic.texas.gov/txgio-test",
      }),
      ...overrides,
    };
  }

  it("serves Hays via the injected geometry lookup — no network at all", async () => {
    const cadLookup = vi.fn(async () => HAYS_ROW);
    const parcelPointLookup = vi.fn(async () => ({
      propId: "12310",
      sourceUrl: "https://data.geographic.texas.gov/txgio-test",
    }));
    const outcomes = await runAdapters({
      adapters: [...CAD_ADAPTERS],
      context: haysCtx({ cadLookup, parcelPointLookup }),
    });
    for (const o of outcomes) {
      expect(o.status, o.adapterKey).toBe("ok");
      expect(o.result?.provider).toBe("Hays Central Appraisal District");
      const resolution = o.result?.payload.parcelResolution as Record<string, unknown>;
      expect(resolution.provider).toBe("txgio");
      expect(resolution.sourceUrl).toBe(
        "https://data.geographic.texas.gov/txgio-test",
      );
    }
    expect(parcelPointLookup).toHaveBeenCalledWith(
      "48209",
      SAN_MARCOS_POINT.latitude,
      SAN_MARCOS_POINT.longitude,
    );
    expect(cadLookup).toHaveBeenCalledWith("48209", "12310");
  });

  it("gates OFF when the geometry lookup is not injected (resolution impossible)", () => {
    const ctx = haysCtx({ parcelPointLookup: undefined });
    for (const adapter of CAD_ADAPTERS) {
      expect(adapter.appliesTo(ctx), adapter.adapterKey).toBe(false);
    }
    // The ArcGIS counties are unaffected by the missing injection.
    const caldwell: AdapterContext = {
      parcel: { ...CALDWELL_POINT, state: "TX" },
      jurisdiction: { stateKey: "texas", localKey: null },
      cadLookup: async () => ROW_10001,
    };
    expect(cadPropertyAdapter.appliesTo(caldwell)).toBe(true);
  });

  it("is an honest no-coverage when no ingested parcel contains the point", async () => {
    const outcomes = await runAdapters({
      adapters: [cadPropertyAdapter],
      context: haysCtx({ parcelPointLookup: async () => null }),
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.message).toMatch(
      /self-hosted Hays County parcel geometry \(TxGIO\/StratMap\)/,
    );
  });
});

describe("summarizeCadPayload dispatcher", () => {
  it("returns null for non-cad layer kinds and malformed payloads", () => {
    expect(summarizeCadPayload("fema-nfhl-flood-zone", { kind: "flood-zone" })).toBeNull();
    expect(summarizeCadPayload("cad-property", null)).toBeNull();
    expect(summarizeCadPayload("cad-property", { kind: "cad-tax" })).toBeNull();
  });
});
