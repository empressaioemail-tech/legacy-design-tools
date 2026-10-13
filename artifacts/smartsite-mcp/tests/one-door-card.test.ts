/**
 * ONE DOOR `on` (WP-L): the Smart Site MCP inline card, panel and detail view
 * render the reader's words verbatim, and the tool result drops the
 * baked-snapshot label. The bodies are built by the SAME cortex composer the
 * brief route uses in `on` mode (api-server `lib/oneDoor/oneDoorSurfaces.ts`),
 * from fixtures shaped per the spec's reader contract (§2). Synthetic values.
 */

import { describe, expect, it } from "vitest";
import { composeOneDoorBriefBody } from "../../api-server/src/lib/oneDoor/oneDoorSurfaces.ts";
import {
  ONE_DOOR_STATES,
  parseOneDoorRecord,
  type OneDoorState,
} from "../../api-server/src/lib/oneDoor/oneDoorReaderClient.ts";
import { answerFirstSingleHtml } from "../src/card/answer-first-html.js";
import { detailHtml } from "../src/card/detail-html.js";
import { parseToolResult, reportHtml, OWNER_GATED_VALUE } from "../src/card/panel-lib.js";
import { attachInlineCard, composeInlineCard } from "../src/inline-card.js";
import {
  buildRunReportEnvelope,
  normalizeR1BodyForExternal,
  stripOneDoorGatedFactsForCaller,
} from "../src/tool-honesty.js";
import { anchorFromFacetsBody } from "../src/parcel-anchor.js";

const PARCEL = "48209:49502";

const WORDS: Record<OneDoorState, string> = {
  value: "",
  "not-on-record": "Not on the county record",
  "not-applicable": "Unincorporated — the county does not zone",
  "not-loaded": "Not available for this county yet",
  held: "Held while we verify this source",
  "plan-gated": "Included in Studio",
  failed: "Couldn't load this just now — retry",
};

const SOURCE = { adapter: "cad_property", vintage: "2026-09-20", asOf: "2026-09-20" };
const v = (value: unknown) => ({ state: "value", value, words: "", source: SOURCE });
const s = (state: Exclude<OneDoorState, "value">) => ({ state, words: WORDS[state], source: SOURCE });

function onBody(facts: Record<string, unknown>): Record<string, unknown> {
  const record = parseOneDoorRecord(
    { parcelNodeId: PARCEL, countyFips: "48209", contract: "one-door-v1", mode: "on", readAt: "2026-10-13T12:00:00.000Z", facts },
    PARCEL,
  )!;
  return composeOneDoorBriefBody({
    runId: "pe-r1-test.test",
    parcelNodeId: PARCEL,
    record,
    draw: {
      node: PARCEL,
      kind: "parcel",
      label: "101 SYNTHETIC WAY",
      url: "",
      asOf: null,
      frame: { units: "ft", origin: "centroid", yAxis: "true-north", convertedFrom: "local-enu-m", factor: "us-survey-foot", quality: "gis-approximate", anchor: null },
      ring: [[10, 10], [-10, 10], [-10, -10], [10, -10]],
      attrs: {},
      overlays: [],
      confidence: "seed",
    },
  });
}

const DEFAULT_FACTS = {
  situsAddress: v("101 SYNTHETIC WAY"),
  zoningDistrict: s("not-applicable"),
  landUseCode: v("C1"),
  landUseDescription: s("not-loaded"),
  // Companion rail: an array of row payloads (one-door-v1).
  flood: v([{ zone: "X", subtype: null, isSfha: false }]),
  setbackFrontFt: s("held"),
  owner: s("plan-gated"),
};

/** Local wording `on` mode must never print for a reader fact. */
const LOCAL_ABSENCE = /absent, verified|Solo plan|Not on this result|Not named on this result|Source is not on this result|This result does not say why/;

function inlineFacts(body: Record<string, unknown>) {
  const card = composeInlineCard(normalizeR1BodyForExternal(body, false), null, () => null)!;
  return Object.fromEntries(card.facts.map((f) => [f.label, f]));
}

describe("inline card in `on` mode", () => {
  it("renders values and the reader's words verbatim; no local absence wording or plan name", () => {
    const body = onBody(DEFAULT_FACTS);
    const card = composeInlineCard(normalizeR1BodyForExternal(body, false), null, () => null)!;
    const facts = Object.fromEntries(card.facts.map((f) => [f.label, f]));
    expect(facts.Zoning!.value).toBe(WORDS["not-applicable"]);
    expect(facts["Land use"]!.value).toBe("C1");
    expect(facts.Flood!.value).toBe("Zone X");
    expect(facts.Setbacks!.value).toBe(WORDS.held);
    expect(JSON.stringify(card)).not.toMatch(LOCAL_ABSENCE);
    expect(card.answer).toContain(`Zoning: ${WORDS["not-applicable"]}`);
    expect(card.title).toBe("101 SYNTHETIC WAY");
    const html = answerFirstSingleHtml({ ...parseToolResult(JSON.stringify(body)), inlineCard: card });
    expect(html).toContain("Unincorporated — the county does not zone");
    expect(html).not.toMatch(LOCAL_ABSENCE);
  });

  it.each(ONE_DOOR_STATES.map((st) => [st]))("state %s: value or words, never a local phrase", (state) => {
    const zoning = state === "value" ? v("R-1") : s(state as Exclude<OneDoorState, "value">);
    const facts = inlineFacts(onBody({ zoningDistrict: zoning }));
    expect(facts.Zoning!.value).toBe(state === "value" ? "R-1" : WORDS[state]);
    expect(JSON.stringify(facts)).not.toMatch(LOCAL_ABSENCE);
  });

  it("plan-gated shows the reader's plan words, not \"Solo plan\"", () => {
    const facts = inlineFacts(onBody({ landUseCode: s("plan-gated") }));
    expect(facts["Land use"]!.value).toBe(WORDS["plan-gated"]);
    expect(facts["Land use"]!.state).toBe("gated");
  });

  it("a fact the reader did not return is omitted (no \"Not on this result\")", () => {
    const facts = inlineFacts(onBody({ flood: v([{ zone: "AE", isSfha: true }]) }));
    expect(Object.keys(facts)).toEqual(["Flood"]);
  });

  it("land use prefers the reader's description over the code, both verbatim (no local code table)", () => {
    const facts = inlineFacts(onBody({ landUseCode: v("C1"), landUseDescription: v("Vacant lot (county)") }));
    expect(facts["Land use"]!.value).toBe("Vacant lot (county)");
  });

  it("failed: the reader's words", () => {
    const facts = inlineFacts(onBody({ flood: s("failed") }));
    expect(facts.Flood!.value).toBe(WORDS.failed);
    expect(facts.Flood!.state).toBe("unknown");
  });
});

