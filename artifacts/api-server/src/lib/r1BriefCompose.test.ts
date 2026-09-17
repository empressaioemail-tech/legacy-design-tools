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

  /**
   * P-297 / A-193 (operator ruling, 2026-09-16). INVERTED, NOT DELETED: this
   * guard used to assert the opposite -- "a refused record fact falls through
   * to the legacy bake-derived zoning, never regressing a parcel with a real
   * bake answer". That fall-through was the pre-ruling policy
   * (`_decisions/2026-09-16_county_verdict_is_not_the_serve_switch.md`: "a
   * refused or unaccounted cell is served as a declared refusal with the
   * cell's reason ... the legacy or baked value is never the answer for a
   * slated rail"), and the ruling names it as the defect. The assertion is
   * rewritten so the file still says what the section is required to do.
   */
  it("P-297: a refused record fact is a DECLARED REFUSAL with the cell's reason, never the bake-derived zoning", () => {
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
    expect(zoningSection?.disposition).toBe("refused");
    // The bake's own answer is NOT served for the rail, and the reason travels.
    expect(zoningSection?.data).toBeNull();
    expect(zoningSection?.reason).toBe("malformed cell");
    expect(zoningSection?.refusal).toMatchObject({ state: "refused", code: "parcel-record-malformed-cell" });
  });

  /** Setbacks' own mirror of the flipped zoning guard above -- same ruling, same reason. */
  it("P-297: a refused setbacks record fact is a DECLARED REFUSAL, never the bake-derived envelope section", () => {
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
    expect(envelopeSection?.disposition).toBe("refused");
    expect(envelopeSection?.data).toBeNull();
    expect(envelopeSection?.reason).toBe("malformed cell");
  });
});

describe("buildR1Brief — P-154 wave 6 conflict row (R-1, A-148)", () => {
  /** The live Bastrop shape: ONE current layer, unrefreshed numeric shortcut columns. */
  const CONFLICT = {
    shape: "stale-numeric-columns",
    secondSourceLabel: "One Click card",
    numeric: { front: 25, side: 5, rear: 25 },
    text: { front: 30, side: 10, rear: 30, corner: 20 },
    ordinance: "2026-06",
    confirmedWith: "the City of Bastrop",
    confirmedOn: "2026-09-14",
  } as const;

  it("prints the A-148 sentence beside the raw rail when the two sources disagree", () => {
    const facets = {
      envelope: {
        status: "ok",
        setbacks: { front_ft: 30, side_ft: 10, rear_ft: 30, side_corner_ft: 20 },
        secondSource: { source: "One Click card", note: "raw technical disclosure", conflict: CONFLICT },
      },
    };
    const brief = buildR1Brief(facets, null);
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelopeSection?.disposition).toBe("present");
    // Character for character the sentence the wave-6 dispatch fixes: the
    // panel, this MCP read and the PDF must all print it identically.
    expect((envelopeSection?.data as { conflictNote?: string }).conflictNote).toBe(
      "The city's One Click card shows 25/5/25 from unrefreshed numeric columns of its zoning layer; the same layer's text and Ordinance 2026-06 say 30/10/30/20 (confirmed with the City of Bastrop 2026-09-14)",
    );
    // The raw rail is left untouched beside the composed sentence.
    expect(
      (envelopeSection?.data as { secondSource?: { note?: string } }).secondSource?.note,
    ).toBe("raw technical disclosure");
  });

  it("FALSIFIER: a second source that agrees adds no note at all", () => {
    const facets = {
      envelope: {
        status: "ok",
        setbacks: { front_ft: 30, side_ft: 10, rear_ft: 30 },
        secondSource: { source: "Zoned Parcels layer", note: "agrees with the ordinance text" },
      },
    };
    const brief = buildR1Brief(facets, null);
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(Object.keys(envelopeSection?.data as object)).not.toContain("conflictNote");
  });

  it("GRACEFUL ABSENCE: an envelope with no second source is returned unchanged", () => {
    const envelope = { status: "ok", setbacks: { front_ft: 30, side_ft: 10, rear_ft: 30 } };
    const brief = buildR1Brief({ envelope }, null);
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelopeSection?.data).toEqual(envelope);
  });
});
