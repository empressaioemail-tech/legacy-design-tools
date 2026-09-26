/**
 * P-458 part 2. Customer words on the card, and the prose check that fires
 * on the text today's main card prints.
 */
import { describe, expect, it } from "vitest";
import { customerProseViolations } from "../scripts/artifact-html-gate/prose-violations.mjs";
import { ptadLandUseDescription } from "../../api-server/src/lib/ptadLandUse";
import {
  customerSitus,
  edgeCaption,
  floodFactsHtml,
  frameNoteHtml,
  groundCreditText,
  landUseCustomerName,
  landUseNameFromCode,
  overlayCustomerLabel,
  overlayRowHtml,
  parcelFactSubheadHtml,
  ringSvg,
  type BriefSection,
  type DrawEdge,
  type OverlayRow,
} from "../src/card/panel-lib";

const MAIN_CARD_PROSE = `1305 FAYETTE ST , BASTROP, TX 78602
Zoning SF-1 · Land use C1 · Flood A
48021:32342
bastrop_city_tx
50 ft unit reference
Aerial: Esri World Imagery, capture date unstated. Mapbox held: Claude iframe origin is {32-hex}.claudemcpcontent.com
side_corner · ROW · 48021:road:1179615911 · 176.66 ft
citation degraded
vintage 2026-09-02T14:46:32.344Z provenance present
source adapter unstated
No pipeline within 500 ft
`;

describe("customer prose gate", () => {
  it("fires on the text the live main card printed for 48021:32342", () => {
    const found = customerProseViolations(MAIN_CARD_PROSE, "48021:32342");
    const kinds = new Set(found.map((v) => v.kind));
    expect(kinds.has("snake_case")).toBe(true);
    expect(kinds.has("adapter")).toBe(true);
    expect(kinds.has("degraded")).toBe(true);
    expect(kinds.has("iso_timestamp")).toBe(true);
    expect(kinds.has("entity_id")).toBe(true);
  });

  it("allows the parcel id on its own line and a cleaned card", () => {
    const clean = `1305 FAYETTE ST, BASTROP, TX 78602
Zoning SF-1 · Land use Vacant lot or tract · Flood zone A
48021:32342
Bastrop
Zone A
read at a point on the parcel
corner side · right of way · gravel road · 176.66 ft
Not known whether a pipeline is within 500 ft
Mapbox © Mapbox © OpenStreetMap © Maxar Improve this map
`;
    expect(customerProseViolations(clean, "48021:32342")).toEqual([]);
  });
});

