/**
 * G-309 wave 2 (A10): ICC's Exhibit B notice and disclaimer on api-server
 * surfaces, only when an ICC citation is present. Pure: no database.
 */
import { describe, it, expect } from "vitest";
import { ICC_DISCLAIMER } from "@workspace/icc-notice";
import { iccNoticeField } from "../lib/iccNoticeField";
import { renderBriefingHtml } from "../lib/briefingHtml";

const baseInput = {
  engagement: {
    id: "e1",
    name: "Eng",
    jurisdiction: "Bastrop, TX",
    address: "1 Pine St",
    latitude: null,
    longitude: null,
  },
  narrative: {
    generationId: "g1",
    briefingId: "b1",
    sections: {
      a: "Summary.",
      b: "Threshold.",
      c: "Gates [[CODE:ATOM-PLAIN]].",
      d: "Infra.",
      e: "Envelope.",
      f: "Context.",
      g: "Next.",
    },
    generatedAt: new Date("2026-04-01T00:00:00Z"),
    generatedBy: "system:briefing-engine",
  },
  sources: [
    {
      id: "s1",
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "City QGIS",
      snapshotDate: new Date("2026-03-01T00:00:00Z"),
      note: null,
    },
  ],
  header: null,
  architectName: null,
} as const;

describe("brief response iccNotice", () => {
  it("present for an ICC link in citations, absent for a city citation", () => {
    const icc = iccNoticeField([["https://codes.iccsafe.org/content/IBC2021P1/chapter-16"]]);
    expect(icc.iccNotice?.disclaimer).toBe(ICC_DISCLAIMER);
    expect(iccNoticeField([["https://library.municode.com/tx/bastrop"]])).toEqual({});
    expect(iccNoticeField([[]], [[]])).toEqual({});
  });
  it("finds an ICC link held inside a section's citations", () => {
    const f = iccNoticeField([[]], [[{ title: "Flood", citations: ["https://codes.iccsafe.org/x"] }]]);
    expect(f.iccNotice).toBeDefined();
    expect(iccNoticeField([[]], [[{ title: "IBC overview", citations: ["https://library.municode.com/x"] }]])).toEqual({});
  });
  it("finds an ICC atom in provenance entries", () => {
    expect(
      iccNoticeField([[{ atomId: "x", deeplink: "https://codes.iccsafe.org/x", sourceName: "ICC model code" }]]).iccNotice,
    ).toBeDefined();
  });
});

describe("briefing PDF HTML iccNotice", () => {
  it("omits the notice when nothing cites ICC", () => {
    expect(renderBriefingHtml(baseInput)).not.toContain(ICC_DISCLAIMER);
  });
  it("adds the notice once when a section cites an ICC atom", () => {
    const html = renderBriefingHtml({
      ...baseInput,
      narrative: {
        ...baseInput.narrative,
        sections: { ...baseInput.narrative.sections, c: "Gates [[CODE:icc-model-code/2021-international-building-code/1612-3]]." },
      },
    });
    expect(html.split(ICC_DISCLAIMER).length).toBe(2);
    expect(html).toContain("ALL RIGHTS RESERVED");
  });
});
