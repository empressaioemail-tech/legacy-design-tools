import { describe, expect, it } from "vitest";
import {
  applyCadPropertyFactsToPayload,
  cadPropertyFactsFromRow,
  cadRollFieldToWire,
  cadRollFromCadProperty,
  cadRollFromClaim,
  cadRollToWire,
  cadRollWireHasPresentValue,
  cadRollWireThreeStatesHold,
  emptyCadRoll,
  gateBakedCadRollRecord,
  gateCadRollWireValuation,
  nonNegativeDollarOrNull,
  positiveDollarOrNull,
  positiveSqftOrNull,
  studioGatedCadRollValuationRefusal,
  CAD_ROLL_DOLLAR_FIELDS,
  type CadRollWire,
} from "../cadRollValue";
import { serializeTwinOnRecord } from "../twinOnRecordSerialize";

describe("cadRollValue", () => {
  it("cadRollFromCadProperty is the bake mapper; source is cad_property", () => {
    const baked = cadRollFromCadProperty({
      taxYear: 2025,
      marketValue: 397260,
      assessedValue: null,
      landValue: 80000,
      improvementValue: 0,
      livingAreaSqft: 2145,
    });
    expect(baked.marketValue?.source).toBe("cad_property");
    expect(baked.assessedValue).toBeNull();
    expect(baked.improvementValue).toEqual({
      v: 0,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    expect(emptyCadRoll().marketValue).toBeNull();
  });

  it("applyCadPropertyFactsToPayload writes cadRoll/year/legal and does not invent McLennan assessed", () => {
    const facts = cadPropertyFactsFromRow({
      taxYear: 2025,
      marketValue: 88000,
      assessedValue: null,
      landValue: 20000,
      improvementValue: 68000,
      livingAreaSqft: null,
      yearBuilt: null,
      legalDescription: "ABS 12",
      exemptionCodes: [],
    });
    const next = applyCadPropertyFactsToPayload(
      { zoning: { district: "SF-1" }, baseFacts: { apn: "1", landUse: { code: "A1" } } },
      facts,
    );
    expect(next.zoning).toEqual({ district: "SF-1" });
    const bf = next.baseFacts as {
      cadRoll: { assessedValue: unknown; marketValue: { v: number } };
      yearBuilt: unknown;
      legalDescription: { v: string };
      exemptionCodes: unknown;
    };
    expect(bf.cadRoll.marketValue.v).toBe(88000);
    expect(bf.cadRoll.assessedValue).toBeNull();
    expect(bf.yearBuilt).toBeNull();
    expect(bf.legalDescription.v).toBe("ABS 12");
    expect(bf.exemptionCodes).toBeNull();
  });

  it("nonNegativeDollarOrNull / positiveDollarOrNull keep stored 0; reject null and negative", () => {
    expect(nonNegativeDollarOrNull(null)).toBeNull();
    expect(nonNegativeDollarOrNull(-1)).toBeNull();
    expect(nonNegativeDollarOrNull(0)).toBe(0);
    expect(nonNegativeDollarOrNull("0")).toBe(0);
    expect(nonNegativeDollarOrNull("100000")).toBe(100000);
    expect(positiveDollarOrNull(0)).toBe(0);
    expect(positiveDollarOrNull(null)).toBeNull();
  });

  it("positiveSqftOrNull rejects null, zero, and negative; 0 sqft is not a measured floor", () => {
    expect(positiveSqftOrNull(null)).toBeNull();
    expect(positiveSqftOrNull(0)).toBeNull();
    expect(positiveSqftOrNull(-1)).toBeNull();
    expect(positiveSqftOrNull("2145")).toBe(2145);
  });

  it("cadRollFromClaim maps present values with source and vintage", () => {
    const baked = cadRollFromClaim({
      taxYear: 2025,
      marketValue: 397260,
      assessedValue: 397260,
      landValue: 80000,
      improvementValue: 317260,
      livingAreaSqft: 2145,
    });
    expect(baked.marketValue).toEqual({
      v: 397260,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    expect(baked.livingAreaSqft).toEqual({
      v: 2145,
      source: "cad_property",
      vintage: "2025",
    });
  });

  it("cadRollFromClaim bakes a present-0 dollar as { v: 0 }, not null; missing stays null; 0 sqft stays null", () => {
    const baked = cadRollFromClaim({
      taxYear: 2026,
      marketValue: null,
      assessedValue: 0,
      landValue: null,
      improvementValue: 0,
      livingAreaSqft: 0,
    });
    expect(baked.marketValue).toBeNull();
    expect(baked.landValue).toBeNull();
    expect(baked.assessedValue).toEqual({
      v: 0,
      source: "cad_property",
      vintage: "2026",
      valueBasis: "county-assessed",
    });
    expect(baked.improvementValue).toEqual({
      v: 0,
      source: "cad_property",
      vintage: "2026",
      valueBasis: "county-assessed",
    });
    expect(baked.livingAreaSqft).toBeNull();
  });
});

describe("cadRoll falsifier (both arms)", () => {
  const parcelNodeId = "48021:34137";

  it("arm A: key present v=0 serializes state zero, not absent (vacant-lot improvementValue)", () => {
    const baked = cadRollFromClaim({
      taxYear: 2025,
      marketValue: 80000,
      assessedValue: 80000,
      landValue: 80000,
      improvementValue: 0,
      livingAreaSqft: 0,
    });
    expect(baked.improvementValue).toEqual({
      v: 0,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    const wire = cadRollToWire(baked, parcelNodeId, "2025");
    expect(wire.improvementValue).toMatchObject({
      state: "zero",
      v: 0,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    expect(wire.livingAreaSqft.state).toBe("absent");
    expect((wire.livingAreaSqft as { v?: unknown }).v).toBeUndefined();
    expect(cadRollWireThreeStatesHold(wire)).toBe(true);
  });

  it("arm A per field: assessed / market / land at stored 0 are state zero, not absent", () => {
    const baked = cadRollFromClaim({
      taxYear: 2025,
      marketValue: 0,
      assessedValue: 0,
      landValue: 0,
      improvementValue: 0,
      livingAreaSqft: null,
    });
    const wire = cadRollToWire(baked, parcelNodeId, "2025");
    expect(wire.marketValue).toMatchObject({ state: "zero", v: 0 });
    expect(wire.assessedValue).toMatchObject({ state: "zero", v: 0 });
    expect(wire.landValue).toMatchObject({ state: "zero", v: 0 });
    expect(wire.improvementValue).toMatchObject({ state: "zero", v: 0 });
    if (wire.landValue.state === "zero") {
      expect(wire.landValue.basis).toContain(parcelNodeId);
      expect(wire.landValue.basis).toContain("$0 land looks like missing");
    }
    expect(wire.livingAreaSqft.state).toBe("absent");
    expect(cadRollWireThreeStatesHold(wire)).toBe(true);
  });

  it("arm B: key absent serializes state absent with basis, never v=0", () => {
    const baked = cadRollFromClaim({
      taxYear: 2025,
      marketValue: null,
      assessedValue: null,
      landValue: null,
      improvementValue: null,
      livingAreaSqft: null,
    });
    const wire = cadRollToWire(baked, parcelNodeId, "2025");
    expect(cadRollWireHasPresentValue(wire)).toBe(false);
    for (const field of Object.values(wire)) {
      expect(field.state).toBe("absent");
      if (field.state === "absent") {
        expect(field.basis).toContain(parcelNodeId);
        expect((field as { v?: unknown }).v).toBeUndefined();
      }
    }
    expect(cadRollWireThreeStatesHold(wire)).toBe(true);
  });

  it("arm B field: missing bake key is absent, not state zero", () => {
    const field = cadRollFieldToWire(null, "marketValue", parcelNodeId, "2025", true);
    expect(field.state).toBe("absent");
    expect((field as { v?: unknown }).v).toBeUndefined();
    if (field.state === "absent") {
      expect(field.basis).toContain("marketValue");
    }
  });

  it("arm 1 leftover: parcel with known CAD values shows present wire with source+vintage", () => {
    const baked = cadRollFromClaim({
      taxYear: 2025,
      marketValue: 100000,
      assessedValue: 100000,
      landValue: 10000,
      improvementValue: 90000,
      livingAreaSqft: 1200,
    });
    const wire = cadRollToWire(baked, parcelNodeId, "2025");
    expect(cadRollWireHasPresentValue(wire)).toBe(true);
    expect(wire.marketValue).toMatchObject({
      state: "present",
      v: 100000,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    expect(cadRollWireThreeStatesHold(wire)).toBe(true);
  });

  it("multi-county: Travis present, Bastrop all-null, vacant-lot improvementValue 0", () => {
    const travis = cadRollToWire(
      cadRollFromClaim({
        taxYear: 2026,
        marketValue: 850000,
        assessedValue: 850000,
        landValue: 200000,
        improvementValue: 650000,
        livingAreaSqft: 2800,
      }),
      "48453:493738",
      "2026",
    );
    const bastrop = cadRollToWire(
      cadRollFromClaim({
        taxYear: 2025,
        marketValue: null,
        assessedValue: null,
        landValue: null,
        improvementValue: null,
        livingAreaSqft: null,
      }),
      "48021:34137",
      "2025",
    );
    const vacantLot = cadRollToWire(
      cadRollFromClaim({
        taxYear: 2025,
        marketValue: 45000,
        assessedValue: 45000,
        landValue: 45000,
        improvementValue: 0,
        livingAreaSqft: null,
      }),
      "48021:26553",
      "2025",
    );
    expect(travis.marketValue.state).toBe("present");
    expect(bastrop.marketValue.state).toBe("absent");
    expect(vacantLot.improvementValue.state).toBe("zero");
    expect(vacantLot.improvementValue).toMatchObject({ v: 0 });
    expect(vacantLot.livingAreaSqft.state).toBe("absent");
    expect(cadRollWireThreeStatesHold(travis)).toBe(true);
    expect(cadRollWireThreeStatesHold(bastrop)).toBe(true);
    expect(cadRollWireThreeStatesHold(vacantLot)).toBe(true);
  });

  it("cadRollWireThreeStatesHold fails on known violations (check verified by violating)", () => {
    const presentZero = {
      marketValue: { state: "present" as const, v: 0, source: "cad_property" as const, vintage: "2025", valueBasis: "county-assessed" as const },
      assessedValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      landValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      improvementValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      livingAreaSqft: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
    } as unknown as CadRollWire;
    expect(cadRollWireThreeStatesHold(presentZero)).toBe(false);

    const absentWithV = {
      marketValue: { state: "absent" as const, v: 0, source: "cad_property" as const, vintage: "2025", basis: "x" },
      assessedValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      landValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      improvementValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      livingAreaSqft: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
    } as unknown as CadRollWire;
    expect(cadRollWireThreeStatesHold(absentWithV)).toBe(false);

    const zeroWrongV = {
      marketValue: { state: "zero" as const, v: 1, source: "cad_property" as const, vintage: "2025", valueBasis: "county-assessed" as const },
      assessedValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      landValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      improvementValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      livingAreaSqft: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
    } as unknown as CadRollWire;
    expect(cadRollWireThreeStatesHold(zeroWrongV)).toBe(false);

    const sqftZero = {
      marketValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      assessedValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      landValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      improvementValue: { state: "absent" as const, source: "cad_property" as const, vintage: "2025", basis: "x" },
      livingAreaSqft: { state: "zero" as const, v: 0, source: "cad_property" as const, vintage: "2025" },
    } as CadRollWire;
    expect(cadRollWireThreeStatesHold(sqftZero)).toBe(false);
  });
});

describe("serializeTwinOnRecord (WDLL S1 customer-facing)", () => {
  it("projects apn, acreage, county, situsState, and cadRoll from baked facets", () => {
    const onRecord = serializeTwinOnRecord(
      {
        countyFips: "48021",
        countyName: "Bastrop",
        bakedAt: "2026-08-31T12:00:00.000Z",
        provenance: { parcelVintage: "2025" },
        baseFacts: {
          apn: "34137",
          situsState: "TX",
          acreage: { value: 0.3815, sqft: 16616, method: "cad-roll-land-acres" },
          cadRoll: cadRollFromClaim({
            taxYear: 2025,
            marketValue: 100000,
            assessedValue: 100000,
            landValue: 10000,
            improvementValue: 90000,
            livingAreaSqft: 1200,
          }),
        },
      },
      "48021:34137",
      true,
    );
    expect(onRecord.apn).toBe("34137");
    expect(onRecord.countyFips).toBe("48021");
    expect(onRecord.countyName).toBe("Bastrop");
    expect(onRecord.situsState).toBe("TX");
    expect(onRecord.acreage?.method).toBe("cad-roll-land-acres");
    expect(onRecord.cadRoll.marketValue.state).toBe("present");
  });

  it("vacant-lot onRecord: improvementValue state zero, livingAreaSqft absent", () => {
    const onRecord = serializeTwinOnRecord(
      {
        countyFips: "48021",
        countyName: "Bastrop",
        bakedAt: "2026-09-01T00:00:00.000Z",
        provenance: { parcelVintage: "2025" },
        baseFacts: {
          apn: "vacant",
          situsState: "TX",
          cadRoll: cadRollFromClaim({
            taxYear: 2025,
            marketValue: 45000,
            assessedValue: 45000,
            landValue: 45000,
            improvementValue: 0,
            livingAreaSqft: 0,
          }),
        },
      },
      "48021:vacant",
      true,
    );
    expect(onRecord.cadRoll.improvementValue.state).toBe("zero");
    expect(onRecord.cadRoll.improvementValue).toMatchObject({ v: 0 });
    expect(onRecord.cadRoll.livingAreaSqft.state).toBe("absent");
    expect(cadRollWireThreeStatesHold(onRecord.cadRoll as CadRollWire)).toBe(true);
  });

  it("refused caller (grantsCadRollValuation=false) gets a studio-gated refusal on all four dollar fields, livingAreaSqft untouched", () => {
    const onRecord = serializeTwinOnRecord(
      {
        countyFips: "48021",
        countyName: "Bastrop",
        bakedAt: "2026-09-05T00:00:00.000Z",
        provenance: { parcelVintage: "2025" },
        baseFacts: {
          apn: "34137",
          situsState: "TX",
          cadRoll: cadRollFromClaim({
            taxYear: 2025,
            marketValue: 100000,
            assessedValue: 100000,
            landValue: 10000,
            improvementValue: 90000,
            livingAreaSqft: 1200,
          }),
        },
      },
      "48021:34137",
      false,
    );
    for (const field of CAD_ROLL_DOLLAR_FIELDS) {
      expect(onRecord.cadRoll[field]).toEqual({
        state: "refused",
        code: "studio-gated",
        reason: expect.any(String),
      });
    }
    // livingAreaSqft is not a dollar field and must never be gated.
    expect(onRecord.cadRoll.livingAreaSqft.state).toBe("present");
    expect(onRecord.cadRoll.livingAreaSqft).toMatchObject({ v: 1200 });
  });
});

describe("CAD roll valuation gate (OPS-16 A-103 item 5 / A-104)", () => {
  it("studioGatedCadRollValuationRefusal is a stable typed refusal", () => {
    const refusal = studioGatedCadRollValuationRefusal();
    expect(refusal.state).toBe("refused");
    expect(refusal.code).toBe("studio-gated");
    expect(typeof refusal.reason).toBe("string");
    expect(refusal.reason.length).toBeGreaterThan(0);
  });

  it("gateCadRollWireValuation passes a granted wire through unchanged (same reference)", () => {
    const wire = cadRollToWire(
      cadRollFromClaim({
        taxYear: 2025,
        marketValue: 100000,
        assessedValue: 100000,
        landValue: 10000,
        improvementValue: 90000,
        livingAreaSqft: 1200,
      }),
      "48021:34137",
      "2025",
    );
    expect(gateCadRollWireValuation(wire, true)).toBe(wire);
  });

  it("gateCadRollWireValuation replaces every dollar field, including a zero/absent one, and never touches livingAreaSqft", () => {
    const wire = cadRollToWire(
      cadRollFromClaim({
        taxYear: 2025,
        marketValue: 100000,
        assessedValue: null,
        landValue: 45000,
        improvementValue: 0,
        livingAreaSqft: 1200,
      }),
      "48021:34137",
      "2025",
    );
    const gated = gateCadRollWireValuation(wire, false);
    for (const field of CAD_ROLL_DOLLAR_FIELDS) {
      expect(gated[field]).toEqual({
        state: "refused",
        code: "studio-gated",
        reason: expect.any(String),
      });
    }
    expect(gated.livingAreaSqft).toEqual(wire.livingAreaSqft);
  });

  it("gateBakedCadRollRecord replaces only the dollar keys that are actually present on a mixed baked/overlay record", () => {
    const cadRoll = {
      marketValue: { v: 100000, source: "cad_property", vintage: "2025", valueBasis: "county-assessed" },
      // Simulates a field the live overlay already replaced with a wire-shaped value.
      assessedValue: { state: "present", v: 100000, source: "cad_property", vintage: "2025" },
      landValue: null,
      // improvementValue deliberately omitted -- must not be invented.
      livingAreaSqft: { v: 1200, source: "cad_property", vintage: "2025" },
    };
    const gated = gateBakedCadRollRecord(cadRoll, false);
    expect(gated.marketValue).toEqual(studioGatedCadRollValuationRefusal());
    expect(gated.assessedValue).toEqual(studioGatedCadRollValuationRefusal());
    expect(gated.landValue).toEqual(studioGatedCadRollValuationRefusal());
    expect("improvementValue" in gated).toBe(false);
    expect(gated.livingAreaSqft).toEqual(cadRoll.livingAreaSqft);
  });

  it("gateBakedCadRollRecord is a no-op when granted", () => {
    const cadRoll = {
      marketValue: { v: 100000, source: "cad_property", vintage: "2025", valueBasis: "county-assessed" },
    };
    expect(gateBakedCadRollRecord(cadRoll, true)).toBe(cadRoll);
  });
});
