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
  parseUploadedDocumentType,
  isAcceptedDocumentMime,
  isTextMime,
  resolveDocumentTitle,
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

// ── QA-18 — operator-driven attached-document upload ──────────────────────

describe("parseUploadedDocumentType", () => {
  it("defaults a missing or empty type to 'narrative'", () => {
    expect(parseUploadedDocumentType(undefined)).toEqual({
      ok: true,
      value: "narrative",
    });
    expect(parseUploadedDocumentType("")).toEqual({
      ok: true,
      value: "narrative",
    });
    expect(parseUploadedDocumentType(null)).toEqual({
      ok: true,
      value: "narrative",
    });
  });

  it("accepts a valid document type", () => {
    expect(parseUploadedDocumentType("specification")).toEqual({
      ok: true,
      value: "specification",
    });
  });

  it("rejects an unknown document type", () => {
    expect(parseUploadedDocumentType("photo")).toMatchObject({
      ok: false,
      error: "invalid_document_type",
    });
  });
});

describe("isAcceptedDocumentMime", () => {
  it("accepts PDFs, any image, and any text type", () => {
    expect(isAcceptedDocumentMime("application/pdf")).toBe(true);
    expect(isAcceptedDocumentMime("image/png")).toBe(true);
    expect(isAcceptedDocumentMime("image/jpeg")).toBe(true);
    expect(isAcceptedDocumentMime("text/plain")).toBe(true);
    expect(isAcceptedDocumentMime("text/markdown; charset=utf-8")).toBe(true);
  });

  it("rejects unrelated and empty MIME types", () => {
    expect(isAcceptedDocumentMime("application/zip")).toBe(false);
    expect(isAcceptedDocumentMime("application/octet-stream")).toBe(false);
    expect(isAcceptedDocumentMime("")).toBe(false);
  });
});

describe("isTextMime", () => {
  it("is true only for text/* types", () => {
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("text/markdown; charset=utf-8")).toBe(true);
    expect(isTextMime("application/pdf")).toBe(false);
    expect(isTextMime("image/png")).toBe(false);
  });
});

describe("resolveDocumentTitle", () => {
  it("prefers the operator-provided title", () => {
    expect(resolveDocumentTitle("  Soil report  ", "upload.pdf")).toBe(
      "Soil report",
    );
  });

  it("falls back to the filename when no title is given", () => {
    expect(resolveDocumentTitle("", "client-notes.pdf")).toBe(
      "client-notes.pdf",
    );
    expect(resolveDocumentTitle(undefined, "photo.jpg")).toBe("photo.jpg");
  });

  it("falls back to a generic default when neither is present", () => {
    expect(resolveDocumentTitle(null, "")).toBe("Untitled document");
    expect(resolveDocumentTitle(undefined, undefined)).toBe(
      "Untitled document",
    );
  });

  it("caps a pathologically long title", () => {
    const long = "x".repeat(500);
    expect(resolveDocumentTitle(long, undefined).length).toBe(200);
  });
});