it("companion owner rows (array value) render in the detail view for an entitled caller", () => {
  const body = onBody({ owner: v([{ ownerName: "SYNTHETIC OWNER", ownerMailingAddress: "1 SYNTHETIC WAY" }]) });
  const model = parseToolResult(JSON.stringify(normalizeR1BodyForExternal(body, true)));
  expect(model.ownerDisplay).toEqual(expect.objectContaining({ kind: "present", name: "SYNTHETIC OWNER" }));
});

it("setback scalars arrive as numbers or numeric strings and print verbatim", () => {
  const facts = inlineFacts(onBody({ setbackFrontFt: v("25"), setbackSideFt: v(5) }));
  expect(facts.Setbacks!.value).toBe("25 ft front, 5 ft side");
});

describe("panel and detail view in `on` mode", () => {
  it("the report rows print the reader's words in place of the local state word", () => {
    const model = parseToolResult(JSON.stringify(normalizeR1BodyForExternal(onBody(DEFAULT_FACTS), false)));
    const html = reportHtml(model.sections ?? []);
    expect(html).toContain(WORDS["not-applicable"]);
    expect(html).toContain(WORDS.held);
    expect(html).not.toContain("absent, verified");
  });

  it("the detail view prints the reader's words, and the owner row is the reader's plan words", () => {
    const model = parseToolResult(JSON.stringify(normalizeR1BodyForExternal(onBody(DEFAULT_FACTS), false)));
    expect(model.ownerDisplay).toEqual({ kind: "words", words: WORDS["plan-gated"] });
    const html = detailHtml(model, { groundOn: false, floodOn: false, envelopeOn: false, linesOn: true, sheet: "low" });
    expect(html).toContain(WORDS["not-applicable"]);
    expect(html).toContain(WORDS["plan-gated"]);
    expect(html).not.toContain(OWNER_GATED_VALUE);
    expect(html).not.toContain("absent, verified");
  });
});

describe("tool result labels and gating in `on` mode", () => {
  it("run_report: no baked-snapshot label", () => {
    const env = buildRunReportEnvelope(PARCEL, JSON.stringify(onBody(DEFAULT_FACTS)), false);
    expect(env.reportKind).toBe("R1-one-door");
    expect(env.reportReadMode).toBe("parcel-record-reader-read");
    expect(JSON.stringify(env)).not.toContain("baked-snapshot");
  });

  it("off-mode run_report keeps today's label", () => {
    const env = buildRunReportEnvelope(PARCEL, JSON.stringify({ brief: { sections: [] } }), false);
    expect(env.reportKind).toBe("R1-baked-snapshot");
  });

  it("dispositionDisplayText is the reader's words", () => {
    const out = normalizeR1BodyForExternal(onBody(DEFAULT_FACTS), false);
    const zoning = (out.brief as { sections: Array<Record<string, unknown>> }).sections.find((x) => x.id === "zoning")!;
    expect(zoning.dispositionDisplayText).toBe(WORDS["not-applicable"]);
    expect(String(zoning.agentGuidance)).toContain(WORDS["not-applicable"]);
  });

  it("defense in depth: a gated value never reaches a caller without owner rights", () => {
    const body = { oneDoorMode: "on", facts: { owner: v({ ownerName: "SYNTHETIC OWNER" }), apn: v("R1") } };
    const stripped = stripOneDoorGatedFactsForCaller(body, false);
    expect(JSON.stringify(stripped)).not.toContain("SYNTHETIC OWNER");
    expect((stripped.facts as Record<string, { state: string }>).owner.state).toBe("plan-gated");
    expect(stripOneDoorGatedFactsForCaller(body, true)).toBe(body);
  });

  it("attachInlineCard on an `on` brief produces a single card", () => {
    const out = attachInlineCard(onBody(DEFAULT_FACTS), null);
    expect((out.inlineCard as { layout: string }).layout).toBe("single");
  });
});

describe("anchor reads the `on` facets body's placement", () => {
  it("placement.queryPoint anchors the map when there is no cityLimitsFact", () => {
    const out = anchorFromFacetsBody(
      JSON.stringify({ oneDoorMode: "on", facts: {}, placement: { queryPoint: { longitude: -97.9, latitude: 30.05 } } }),
    );
    expect(out.anchor).toEqual(expect.objectContaining({ lat: 30.05, lon: -97.9 }));
  });
});
