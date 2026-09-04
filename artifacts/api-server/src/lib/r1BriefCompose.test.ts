/**
 * r1BriefCompose.ts — OPS-16 A-096/A-097/A-098 additions:
 * composeZoningBriefSectionFromParcelRecord and
 * composeSetbacksBriefSectionFromParcelRecord. No dedicated test file
 * existed for this module before this card (buildR1Brief's other branches
 * are covered indirectly via smartSiteStub.test.ts's "D2 stub is a
 * projection of node" suite) -- this file covers the two new functions
 * directly, matching this repo's own "compare old vs new for a sample" /
 * "honest absence never regresses to a worse state" test pattern for a
 * parcel_record cutover.
 */

import { describe, expect, it } from "vitest";
import {
  buildR1Brief,
  composeSetbacksBriefSectionFromParcelRecord,
  composeZoningBriefSectionFromParcelRecord,
} from "./r1BriefCompose";
import type { ZoningFactRead } from "./zoningFactFromParcelRecord";
import type { SetbacksFactRead } from "./setbacksFactFromParcelRecord";

describe("composeZoningBriefSectionFromParcelRecord", () => {
  it("present: a real district takes priority, disposition present, data carries district/jurisdictionKey/provenance", () => {
    const fact: ZoningFactRead = {
      state: "present",
      source: "zoning-fact-parcel-record",
      entityId: "48021:103387",
      district: "SF-1",
      jurisdictionKey: "bastrop_city_tx",
      provenance: "https://gis.example.test/zoning/bastrop",
      sourceAdapter: "parcel_record",
      sourceVintage: "2026-09-04T00:00:00.000Z",
      evaluatedAt: "2026-09-04T00:00:00.000Z",
    };
    const section = composeZoningBriefSectionFromParcelRecord(fact, null);
    expect(section.disposition).toBe("present");
    expect(section.data).toEqual({
      district: "SF-1",
      jurisdictionKey: "bastrop_city_tx",
      provenance: "https://gis.example.test/zoning/bastrop",
    });
  });

  it("THE LOAD-BEARING CASE: not-applicable stays disposition 'absent' (WDLL item 5 -- never a fifth section-level state) but data honestly carries the record's own verdict, distinct from a bare bake absence", () => {
    const fact: ZoningFactRead = {
      state: "absent",
      source: "zoning-fact-parcel-record",
      entityId: "48021:10001",
      absence: { kind: "not-applicable", reason: "unincorporated parcel -- no municipal zoning authority applies" },
      verifiedAbsence: null,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    };
    const section = composeZoningBriefSectionFromParcelRecord(fact, null);
    expect(section.disposition).toBe("absent");
    expect(section.data).toBe(fact);
    expect((section.data as ZoningFactRead & { state: "absent" }).absence.kind).toBe("not-applicable");
  });
});

describe("composeSetbacksBriefSectionFromParcelRecord", () => {
  it("present: real setback numbers, disposition present", () => {
    const fact: SetbacksFactRead = {
      state: "present",
      source: "setbacks-fact-parcel-record",
      entityId: "48021:103387",
      frontFt: 25,
      sideFt: 5,
      rearFt: 10,
      cornerFt: 15,
      sourceAdapter: "parcel_record",
      sourceVintage: "2026-09-04T00:00:00.000Z",
      evaluatedAt: "2026-09-04T00:00:00.000Z",
    };
    const section = composeSetbacksBriefSectionFromParcelRecord(fact, null);
    expect(section.disposition).toBe("present");
    expect(section.data).toEqual({ frontFt: 25, sideFt: 5, rearFt: 10, cornerFt: 15 });
  });

  it("THE LOAD-BEARING CASE: not-applicable stays disposition 'absent' but data honestly carries the record's own verdict", () => {
    const fact: SetbacksFactRead = {
      state: "absent",
      source: "setbacks-fact-parcel-record",
      entityId: "48021:10001",
      absence: { kind: "not-applicable", reason: "unincorporated parcel -- no municipal setback authority applies" },
      verifiedAbsence: null,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    };
    const section = composeSetbacksBriefSectionFromParcelRecord(fact, null);
    expect(section.disposition).toBe("absent");
    expect((section.data as SetbacksFactRead & { state: "absent" }).absence.kind).toBe("not-applicable");
  });
});

describe("buildR1Brief — zoning/setbacks OPS-16 A-096/A-097/A-098 wiring", () => {
  it("with no parcelRecordZoningFact/parcelRecordSetbacksFact supplied, behavior is byte-identical to before this card", () => {
    const facets = { zoning: { district: "SF-1" }, envelope: { status: "ok", geojson: {} } };
    const brief = buildR1Brief(facets, null);
    const zoningSection = brief.sections.find((s) => s.id === "zoning");
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(zoningSection?.disposition).toBe("present");
    expect(envelopeSection?.disposition).toBe("present");
  });

  it("a not-applicable zoning/setbacks record fact flips an otherwise-unknown parcel's section data, disposition staying absent", () => {
    const facets = { zoning: null, envelope: null };
    const zoningFact: ZoningFactRead = {
      state: "absent",
      source: "zoning-fact-parcel-record",
      entityId: "48021:10001",
      absence: { kind: "not-applicable", reason: "unincorporated" },
      verifiedAbsence: null,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    };
    const setbacksFact: SetbacksFactRead = {
      state: "absent",
      source: "setbacks-fact-parcel-record",
      entityId: "48021:10001",
      absence: { kind: "not-applicable", reason: "unincorporated" },
      verifiedAbsence: null,
      sourceTier: null,
      sourceAdapter: "parcel_record",
      sourceVintage: null,
    };
    const brief = buildR1Brief(facets, null, {
      parcelRecordZoningFact: zoningFact,
      parcelRecordSetbacksFact: setbacksFact,
    });
    const zoningSection = brief.sections.find((s) => s.id === "zoning");
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(zoningSection?.disposition).toBe("absent");
    expect(envelopeSection?.disposition).toBe("absent");
  });

  it("REGRESSION GUARD: a refused record fact falls through to the legacy bake-derived zoning, never regressing a parcel with a real bake answer", () => {
    const facets = { zoning: { district: "C-1", jurisdictionKey: "austin_tx" } };
    const zoningFact: ZoningFactRead = {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: "zoning-fact-parcel-record",
      entityId: "48021:1",
      reason: "malformed cell",
    };
    const brief = buildR1Brief(facets, null, { parcelRecordZoningFact: zoningFact });
    const zoningSection = brief.sections.find((s) => s.id === "zoning");
    expect(zoningSection?.disposition).toBe("present");
    expect(zoningSection?.data).toEqual(facets.zoning);
  });

  it("REGRESSION GUARD: a refused setbacks record fact falls through to the legacy bake-derived envelope section", () => {
    const facets = { envelope: { status: "ok", geojson: {} } };
    const setbacksFact: SetbacksFactRead = {
      state: "refused",
      code: "parcel-record-malformed-cell",
      source: "setbacks-fact-parcel-record",
      entityId: "48021:1",
      reason: "malformed cell",
    };
    const brief = buildR1Brief(facets, null, { parcelRecordSetbacksFact: setbacksFact });
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelopeSection?.disposition).toBe("present");
  });
});
