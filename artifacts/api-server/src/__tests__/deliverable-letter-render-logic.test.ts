/**
 * Unit coverage for the L6 pure logic — render-body validation +
 * ref/blobRef builders (`routes/deliverableLetterRender.logic.ts`) —
 * and the real DOCX/PDF generation (`lib/letterRender.ts`). No
 * database, no network.
 */

import { describe, it, expect } from "vitest";
import type { LetterSection } from "@workspace/atoms-l-surface";
import {
  parseRenderBody,
  isRenderFormat,
  deliverableLetterRef,
  renderBlobRef,
} from "../routes/deliverableLetterRender.logic";
import {
  renderLetterToDocx,
  renderLetterToPdf,
  renderContentType,
} from "../lib/letterRender";

function section(
  kind: LetterSection["kind"],
  heading: string,
  content: string,
): LetterSection {
  return {
    kind,
    heading,
    content,
    provenance: {
      responseTaskIds: [],
      sheetContentExtractionIds: [],
      findingIds: [],
      adjudicationStateIds: [],
    },
  };
}

const SAMPLE_SECTIONS: LetterSection[] = [
  section("cover", "Cover", "City of Bastrop — plan review response."),
  section("intro", "Introduction", "We address the comments below."),
  section("signature", "Signature", "Sincerely, the architect of record."),
];

describe("isRenderFormat", () => {
  it("accepts docx / pdf and rejects others", () => {
    expect(isRenderFormat("docx")).toBe(true);
    expect(isRenderFormat("pdf")).toBe(true);
    expect(isRenderFormat("rtf")).toBe(false);
    expect(isRenderFormat(null)).toBe(false);
  });
});

describe("parseRenderBody", () => {
  it("accepts a valid docx body", () => {
    expect(parseRenderBody({ format: "docx" })).toEqual({
      ok: true,
      value: { format: "docx", renderedByActorId: null },
    });
  });

  it("carries renderedByActorId through, trimmed", () => {
    const r = parseRenderBody({ format: "pdf", renderedByActorId: " u-1 " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.renderedByActorId).toBe("u-1");
  });

  it("rejects an unsupported format", () => {
    expect(parseRenderBody({ format: "rtf" })).toMatchObject({
      ok: false,
      error: "invalid_format",
    });
    expect(parseRenderBody({})).toMatchObject({
      ok: false,
      error: "invalid_format",
    });
  });
});

describe("deliverableLetterRef / renderBlobRef", () => {
  it("builds the did + blobRef forms", () => {
    expect(deliverableLetterRef("abc")).toBe(
      "did:hauska:deliverable-letter:abc",
    );
    expect(renderBlobRef("xyz")).toBe("db:deliverable-letter-render:xyz");
  });
});

describe("renderContentType", () => {
  it("maps formats to MIME types", () => {
    expect(renderContentType("pdf")).toBe("application/pdf");
    expect(renderContentType("docx")).toContain("wordprocessingml.document");
  });
});

describe("renderLetterToDocx", () => {
  it("produces a ZIP-shaped OOXML package", () => {
    const buf = renderLetterToDocx("Bastrop Response", SAMPLE_SECTIONS);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // ZIP local-file-header signature.
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
    const asText = buf.toString("latin1");
    expect(asText).toContain("[Content_Types].xml");
    expect(asText).toContain("word/document.xml");
    expect(asText).toContain("Bastrop Response");
  });

  it("xml-escapes the section content", () => {
    const buf = renderLetterToDocx("T", [
      section("cover", "Cover", "needs <review> & care"),
    ]);
    const asText = buf.toString("latin1");
    expect(asText).toContain("needs &lt;review&gt; &amp; care");
  });
});

describe("renderLetterToPdf", () => {
  it("produces a PDF document", async () => {
    const buf = await renderLetterToPdf("Bastrop Response", SAMPLE_SECTIONS);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("handles an empty section list without throwing", async () => {
    const buf = await renderLetterToPdf("Empty", []);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
