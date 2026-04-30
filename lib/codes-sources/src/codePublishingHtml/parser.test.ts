import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCodePublishingArticle,
  MAX_CHARS_PER_CHUNK,
} from "./parser";

const luc02 = readFileSync(
  join(__dirname, "__fixtures__/GrandCountyLUC02.html"),
  "utf8",
);
const SOURCE_URL =
  "https://www.codepublishing.com/UT/GrandCounty/html/GrandCountyLUC/GrandCountyLUC02.html";

describe("parseCodePublishingArticle: empty / degenerate input", () => {
  it("returns [] for empty input (no H3s)", () => {
    expect(parseCodePublishingArticle("", { sourceUrl: SOURCE_URL })).toEqual(
      [],
    );
  });

  it("returns [] for an article page with no <h3 class='Cite'> sections (mirrors the LUCAddA/LUCAddB stubs the recon de-scoped)", () => {
    const stub = `<html><body>
      <h1 class="Title">Article Z Empty Stub</h1>
      <p>This page links out to a PDF and contains nothing else.</p>
    </body></html>`;
    expect(parseCodePublishingArticle(stub, { sourceUrl: SOURCE_URL })).toEqual(
      [],
    );
  });
});

describe("parseCodePublishingArticle: LUC02 fixture (Article 2 Zoning Districts)", () => {
  it("emits at least one atom per H3 section (14 districts in Article 2 per recon)", () => {
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    // Recon counted 14 H3 sections in Article 2; over-cap splits push the
    // total atom count slightly higher (RC §2.11 specifically has a long
    // Revised-6/19 District Standards block that splits into #partN).
    expect(out.length).toBeGreaterThanOrEqual(14);
    const baseRefs = new Set(
      out.map((a) => (a.sectionRef ?? "").replace(/#part\d+$/, "")),
    );
    expect(baseRefs.has("2.1")).toBe(true);
    expect(baseRefs.has("2.3")).toBe(true);
    expect(baseRefs.has("2.11")).toBe(true);
    expect(baseRefs.has("2.14")).toBe(true);
    expect(baseRefs.size).toBeGreaterThanOrEqual(14);
  });

  it("each atom carries article-level metadata (number, title, articleRevision)", () => {
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    for (const a of out) {
      expect(a.metadata?.kind).toBe("code_publishing_section");
      expect(a.metadata?.articleNumber).toBe("2");
      expect(a.metadata?.articleTitle).toBe("Zoning Districts");
      // The H1 carries one or more `Revised X/YY` markers; the recon
      // observed "Revised 6/19 / Revised 3/21" on Article 2 specifically.
      expect(typeof a.metadata?.articleRevision).toBe("string");
      expect(a.metadata?.articleRevision).toMatch(/\d+\/\d+/);
    }
  });

  it("captures per-section revision marker into metadata.revision when present (e.g. 2.11 'Revised 6/19', 2.12 'Revised 3/21')", () => {
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    // RC §2.11 splits into #partN due to its long Revised-6/19 District
    // Standards block; revision marker copies onto every part.
    const rcPart1 = out.find((a) => a.sectionRef === "2.11#part1");
    const rs = out.find((a) => a.sectionRef === "2.12");
    expect(rcPart1?.metadata?.revision).toBe("6/19");
    expect(rs?.metadata?.revision).toBe("3/21");
    // A section without a revision marker leaves it null.
    const slr = out.find((a) => a.sectionRef === "2.3");
    expect(slr?.metadata?.revision).toBeNull();
  });

  it("strips the leading section number and the .revised span out of the title", () => {
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    const slr = out.find((a) => a.sectionRef === "2.3");
    // SLR district H3 source: `<h3 …>2.3 SLR, Small Lot Residential District </h3>`
    expect(slr?.sectionTitle).toBe("SLR, Small Lot Residential District");
    // RC §2.11 split — base title (with " (part 1)" suffix appended) must
    // still have neither the leading section number nor the .revised span.
    const rcPart1 = out.find((a) => a.sectionRef === "2.11#part1");
    expect(rcPart1?.sectionTitle).toBe(
      "RC, Resort Commercial District (part 1)",
    );
    expect(rcPart1?.sectionTitle).not.toMatch(/Revised/);
  });

  it("folds H4 subsections into the parent H3 body so setback content remains co-located", () => {
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    // SLR's H4s include 2.3.1 Purpose, 2.3.2 Allowed Uses,
    // 2.3.3 Lot Design Standards, 2.3.4 District Standards. None of those
    // should have produced their own atom.
    const refs = new Set(out.map((a) => a.sectionRef));
    expect(refs.has("2.3.1")).toBe(false);
    expect(refs.has("2.3.4")).toBe(false);
    // …but their content should appear in 2.3's body, with H4 labels
    // bracketed for searchability.
    const slr = out.find((a) => a.sectionRef === "2.3");
    expect(slr?.body).toContain("[2.3.1 Purpose]");
    expect(slr?.body).toContain("[2.3.4 District Standards]");
    expect(slr?.body).toMatch(/Small Lot Residential District/);
  });

  it("parentSection is the article number ('2'), bodyHtml is non-empty for unsplit sections, sourceUrl deep-links to the section anchor", () => {
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    const slr = out.find((a) => a.sectionRef === "2.3");
    expect(slr?.parentSection).toBe("2");
    expect(slr?.sourceUrl).toBe(`${SOURCE_URL}#2.3`);
    expect(slr?.bodyHtml).toBeTruthy();
    expect(slr?.bodyHtml).toMatch(/<p|<h4/);
  });

  it("propagates the supplied scrapedAt timestamp into metadata", () => {
    const ts = "2024-06-15T12:34:56Z";
    const out = parseCodePublishingArticle(luc02, {
      sourceUrl: SOURCE_URL,
      scrapedAt: ts,
    });
    for (const a of out) {
      expect(a.metadata?.scrapedAt).toBe(ts);
    }
  });

  it("respects MAX_CHARS_PER_CHUNK on every emitted atom", () => {
    expect(MAX_CHARS_PER_CHUNK).toBe(4000);
    const out = parseCodePublishingArticle(luc02, { sourceUrl: SOURCE_URL });
    for (const a of out) {
      expect(a.body.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
  });
});

describe("parseCodePublishingArticle: over-cap splitting (#partN convention)", () => {
  it("splits a synthetic over-cap H3 into #partN siblings with parallel title suffix", () => {
    const big = "<p>" + "x ".repeat(MAX_CHARS_PER_CHUNK) + "</p>";
    const html = `<html><body>
      <h1 class="Title">Article 9 Synthetic Test</h1>
      <h3 class="Cite" id="9.1">9.1 Huge Section</h3>
      ${big}
    </body></html>`;
    const out = parseCodePublishingArticle(html, { sourceUrl: SOURCE_URL });
    expect(out.length).toBeGreaterThanOrEqual(2);
    const refs = out.map((a) => a.sectionRef);
    expect(refs[0]).toBe("9.1#part1");
    expect(refs[1]).toBe("9.1#part2");
    expect(out[0].sectionTitle).toMatch(/\(part 1\)$/);
    expect(out[1].sectionTitle).toMatch(/\(part 2\)$/);
    expect(out[0].metadata?.isSplit).toBe(true);
    expect(out[0].metadata?.partIndex).toBe(1);
    expect(out[0].metadata?.partTotal).toBeGreaterThanOrEqual(2);
    // bodyHtml is intentionally null on split atoms — slicing mid-DOM
    // breaks well-formedness, so we don't persist a malformed fragment.
    expect(out[0].bodyHtml).toBeNull();
    for (const a of out) {
      expect(a.body.length).toBeLessThanOrEqual(MAX_CHARS_PER_CHUNK);
    }
  });

  it("does not leak inline children of the start H3 (anchor / revised span / .Cite text) into the body", () => {
    const html = `<html><body>
      <h1 class="Title">Article 7 Boundary Test</h1>
      <h3 class="Cite" id="7.1">7.1 <a id="anchor-7-1"></a>HEADING-INLINE-TOKEN <span class="revised">Revised 9/24</span></h3>
      <p class="P0">BODY-CONTENT-TOKEN appears here.</p>
      <h3 class="Cite" id="7.2">7.2 Next Section</h3>
      <p class="P0">Next body.</p>
    </body></html>`;
    const out = parseCodePublishingArticle(html, { sourceUrl: SOURCE_URL });
    const sec = out.find((a) => a.sectionRef === "7.1");
    expect(sec).toBeDefined();
    // Heading text and the per-section "Revised 9/24" marker belong to the
    // H3 itself; they must not be re-emitted into the body.
    expect(sec?.body).not.toContain("HEADING-INLINE-TOKEN");
    expect(sec?.body).not.toContain("Revised");
    expect(sec?.body).toContain("BODY-CONTENT-TOKEN");
    // Title/revision still parse correctly off the H3.
    expect(sec?.sectionTitle).toBe("HEADING-INLINE-TOKEN");
    expect(sec?.metadata?.revision).toBe("9/24");
  });

  it("an under-cap section keeps a single atom (isSplit=false) and a populated bodyHtml", () => {
    const html = `<html><body>
      <h1 class="Title">Article 1 General Provisions</h1>
      <h3 class="Cite" id="1.1">1.1 Title</h3>
      <p class="P0">This LUC shall be known as the Grand County Land Use Code.</p>
    </body></html>`;
    const out = parseCodePublishingArticle(html, { sourceUrl: SOURCE_URL });
    expect(out).toHaveLength(1);
    expect(out[0].metadata?.isSplit).toBe(false);
    expect(out[0].metadata?.partIndex).toBeNull();
    expect(out[0].bodyHtml).toContain("<p");
  });
});