describe("card plain words", () => {
  it("prints the city name and not the producer key", () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const named = ringSvg(ring, [], {
      zoning: { v: "SF-1", jurisdiction: "Bastrop", state: "present", url: null },
    });
    const keyed = ringSvg(ring, [], {
      zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present", url: null },
    });
    expect(named).toContain(">Bastrop</text>");
    expect(keyed).not.toContain("bastrop_city_tx");
  });

  it("draws the modelled envelope and does not print an area", () => {
    const ring = [
      { x: -80, y: -80 },
      { x: 80, y: -80 },
      { x: 80, y: 80 },
      { x: -80, y: 80 },
    ];
    const svg = ringSvg(ring, [], {
      envelope: [
        { x: -40, y: -40 },
        { x: 40, y: -40 },
        { x: 40, y: 40 },
        { x: -40, y: 40 },
      ],
    });
    expect(svg).toContain('data-envelope="modelled"');
    expect(svg).not.toMatch(/\barea\b/i);
    const outlineMissing = ringSvg([], [], {
      envelope: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 12 },
      ],
    });
    expect(outlineMissing).toContain('data-envelope="modelled"');
    expect(outlineMissing).not.toContain("ring-fill");
    expect(svg).not.toMatch(/\d+(\.\d+)?%/);
  });

  it("says a point read and makes SFHA agree with the overlay", () => {
    const section = {
      id: "flood",
      title: "Flood",
      disposition: "present",
      asOf: "NFHL_48_20260101",
      data: {
        floodZone: "A",
        method: "point-on-surface",
        sourceVintage: "NFHL_48_20260101",
      },
      citations: [],
      citationsDegraded: true,
      paint: "present",
    } as BriefSection;
    const html = floodFactsHtml(section, 0, true);
    expect(html).toContain("a point on the parcel");
    expect(html).toContain("SFHA</span> yes");
    expect(html).not.toContain("adapter");
    expect(html).not.toContain("NFHL_");
    expect(html).toContain("2026-01-01");
  });

  it("does not draw an unknown pipeline as absent", () => {
    const row: OverlayRow = {
      id: "pipeline",
      state: "unknown",
      label: "No pipeline within 500 ft",
      reason: "provenance degraded; vintage unknown",
      provenance: "degraded",
      vintage: "UNKNOWN",
    };
    expect(overlayCustomerLabel(row)).toBe("Not known whether a pipeline is within 500 ft");
    const html = overlayRowHtml(row, 0);
    expect(html).not.toContain("No pipeline within 500 ft");
    expect(html).not.toContain("degraded");
    expect(html).toContain("Pipeline");
    expect(html).not.toContain(">pipeline<");
  });

  it("uses customer words on an edge and tidies the situs comma", () => {
    const edge: DrawEdge = {
      role: "side_corner",
      adjacency: "ROW",
      roadNode: "48021:road:1179615911",
      roadClass: "gravel",
      ft: 176.66,
      bearing: "S 88°34' W",
    };
    const caption = edgeCaption(edge);
    expect(caption).toBe("corner side · right of way · gravel road · 176.66 ft · S 88°34' W");
    expect(caption).not.toContain("48021:");
    expect(customerSitus("1305 FAYETTE ST , BASTROP, TX 78602")).toBe(
      "1305 FAYETTE ST, BASTROP, TX 78602",
    );
    expect(frameNoteHtml({ units: "ft", quality: "gis-approximate" })).toContain(
      "Approximate map position",
    );
    expect(frameNoteHtml({ units: "ft", quality: "gis-approximate" })).not.toContain(
      ">frame gis-approximate",
    );
  });

  it("shows the land-use name, and the card map matches the server map", () => {
    expect(landUseCustomerName({ landUseCode: "C1", landUseLabel: null })).toBe(
      "Vacant lot or tract",
    );
    const sub = parcelFactSubheadHtml([
      {
        id: "land-use",
        title: "Land use",
        disposition: "present",
        asOf: "2026-08-12",
        data: { landUseCode: "C1", landUseLabel: null },
        citations: [],
        citationsDegraded: true,
        paint: "present",
      },
      {
        id: "flood",
        title: "Flood",
        disposition: "present",
        asOf: "2026-01-01",
        data: { floodZone: "A" },
        citations: [],
        citationsDegraded: false,
        paint: "present",
      },
    ]);
    expect(sub).toContain("Land use Vacant lot or tract");
    expect(sub).toContain("Flood zone A");
    for (const code of ["A1", "C1", "D2", "E1", "F2", "M1", "Z9", ""]) {
      const server = /^[A-Za-z][A-Za-z0-9]{0,3}$/.test(code) ? ptadLandUseDescription(code) : null;
      expect(landUseNameFromCode(code)).toBe(server);
    }
  });

  it("keeps the imagery credit to the Mapbox wordmark and the four links", () => {
    const credit = groundCreditText();
    expect(credit).toContain("Mapbox");
    expect(credit).toContain("© Mapbox");
    expect(credit).toContain("© OpenStreetMap");
    expect(credit).toContain("© Maxar");
    expect(credit).toContain("Improve this map");
    expect(credit).not.toContain("Mapbox held");
    expect(credit).not.toContain("Esri");
    expect(credit).not.toContain("claudemcpcontent");
  });
});

