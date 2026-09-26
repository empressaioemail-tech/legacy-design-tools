import { describe, expect, it } from "vitest";
import { ptadLandUseDescription } from "../../api-server/src/lib/ptadLandUse.ts";
import { answerFirstCarouselHtml, answerFirstSingleHtml } from "../src/card/answer-first-html.js";
import type { PanelModel } from "../src/card/panel-lib.js";
import { parseToolResult, ringSvg } from "../src/card/panel-lib.js";
import { attachInlineCard, cardLandUseName, safeCustomer } from "../src/inline-card.js";

const MACHINE = /bastrop_city_tx|adapter|degraded|provenance|point-on-surface|\d{5}:\d+|citation degraded|\d{4}-\d{2}-\d{2}T/;

function parcelRecord(): Record<string, unknown> {
  return {
    parcelNodeId: "48021:32342",
    onRecord: { countyName: "Bastrop" },
    cityLimitsFact: { cityName: "Bastrop" },
    brief: {
      sections: [
        {
          id: "zoning",
          title: "Zoning",
          disposition: "present",
          data: { district: "SF-1", jurisdictionKey: "bastrop-tx" },
        },
        {
          id: "land-use",
          title: "Land use",
          disposition: "present",
          data: { landUseCode: "C1", landUseLabel: null },
        },
        {
          id: "flood",
          title: "Flood",
          disposition: "present",
          data: { floodZone: "A", method: "point-on-surface" },
        },
        {
          id: "setbacks-envelope",
          title: "Setbacks",
          disposition: "present",
          data: {
            frontFt: 30,
            sideFt: 10,
            rearFt: 30,
            cornerFt: 20,
            disclosure: "ENVELOPE_ROUTER_NOT_A_DISTRICT",
          },
        },
      ],
    },
    draw: {
      label: "1305 FAYETTE ST , BASTROP, TX 78602",
      attrs: { zoning: { jurisdiction: "bastrop_city_tx", v: "SF-1" } },
      ring: [[0, 0], [10, 0], [10, 10], [0, 10]],
      overlays: [
        {
          id: "envelope",
          label: "Buildable envelope",
          state: "present",
          draw: "inset-fill",
          geom: [[1, 1], [9, 1], [9, 9], [1, 9]],
        },
        {
          id: "pipeline",
          label: "No pipeline within 500 ft",
          state: "unknown",
          reason: "provenance degraded; vintage unknown",
        },
      ],
    },
  };
}

