import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDesignCriteriaHtml } from "./parser";

const fixture = readFileSync(
  join(__dirname, "__fixtures__/design-criteria-page.html"),
  "utf8",
);
const SOURCE_URL = "https://www.grandcountyutah.net/146/Design-Criteria";

describe("parseDesignCriteriaHtml", () => {
  it("emits one main table atom + multiple footnote atoms", () => {
    const out = parseDesignCriteriaHtml(fixture, SOURCE_URL, "2025-01-01T00:00:00Z");
    expect(out.length).toBeGreaterThanOrEqual(2);

    // First atom is the table itself.
    expect(out[0].sectionRef).toBe("R301.2(1)");
    expect(out[0].parentSection).toBe("R301.2");
    expect(out[0].metadata?.kind).toBe("design_criteria_table");
    expect(out[0].metadata?.codeBookEdition).toBe("IRC 2021");
    expect(out[0].sourceUrl).toBe(SOURCE_URL);
    expect(out[0].body.length).toBeGreaterThan(50);
    expect(out[0].bodyHtml).toMatch(/^<table>/);
  });

  it("each footnote atom has sectionRef 'R301.2(1) note <letter>' and parent R301.2(1)", () => {
    const out = parseDesignCriteriaHtml(fixture, SOURCE_URL);
    const footnotes = out.filter(
      (a) => a.metadata?.kind === "design_criteria_table_footnote",
    );
    expect(footnotes.length).toBeGreaterThanOrEqual(3);
    for (const f of footnotes) {
      expect(f.sectionRef).toMatch(/^R301\.2\(1\) note [a-z]$/);
      expect(f.parentSection).toBe("R301.2(1)");
      expect(typeof f.metadata?.footnote).toBe("string");
      expect(f.body).toMatch(/^[a-z]\.\s/);
    }
  });

  it("propagates the supplied scrapedAt timestamp into metadata", () => {
    const ts = "2024-06-15T12:34:56Z";
    const out = parseDesignCriteriaHtml(fixture, SOURCE_URL, ts);
    for (const a of out) {
      expect(a.metadata?.scrapedAt).toBe(ts);
    }
  });

  it("propagates the supplied sourceUrl onto every atom", () => {
    const url = "https://example.test/some-page";
    const out = parseDesignCriteriaHtml(fixture, url);
    for (const a of out) {
      expect(a.sourceUrl).toBe(url);
    }
  });

  it("throws (fail-loud) when the 301.2(1) collapsible is missing", () => {
    const noTable = "<html><body><h1>Nothing here</h1></body></html>";
    expect(() => parseDesignCriteriaHtml(noTable, SOURCE_URL)).toThrow(
      /301\.2\(1\)/,
    );
  });

  it("throws when collapsible is present but has no .content sibling", () => {
    const partial = `<html><body>
      <div class="collapsible">2021 IRC TABLE 301.2(1) — DESIGN CRITERIA</div>
      <p>nothing follows</p>
    </body></html>`;
    expect(() => parseDesignCriteriaHtml(partial, SOURCE_URL)).toThrow(
      /sibling \.content is missing/,
    );
  });
});
