/**
 * Unit coverage for the L2 pure logic (`routes/sheetContent.logic.ts`)
 * — text-segment shaping + attached-document filter validation. No
 * database; route integration coverage runs in CI against Postgres.
 */

import { describe, it, expect } from "vitest";
import {
  FULL_PAGE_BOUNDING_BOX,
  buildTextSegments,
  isAttachedDocumentType,
  parseDocumentTypeFilter,
} from "../routes/sheetContent.logic";

describe("FULL_PAGE_BOUNDING_BOX", () => {
  it("is the normalized whole-page box", () => {
    expect(FULL_PAGE_BOUNDING_BOX).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("buildTextSegments", () => {
  it("returns zero segments for an empty or whitespace body", () => {
    expect(buildTextSegments("")).toEqual([]);
    expect(buildTextSegments("   \n  ")).toEqual([]);
  });

  it("maps a non-empty body to one page-spanning segment", () => {
    const segments = buildTextSegments("  GENERAL NOTES: see A-301  ");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      text: "GENERAL NOTES: see A-301",
      boundingBox: { x: 0, y: 0, width: 1, height: 1 },
      sourceConfidence: 1,
    });
  });

  it("returns a fresh boundingBox object per call (no shared mutation)", () => {
    const a = buildTextSegments("x");
    const b = buildTextSegments("y");
    expect(a[0]!.boundingBox).not.toBe(b[0]!.boundingBox);
  });
});

describe("isAttachedDocumentType", () => {
  it("accepts the four document types and rejects everything else", () => {
    for (const t of [
      "specification",
      "calculation",
      "product-data",
      "narrative",
    ]) {
      expect(isAttachedDocumentType(t)).toBe(true);
    }
    expect(isAttachedDocumentType("drawing")).toBe(false);
    expect(isAttachedDocumentType("")).toBe(false);
    expect(isAttachedDocumentType(null)).toBe(false);
    expect(isAttachedDocumentType(3)).toBe(false);
  });
});

describe("parseDocumentTypeFilter", () => {
  it("resolves an absent filter to null", () => {
    expect(parseDocumentTypeFilter(undefined)).toEqual({
      ok: true,
      value: null,
    });
    expect(parseDocumentTypeFilter("")).toEqual({ ok: true, value: null });
  });

  it("accepts a valid document type", () => {
    expect(parseDocumentTypeFilter("calculation")).toEqual({
      ok: true,
      value: "calculation",
    });
  });

  it("rejects an unknown document type", () => {
    expect(parseDocumentTypeFilter("blueprint")).toMatchObject({
      ok: false,
      error: "invalid_document_type",
    });
  });
});
