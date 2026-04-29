import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSectionResponse, htmlToPlainText } from "./parser";
import type { MunicodeContentEnvelope } from "./client";

const envelope = JSON.parse(
  readFileSync(
    join(__dirname, "__fixtures__/bastrop-section-response.json"),
    "utf8",
  ),
) as MunicodeContentEnvelope;

describe("htmlToPlainText", () => {
  it("strips tags and collapses whitespace", () => {
    expect(htmlToPlainText("<p>Hello   <b>world</b>.</p>\n<p>One.</p>")).toBe(
      "Hello world. One.",
    );
  });
  it("returns empty string for empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });
});

const ctx = {
  parentNodeId: "PTIHORUCH",
  jobId: 488210,
  productId: 13586,
  stateAbbr: "TX",
  librarySlug: "bastrop",
  chapterHeading: "PART I — HOME RULE CHARTER",
  fallbackUrl: "https://example.test/fallback",
  fetchedAt: "2025-01-01T00:00:00Z",
};

describe("parseSectionResponse", () => {
  it("converts each Doc with non-null Content into one AtomCandidate", () => {
    const out = parseSectionResponse(envelope, ctx);
    expect(out.length).toBe(envelope.Docs.filter((d) => d.Content).length);
  });

  it("each candidate carries the expected metadata block", () => {
    const out = parseSectionResponse(envelope, ctx);
    for (const a of out) {
      expect(a.metadata?.kind).toBe("municode_doc");
      expect(a.metadata?.parentNodeId).toBe("PTIHORUCH");
      expect(a.metadata?.jobId).toBe(488210);
      expect(a.metadata?.productId).toBe(13586);
      expect(a.metadata?.fetchedAt).toBe("2025-01-01T00:00:00Z");
      expect(typeof a.metadata?.nodeId).toBe("string");
    }
  });

  it("sets sourceUrl to the canonical library.municode.com link with nodeId", () => {
    const out = parseSectionResponse(envelope, ctx);
    expect(out[0].sourceUrl).toMatch(
      /^https:\/\/library\.municode\.com\/tx\/bastrop\/codes\/code_of_ordinances\?nodeId=/,
    );
  });

  it("uses fallbackUrl when stateAbbr / librarySlug are blank", () => {
    const out = parseSectionResponse(envelope, {
      ...ctx,
      stateAbbr: "",
      librarySlug: "",
    });
    expect(out[0].sourceUrl).toBe("https://example.test/fallback");
  });

  it("propagates chapterHeading as parentSection when supplied", () => {
    const out = parseSectionResponse(envelope, ctx);
    expect(out[0].parentSection).toBe("PART I — HOME RULE CHARTER");
  });

  it("parentSection is null when chapterHeading is omitted", () => {
    const out = parseSectionResponse(envelope, {
      ...ctx,
      chapterHeading: undefined,
    });
    expect(out[0].parentSection).toBeNull();
  });

  it("body is plain text (no HTML), bodyHtml retains the raw HTML", () => {
    const out = parseSectionResponse(envelope, ctx);
    for (const a of out) {
      expect(a.body).not.toMatch(/<\/?\w+/);
      expect(a.bodyHtml).toMatch(/</);
    }
  });

  it("skips Docs whose Content is null", () => {
    const env: MunicodeContentEnvelope = {
      Docs: [
        {
          Id: "n1",
          Title: "Stub",
          Content: null,
          NodeDepth: 1,
          DocOrderId: 1,
          TitleHtml: null,
          IsAmended: false,
          IsUpdated: false,
        },
      ],
      PdfUrl: null,
      ShowToc: false,
    };
    expect(parseSectionResponse(env, ctx)).toEqual([]);
  });

  it("skips Docs whose plain text is shorter than 30 chars", () => {
    const env: MunicodeContentEnvelope = {
      Docs: [
        {
          Id: "n1",
          Title: "Tiny",
          Content: "<p>hi</p>",
          NodeDepth: 1,
          DocOrderId: 1,
          TitleHtml: null,
          IsAmended: false,
          IsUpdated: false,
        },
      ],
      PdfUrl: null,
      ShowToc: false,
    };
    expect(parseSectionResponse(env, ctx)).toEqual([]);
  });

  it("returns [] for an envelope with no Docs", () => {
    const env: MunicodeContentEnvelope = {
      Docs: [],
      PdfUrl: null,
      ShowToc: false,
    };
    expect(parseSectionResponse(env, ctx)).toEqual([]);
  });
});
