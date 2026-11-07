/**
 * A-331 / OPS-16: owner of record in the MCP card fullscreen deeper view only.
 */
import { describe, expect, it } from "vitest";
import { answerFirstSingleHtml } from "../src/card/answer-first-html.js";
import { detailHtml, ownerDetailSectionHtml } from "../src/card/detail-html.js";
import {
  OWNER_DETAIL_HEADING,
  OWNER_GATED_VALUE,
  ownerDisplayFrom,
  parseToolResult,
} from "../src/card/panel-lib.js";
import { composeInlineCard } from "../src/inline-card.js";

const STUDIO_OWNER = {
  state: "present",
  source: "owner-fact",
  taxYear: 2025,
  ownerName: "SMITH, RICHARD P & SUSAN J",
  ownerMailingAddress: "908 PINE ST, BASTROP, TX 78602",
  exemptionFlags: {
    homestead: true,
    seniorOrDisability: true,
    agricultural: false,
    veteran: false,
  },
  sourceAdapter: "cad-property-owner-v1",
  sourceVintage: "data-export-01.14.2026",
} as const;

const GATED_OWNER = {
  state: "refused",
  code: "studio-gated",
  source: "owner-fact",
  reason:
    "owner-fact is Studio or Team only, or requires an active property unlock on this parcel. This tool does not carry owner data at any depth without one of those.",
} as const;

const DETAIL_OPTS = {
  groundOn: false,
  floodOn: false,
  envelopeOn: false,
  linesOn: true,
  sheet: "low" as const,
};

function minimalParcelJson(ownerFact: unknown): string {
  return JSON.stringify({
    parcelNodeId: "48021:34137",
    draw: {
      label: "908 PINE ST, BASTROP, TX 78602",
      ring: [
        { x: 10, y: 10 },
        { x: -10, y: 10 },
        { x: -10, y: -10 },
        { x: 10, y: -10 },
      ],
    },
    brief: {
      sections: [
        {
          id: "zoning",
          title: "Zoning",
          disposition: "present",
          data: { district: "SF-1" },
        },
      ],
    },
    ownerFact,
  });
}

describe("ownerDisplayFrom (A-331)", () => {
  it("maps a present ownerFact to name, mailing address, tax year and source", () => {
    const out = ownerDisplayFrom(STUDIO_OWNER);
    expect(out).toEqual({
      kind: "present",
      name: "SMITH, RICHARD P & SUSAN J",
      mailingAddress: "908 PINE ST, BASTROP, TX 78602",
      taxYear: 2025,
      sourceLabel: "County appraisal roll",
    });
  });

  it("maps studio-gated refusal to the gated display state", () => {
    expect(ownerDisplayFrom(GATED_OWNER)).toEqual({ kind: "gated" });
  });

  it("never surfaces non-homestead exemption types in the display model", () => {
    const serialized = JSON.stringify(ownerDisplayFrom(STUDIO_OWNER));
    expect(serialized).not.toContain("seniorOrDisability");
    expect(serialized).not.toContain("homestead");
  });
});

describe("owner in fullscreen detail only (A-331)", () => {
  it("a Studio result shows the owner in the deeper view", () => {
    const model = parseToolResult(minimalParcelJson(STUDIO_OWNER));
    expect(model.ownerDisplay?.kind).toBe("present");
    const html = detailHtml(model, DETAIL_OPTS);
    expect(html).toContain('data-owner="present"');
    expect(html).toContain(OWNER_DETAIL_HEADING);
    expect(html).toContain("SMITH, RICHARD P &amp; SUSAN J");
    expect(html).toContain('<p class="ss-owner-mail">908 PINE ST, BASTROP, TX 78602</p>');
    expect(html).toContain("Tax year 2025");
    expect(html).toContain("County appraisal roll");
    expect(html).not.toContain("seniorOrDisability");
  });

  it("a Solo result shows the gated Studio plan state in the deeper view", () => {
    const model = parseToolResult(minimalParcelJson(GATED_OWNER));
    expect(model.ownerDisplay).toEqual({ kind: "gated" });
    const html = detailHtml(model, DETAIL_OPTS);
    expect(html).toContain('data-owner="gated"');
    expect(html).toContain(OWNER_GATED_VALUE);
    expect(html).not.toContain("ss-owner-name");
    expect(html).not.toContain("ss-owner-mail");
    expect(html).not.toContain("SMITH");
  });

  it("the inline single card never carries owner markup", () => {
    const body = JSON.parse(minimalParcelJson(STUDIO_OWNER)) as Record<string, unknown>;
    const card = composeInlineCard(body, null, () => null);
    expect(card).not.toBeNull();
    const model = parseToolResult(minimalParcelJson(STUDIO_OWNER));
    model.inlineCard = card!;
    const inline = answerFirstSingleHtml(model);
    expect(inline).not.toContain("data-owner");
    expect(inline).not.toContain(OWNER_DETAIL_HEADING);
    expect(inline).not.toContain("SMITH, RICHARD");
  });

  it("ownerDetailSectionHtml is absent when the wire carried no ownerFact", () => {
    expect(ownerDetailSectionHtml(null)).toBe("");
    expect(ownerDetailSectionHtml(undefined)).toBe("");
  });
});
