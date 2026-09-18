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

  /**
   * P-270 (OPS-24 X11): this block is the third site that formats a setback
   * citation, and it printed `- Source: <url>` with no vintage line at all —
   * a reader could copy that one line away and hold a citation with no
   * statement of how current it was. The declaration now renders BESIDE the
   * source line rather than only inside the disclosure paragraph above it.
   */
  it("P-270: a declared vintage renders on its own line beside the Source line", () => {
    const out = formatResearchAreaContextForLlm(
      RESEARCH_AREA_CONTEXT.parse({
        scope: "property",
        jurisdictionKey: "pflugerville_tx",
        subject: {
          parcelNodeId: "node-123",
          address: "123 Main St",
          envelope: {
            disclosure: "Estimated buildable area. Not survey grade.",
            citationUrl: "https://example.gov/udc",
            citationVintage: {
              kind: "setback-citation-vintage-unreadable",
              state: "unreadable-absent-at-source",
              sourceLabel: "codified setback table pflugerville-tx (City of Pflugerville)",
              citationUrl: "https://example.gov/udc",
              note: "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.",
            },
          },
        },
      }),
    );

    expect(out).toContain("Source: https://example.gov/udc");
    // Its own bullet, immediately after the source line it qualifies.
    expect(out).toContain(
      "- Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.",
    );
    const sourceIdx = out.indexOf("Source: https://example.gov/udc");
    const noteIdx = out.indexOf("Setback rule vintage unknown");
    expect(noteIdx).toBeGreaterThan(sourceIdx);
  });

  it("P-270: an undated payload renders no vintage line at all (a dated citation is untouched)", () => {
    const out = formatResearchAreaContextForLlm(
      RESEARCH_AREA_CONTEXT.parse({
        scope: "property",
        subject: {
          parcelNodeId: "node-123",
          address: "123 Main St",
          envelope: {
            disclosure: "Estimated buildable area. Not survey grade.",
            citationUrl: "https://example.gov/udc",
          },
        },
      }),
    );
    expect(out).toContain("Source: https://example.gov/udc");
    expect(out).not.toContain("vintage unknown");
  });

  it("renders parcel facts (acreage, living area, flood, land use) in the subject block", () => {
    const out = formatSubjectConstraintsForLlm({
      parcelFacts: {
        acreageAc: 0.21,
        acreageSqft: 9144,
        livingAreaSqft: 1850,
        floodZoneLabel: "Zone X",
        landUseCode: "A1",
        landUseDescription: "Single-family residential",
        zoningDistrict: "P-5",
      },
    });

    expect(out).toContain("Lot size: 0.21 ac (9,144 sqft)");
    expect(out).toContain("Living area: 1,850 sqft");
    expect(out).toContain("Flood zone: Zone X");
    expect(out).toContain("Land use: A1 — Single-family residential");
    expect(out).toContain("Zoning district: P-5");
    expect(out).not.toContain("null");
  });

  it("renders parcelFacts-only subject when setbacks/envelope are absent", () => {
    const out = formatSubjectConstraintsForLlm({
      parcelFacts: {
        acreageAc: 1.5,
        livingAreaSqft: 2200,
        floodZoneLabel: "Zone AE",
        landUseCode: "R1",
        landUseDescription: "Residential",
        zoningDistrict: "R-1",
      },
    });

    expect(out).toContain("SUBJECT PARCEL CONSTRAINTS");
    expect(out).toContain("Lot size: 1.5 ac");
    expect(out).toContain("Living area: 2,200 sqft");
    expect(out).not.toContain("Setbacks:");
    expect(out).not.toContain("Envelope:");
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