describe("P-448 inline card", () => {
  it("writes one answer, four facts, and two urls from the tool result", () => {
    const out = attachInlineCard(parcelRecord(), "https://smartsite.cloud/card#abc");
    const card = out.inlineCard as {
      layout: string;
      answer: string;
      facts: { label: string; value: string; state: string }[];
      expandUrl: string;
      shareUrl: string;
    };
    expect(card.layout).toBe("single");
    expect(card.facts).toHaveLength(4);
    expect(card.facts.map((f) => f.label)).toEqual(["Zoning", "Land use", "Flood", "Setbacks"]);
    expect(card.facts[0]?.value).toBe("SF-1 in Bastrop");
    expect(card.facts[1]?.value).toBe("Vacant lot or tract");
    expect(card.facts[2]?.value).toContain("read at a point on the parcel");
    expect(card.facts[3]?.value).toContain("30 ft front");
    expect(card.expandUrl).toBe("https://smartsite.cloud/card#abc");
    expect(card.shareUrl).toBe(card.expandUrl);
    expect(card.answer).not.toMatch(MACHINE);
    expect(JSON.stringify(card)).not.toMatch(MACHINE);
    expect(card.answer).toContain("1305 FAYETTE ST, BASTROP");
  });

  it("draws refused, absent, and unknown as themselves", () => {
    const raw = parcelRecord();
    const sections = (raw.brief as { sections: Record<string, unknown>[] }).sections;
    sections[0] = { id: "zoning", disposition: "refused", data: null };
    sections[1] = { id: "land-use", disposition: "absent", data: null };
    sections[2] = { id: "flood", disposition: "unknown", data: null };
    const card = attachInlineCard(raw, null).inlineCard as {
      facts: { value: string; state: string }[];
      expandUrl: string | null;
    };
    expect(card.facts[0]).toMatchObject({ value: "Refused", state: "refused" });
    expect(card.facts[1]).toMatchObject({ value: "absent, verified", state: "absent" });
    expect(card.facts[2]).toMatchObject({ value: "unknown", state: "unknown" });
    expect(card.expandUrl).toBeNull();
  });

  it("a list of five is a carousel of five, and nine keeps eight", () => {
    const one = parcelRecord();
    const parcels = [0, 1, 2, 3, 4].map((i) => ({
      ...one,
      parcelNodeId: `48021:3234${i}`,
      draw: { ...(one.draw as object), label: `${100 + i} MAIN ST, BASTROP, TX` },
    }));
    const five = attachInlineCard({ parcels }, "https://smartsite.cloud/card#set").inlineCard as {
      layout: string;
      items: { answer: string; actionLabel: string }[];
      moreCount: number;
    };
    expect(five.layout).toBe("carousel");
    expect(five.items).toHaveLength(5);
    expect(five.items.every((item) => item.actionLabel === "Open")).toBe(true);
    expect(five.moreCount).toBe(0);
    expect(five.items.map((item) => item.answer).join(" ")).not.toMatch(MACHINE);

    const nine = attachInlineCard({
      parcels: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        parcelNodeId: `48021:1000${i}`,
        draw: { label: `${i} OAK ST, BASTROP, TX` },
        brief: (one.brief as object),
      })),
    }, null).inlineCard as { items: unknown[]; moreCount: number };
    expect(nine.items).toHaveLength(8);
    expect(nine.moreCount).toBe(1);
  });

  it("a map selection of five rows is a carousel and does not print the node id", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => ({
      query: `${i} Pine St, Bastrop, TX`,
      parcelNodeId: `48021:5000${i}`,
      resolution: "resolved",
      rails: { zoning: "present", landUse: "unknown", flood: "absent-verified", envelope: "unread" },
    }));
    const card = attachInlineCard({ rows, screen: { name: "Map selection" } }, null).inlineCard as {
      layout: string;
      items: { answer: string }[];
    };
    expect(card.layout).toBe("carousel");
    expect(card.items).toHaveLength(5);
    expect(card.items[0]?.answer).toContain("1 Pine St, Bastrop, TX");
    expect(card.items[0]?.answer).toContain("Zoning on file");
    expect(card.items[0]?.answer).toContain("Land use not verified");
    expect(card.items[0]?.answer).toContain("Flood not on file");
    expect(card.items[0]?.answer).not.toMatch(/\d{5}:/);
  });

  it("the widget prints the server card and not the old actions", () => {
    const attached = attachInlineCard(parcelRecord(), "https://smartsite.cloud/card#abc");
    const model = parseToolResult(JSON.stringify(attached));
    expect(model.kind).toBe("parcel");
    expect(model.inlineCard?.layout).toBe("single");
    const html = answerFirstSingleHtml(model);
    expect(html).toContain("Expand map");
    expect(html).toContain("Share");
    expect(html).toContain('data-layout="single"');
    expect(html).toContain("Vacant lot or tract");
    expect(html).toContain('data-envelope="modelled"');
    expect(html).not.toContain("Find listing history");
    expect(html).not.toContain("bastrop_city_tx");
    expect(html).not.toContain("Mapbox held");
    expect(html).not.toMatch(MACHINE);
  });

  it("a quiet ring omits the jurisdiction key", () => {
    const svg = ringSvg(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      [],
      { quiet: true, zoning: { v: "SF-1", jurisdiction: "bastrop_city_tx", state: "present", url: null } },
    );
    expect(svg).toContain('aria-label="parcel ring"');
    expect(svg).not.toContain("bastrop_city_tx");
    expect(svg).not.toContain("unit reference");
  });

  it("card land-use names match the api-server table", () => {
    const codes = ["", "C1", "A1", "B", "D1", "D2", "E", "E1", "F1", "F2", "J", "M", "O", "S", "EX1", "XV", "Z9"];
    for (const code of codes) {
      expect(cardLandUseName(code)).toBe(ptadLandUseDescription(code));
    }
  });

  it("an error body keeps its shape", () => {
    const err = {
      status: "error",
      reason: "baked_snapshot_not_found",
      upstreamStatus: 404,
      error: "baked_snapshot_not_found",
      parcelNodeId: "48021:900099",
    };
    expect(attachInlineCard(err, null)).toEqual(err);
  });

  it("safeCustomer replaces a planted machine string", () => {
    expect(safeCustomer("bastrop_city_tx", "Parcel")).toBe("Parcel");
    expect(safeCustomer("fine address", "Parcel")).toBe("fine address");
  });

  it("carousel html has one action per item", () => {
    const one = parcelRecord();
    const parcels = [0, 1, 2, 3, 4].map((i) => ({
      ...one,
      parcelNodeId: `48021:3234${i}`,
      draw: {
        ...(one.draw as object),
        label: `${100 + i} MAIN ST, BASTROP, TX`,
        ring: [[0, 0], [8, 0], [8, 8]],
        anchor: undefined,
      },
    }));
    const attached = attachInlineCard({ parcels }, null);
    const model = parseToolResult(JSON.stringify(attached)) as PanelModel;
    const html = answerFirstCarouselHtml(model);
    expect(html).toContain('data-layout="carousel"');
    expect(html.match(/data-inline-item="1"/g)).toHaveLength(5);
    expect(html.match(/>Open</g)).toHaveLength(5);
    expect(html).not.toContain("Expand map");
    expect(html).not.toContain("Share");
  });
});
