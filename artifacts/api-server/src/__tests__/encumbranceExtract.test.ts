/**
 * Fixture PDF text extraction — R4 clause splitter (no county clerk).
 */

import { describe, it, expect, vi } from "vitest";
import { extractEncumbranceClausesFromPdf } from "../lib/encumbranceExtract";
import {
  buildPrivateRestrictionsBriefing,
  formatPrivateRestrictionsForLlm,
} from "../lib/encumbranceWire";
import { assertedExtractConfidence } from "@workspace/engine-core";

const FIXTURE_TEXT =
  "Article VII § 4.2\nNo structure shall exceed thirty-five feet in height.\n";

vi.mock("@workspace/codes-sources/pdf-text", () => ({
  extractPdfPlainText: vi.fn(async () => ({
    text: FIXTURE_TEXT,
    numpages: 2,
  })),
}));

describe("encumbranceExtract fixture", () => {
  it("rejects non-PDF bytes as unparseable", async () => {
    await expect(
      extractEncumbranceClausesFromPdf(Buffer.from("not a pdf")),
    ).rejects.toThrow("pdf_unparseable");
  });

  it("splits Article VII clause from fixture PDF bytes", async () => {
    const result = await extractEncumbranceClausesFromPdf(
      Buffer.from("%PDF-1.4 fixture\n"),
    );
    expect(result.clauses.length).toBeGreaterThanOrEqual(1);
    const heights = result.clauses.find((c) =>
      /thirty-five feet/i.test(c.bodyText),
    );
    expect(heights).toBeTruthy();
    expect(heights?.clausePath).toMatch(/Article VII/i);
  });

  it("formats private restrictions for LLM prompt block", () => {
    const briefing = buildPrivateRestrictionsBriefing(
      [
        {
          id: "inst-1",
          engagementId: null,
          instrument: {
            entityType: "recorded-instrument",
            instrumentDid: "did:hauska:instrument:test",
            instrumentType: "other",
            recording: null,
            issuerActorDid: "did:hauska:actor:engagement-upload",
            sourceDocumentCid: "gcs:/objects/x",
            appliesTo: {},
            accessPolicy: "tenant-private",
            legalWeight: "recorded",
            verificationStatus: "machine",
            extractedAt: new Date().toISOString(),
            sourceAdapter: "R4",
          },
          sourceObjectPath: "/objects/x",
          pdfUrl: "/api/storage/objects/x",
          uploadOriginalFilename: "ccr.pdf",
          uploadContentType: "application/pdf",
          uploadByteSize: 100,
          extractMetadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
      [
        {
          id: "clause-1",
          instrumentId: "inst-1",
          clause: {
            entityType: "restriction-clause",
            clauseDid: "did:hauska:instrument:test:clause:1",
            parentInstrumentCid: "gcs:/objects/x",
            clausePath: "Article VII § 4.2",
            bodyText: "No structure shall exceed thirty-five feet.",
            confidence: assertedExtractConfidence(0.9),
            extractedBy: "encumbrance-extract-v1",
            accessPolicy: "tenant-private",
            legalWeight: "recorded",
            sourceCitation: "Article VII § 4.2 (approx. p. 1)",
            evaluatedAt: new Date().toISOString(),
          },
          sourcePage: 1,
          createdAt: new Date().toISOString(),
        },
      ],
    );
    const block = formatPrivateRestrictionsForLlm(briefing);
    expect(block).toMatch(/NOT municipal code/i);
    expect(block).toMatch(/thirty-five feet/i);
    expect(block).toMatch(/\[P1\]/);
  });
});
