/**
 * Unit coverage for the L3 pure logic
 * (`routes/deliverableLetter.logic.ts`) — body validation + the
 * section-array upsert / provenance-merge operations. No database.
 */

import { describe, it, expect } from "vitest";
import type { LetterSection } from "@workspace/atoms-l-surface";
import {
  emptyProvenance,
  isLetterSectionKind,
  parseCreateLetterBody,
  parseSectionUpsertBody,
  parseProvenanceBody,
  upsertSection,
  mergeProvenance,
} from "../routes/deliverableLetter.logic";

function section(
  kind: LetterSection["kind"],
  overrides: Partial<LetterSection> = {},
): LetterSection {
  return {
    kind,
    heading: `${kind} heading`,
    content: `${kind} content`,
    provenance: emptyProvenance(),
    ...overrides,
  };
}

describe("emptyProvenance", () => {
  it("returns four empty arrays", () => {
    expect(emptyProvenance()).toEqual({
      responseTaskIds: [],
      sheetContentExtractionIds: [],
      findingIds: [],
      adjudicationStateIds: [],
    });
  });
});

describe("isLetterSectionKind", () => {
  it("accepts the four kinds, rejects others", () => {
    for (const k of ["cover", "intro", "per-comment-response", "signature"]) {
      expect(isLetterSectionKind(k)).toBe(true);
    }
    expect(isLetterSectionKind("footer")).toBe(false);
    expect(isLetterSectionKind(null)).toBe(false);
  });
});

describe("parseCreateLetterBody", () => {
  it("accepts a minimal body with just a title", () => {
    const r = parseCreateLetterBody({ title: "  Comment response  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Comment response");
      expect(r.value.sections).toEqual([]);
    }
  });

  it("accepts initial sections", () => {
    const r = parseCreateLetterBody({
      title: "L",
      sections: [{ kind: "cover", heading: "h", content: "c" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sections).toHaveLength(1);
  });

  it("rejects a missing title", () => {
    expect(parseCreateLetterBody({ sections: [] })).toMatchObject({
      ok: false,
      error: "invalid_title",
    });
  });

  it("rejects an invalid section kind", () => {
    expect(
      parseCreateLetterBody({
        title: "L",
        sections: [{ kind: "footer", heading: "h", content: "c" }],
      }),
    ).toMatchObject({ ok: false, error: "invalid_section_kind" });
  });

  it("rejects non-array sections", () => {
    expect(
      parseCreateLetterBody({ title: "L", sections: "nope" }),
    ).toMatchObject({ ok: false, error: "invalid_sections" });
  });
});

describe("parseSectionUpsertBody", () => {
  it("accepts a valid body", () => {
    expect(
      parseSectionUpsertBody({
        sectionIndex: 0,
        kind: "intro",
        heading: "h",
        content: "c",
      }),
    ).toEqual({
      ok: true,
      value: { sectionIndex: 0, kind: "intro", heading: "h", content: "c" },
    });
  });

  it("rejects a negative or non-integer index", () => {
    expect(
      parseSectionUpsertBody({
        sectionIndex: -1,
        kind: "intro",
        heading: "h",
        content: "c",
      }),
    ).toMatchObject({ ok: false, error: "invalid_section_index" });
    expect(
      parseSectionUpsertBody({
        sectionIndex: 1.5,
        kind: "intro",
        heading: "h",
        content: "c",
      }),
    ).toMatchObject({ ok: false, error: "invalid_section_index" });
  });

  it("rejects an invalid kind", () => {
    expect(
      parseSectionUpsertBody({
        sectionIndex: 0,
        kind: "x",
        heading: "h",
        content: "c",
      }),
    ).toMatchObject({ ok: false, error: "invalid_section_kind" });
  });
});

describe("upsertSection", () => {
  it("replaces an existing section and preserves its provenance", () => {
    const existing = section("cover", {
      provenance: {
        responseTaskIds: ["rt-1"],
        sheetContentExtractionIds: [],
        findingIds: [],
        adjudicationStateIds: [],
      },
    });
    const r = upsertSection([existing], {
      sectionIndex: 0,
      kind: "cover",
      heading: "new heading",
      content: "new content",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.heading).toBe("new heading");
    expect(r.value[0]!.provenance.responseTaskIds).toEqual(["rt-1"]);
  });

  it("appends when sectionIndex equals the array length", () => {
    const r = upsertSection([section("cover")], {
      sectionIndex: 1,
      kind: "intro",
      heading: "h",
      content: "c",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value[1]!.provenance).toEqual(emptyProvenance());
  });

  it("rejects an index past the array length", () => {
    expect(
      upsertSection([section("cover")], {
        sectionIndex: 5,
        kind: "intro",
        heading: "h",
        content: "c",
      }),
    ).toMatchObject({ ok: false, error: "invalid_section_index" });
  });
});

describe("parseProvenanceBody", () => {
  it("accepts a body with one id array", () => {
    expect(parseProvenanceBody({ findingIds: ["f-1"] })).toEqual({
      ok: true,
      value: { findingIds: ["f-1"] },
    });
  });

  it("rejects a body with no provenance keys", () => {
    expect(parseProvenanceBody({})).toMatchObject({
      ok: false,
      error: "no_provenance_supplied",
    });
  });

  it("rejects a non-string-array value", () => {
    expect(
      parseProvenanceBody({ findingIds: [1, 2] }),
    ).toMatchObject({ ok: false, error: "invalid_findingIds" });
  });
});

describe("mergeProvenance", () => {
  it("merges deduped into the target section, leaving others intact", () => {
    const sections = [
      section("cover"),
      section("per-comment-response", {
        provenance: {
          responseTaskIds: ["rt-1"],
          sheetContentExtractionIds: [],
          findingIds: [],
          adjudicationStateIds: [],
        },
      }),
    ];
    const r = mergeProvenance(sections, 1, {
      responseTaskIds: ["rt-1", "rt-2"],
      findingIds: ["f-9"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[1]!.provenance.responseTaskIds).toEqual(["rt-1", "rt-2"]);
    expect(r.value[1]!.provenance.findingIds).toEqual(["f-9"]);
    expect(r.value[0]!.provenance).toEqual(emptyProvenance());
  });

  it("rejects an out-of-range section index", () => {
    expect(
      mergeProvenance([section("cover")], 3, { findingIds: ["f-1"] }),
    ).toMatchObject({ ok: false, error: "invalid_section_index" });
  });
});
