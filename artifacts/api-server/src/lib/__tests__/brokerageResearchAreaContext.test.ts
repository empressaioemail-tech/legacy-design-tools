import { describe, it, expect } from "vitest";
import {
  RESEARCH_AREA_CONTEXT,
  formatResearchAreaContextForLlm,
  formatSubjectConstraintsForLlm,
} from "../brokerageResearchAreaContext";

describe("formatResearchAreaContextForLlm — subject parcel constraints", () => {
  it("renders setbacks + envelope with the not-survey-grade qualifier when subject present", () => {
    const areaContext = RESEARCH_AREA_CONTEXT.parse({
      scope: "property",
      jurisdictionKey: "bastrop_tx",
      subject: {
        parcelNodeId: "node-123",
        address: "123 Main St",
        setbacks: {
          front_ft: 25,
          side_ft: 5,
          rear_ft: 10,
          district: "R-1",
        },
        envelope: {
          buildableAreaSqFt: 4200,
          buildableAreaPct: 38,
          maxHeightFt: 35,
          maxLotCoveragePct: 45,
          edgeSignal: "road",
          disclosure: "Envelope derived from published UDC dimensions.",
          citationUrl: "https://example.gov/udc",
        },
      },
    });

    const out = formatResearchAreaContextForLlm(areaContext);

    expect(out).toContain("SUBJECT PARCEL CONSTRAINTS");
    expect(out).toContain("approximate, not survey-grade — verify with city");
    expect(out).toContain("Zoning district: R-1");
    expect(out).toContain("front 25 ft");
    expect(out).toContain("side 5 ft");
    expect(out).toContain("rear 10 ft");
    expect(out).toContain("buildable area 4200 sqft (38% of lot)");
    expect(out).toContain("max height 35 ft");
    expect(out).toContain("max lot coverage 45%");
    expect(out).toContain("Front-edge inference: road");
    expect(out).toContain("Envelope derived from published UDC dimensions.");
    expect(out).toContain("Source: https://example.gov/udc");
    // Never emit a bare "null" for absent fields.
    expect(out).not.toContain("null");
  });

  it("skips null / absent fields without printing 'null ft'", () => {
    const out = formatSubjectConstraintsForLlm({
      setbacks: { front_ft: 25, side_ft: null, rear_ft: undefined, district: null },
      envelope: { maxHeightFt: 30 },
    });

    expect(out).toContain("Setbacks: front 25 ft");
    expect(out).not.toContain("side");
    expect(out).not.toContain("rear");
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("Zoning district");
    expect(out).toContain("max height 30 ft");
  });

  it("makes the hedge explicit when approximate or edgeSignal is shape/point", () => {
    const shapeOut = formatSubjectConstraintsForLlm({
      setbacks: { front_ft: 20 },
      envelope: { edgeSignal: "shape" },
    });
    expect(shapeOut).toContain("front edge inferred from parcel shape, lower confidence");

    const approxOut = formatSubjectConstraintsForLlm({
      envelope: { buildableAreaSqFt: 1000, approximate: true },
    });
    expect(approxOut).toContain("lower confidence");
  });

  it("returns empty subject block when subject absent (no crash)", () => {
    const areaContext = RESEARCH_AREA_CONTEXT.parse({
      scope: "area",
      visibleParcels: [{ parcelId: "p1", address: "1 A St" }],
    });

    const out = formatResearchAreaContextForLlm(areaContext);

    expect(out).not.toContain("SUBJECT PARCEL CONSTRAINTS");
    expect(out).toContain("Visible parcels");
    // Sanity: still renders the existing area context.
    expect(out).toContain("Scope: area");
  });

  it("returns empty string when subject present but has no usable fields", () => {
    expect(formatSubjectConstraintsForLlm(undefined)).toBe("");
    expect(formatSubjectConstraintsForLlm(null)).toBe("");
    expect(
      formatSubjectConstraintsForLlm({ parcelNodeId: "x", address: "y" }),
    ).toBe("");
  });
});
