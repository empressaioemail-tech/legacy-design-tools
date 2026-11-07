import { describe, expect, it, vi } from "vitest";
import { normalizeIndexHit } from "./indexHits.js";
import {
  PURCHASE_THRESHOLD_CENTS,
  acquireIndexHits,
} from "./instrumentAcquisition.js";
import type { RecordsRecipeBrowser } from "./types.js";

vi.mock("../artifactStore.js", () => ({
  insertRecordsRequestArtifact: vi.fn().mockResolvedValue("artifact-id-1"),
}));

function mockBrowser(overrides: Partial<RecordsRecipeBrowser> = {}): RecordsRecipeBrowser {
  return {
    goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    captureFullPage: vi.fn().mockResolvedValue({
      ok: true,
      sha256: "deadbeef",
      byteLength: 512,
      label: "capture",
    }),
    click: vi.fn().mockResolvedValue({ ok: false }),
    fill: vi.fn().mockResolvedValue({ ok: false }),
    pressEnter: vi.fn().mockResolvedValue({ ok: false }),
    pageIncludes: vi.fn().mockResolvedValue(false),
    currentUrl: vi.fn().mockResolvedValue("https://example.test/detail"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "Official Record",
      visibleMainControls: ["View"],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

describe("normalizeIndexHit", () => {
  it("maps named header columns to index fields", () => {
    expect(
      normalizeIndexHit({
        headers: ["Instrument Number", "Document Type", "Date", "Grantor"],
        cells: ["2024-12345", "DEED", "2024-01-02", "SMITH JOHN"],
        link: "https://portal/doc/1",
      }),
    ).toEqual({
      recordingRef: "2024-12345",
      documentType: "DEED",
      recordingDate: "2024-01-02",
      parties: "SMITH JOHN",
      detailUrl: "https://portal/doc/1",
    });
  });
});

describe("acquireIndexHits", () => {
  it("captures a free document even when the page HTML contains Pay Taxes", async () => {
    const captureFullPage = vi.fn().mockResolvedValue({
      ok: true,
      sha256: "deadbeef",
      byteLength: 512,
      label: "capture",
    });
    const browser = mockBrowser({
      pageIncludes: vi.fn(async (text: string) =>
        "pay taxes paypal payment".includes(text.toLowerCase()),
      ),
      inspectDocumentPurchase: vi.fn().mockResolvedValue({
        visibleMainText: "Official Record 202008880",
        visibleMainControls: ["View"],
        rowPriceText: null,
      }),
      captureFullPage,
    });
    const result = await acquireIndexHits({
      jobId: "job-1",
      portalId: "bastrop-aumentum",
      hits: [
        {
          recordingRef: "202008880",
          documentType: "DEED",
          recordingDate: null,
          parties: "A",
          detailUrl: "https://portal/doc/1",
        },
      ],
      browser,
    });
    expect(result.kind).toBe("acquired");
    expect(captureFullPage).toHaveBeenCalled();
    if (result.kind === "acquired") {
      expect(result.summary.acquired).toBe(1);
    }
  });

  it("does not capture a document that has Add to cart on the document surface", async () => {
    const captureFullPage = vi.fn();
    const browser = mockBrowser({
      inspectDocumentPurchase: vi.fn().mockResolvedValue({
        visibleMainText: "Official Record 202008880",
        visibleMainControls: ["Add to cart"],
        rowPriceText: null,
      }),
      captureFullPage,
    });
    const result = await acquireIndexHits({
      jobId: "job-1",
      portalId: "bastrop-aumentum",
      hits: [
        {
          recordingRef: "202008880",
          documentType: "DEED",
          recordingDate: null,
          parties: "A",
          detailUrl: "https://portal/doc/1",
        },
      ],
      browser,
    });
    expect(result.kind).toBe("needs-human");
    expect(captureFullPage).not.toHaveBeenCalled();
  });

  it("captures detail pages when no purchase wall", async () => {
    const browser = mockBrowser();
    const result = await acquireIndexHits({
      jobId: "job-1",
      portalId: "hays-erss",
      hits: [
        {
          recordingRef: "2024-1",
          documentType: "DEED",
          recordingDate: null,
          parties: "A",
          detailUrl: "https://portal/doc/1",
        },
      ],
      browser,
    });
    expect(result.kind).toBe("acquired");
    if (result.kind === "acquired") {
      expect(result.summary.acquired).toBe(1);
      expect(result.summary.methods.capture).toBe(1);
    }
  });

  it("routes purchase wall to awaiting-purchase when over threshold", async () => {
    const browser = mockBrowser({
      inspectDocumentPurchase: vi.fn().mockResolvedValue({
        visibleMainText: "Purchase this document",
        visibleMainControls: ["Add to cart"],
        rowPriceText: "$3.50",
      }),
    });
    const hits = Array.from({ length: 20 }, (_, i) => ({
      recordingRef: `${i}`,
      documentType: "DEED",
      recordingDate: null,
      parties: "A",
      detailUrl: `https://portal/doc/${i}`,
    }));
    const result = await acquireIndexHits({
      jobId: "job-1",
      portalId: "williamson-publicsearch",
      hits,
      browser,
    });
    expect(result.kind).toBe("awaiting-purchase");
    if (result.kind === "awaiting-purchase") {
      expect(result.summary.purchaseCostCents).toBeGreaterThan(
        PURCHASE_THRESHOLD_CENTS,
      );
    }
  });

  it("routes fee-approved purchase walls to human clerk and does not checkout", async () => {
    const captureFullPage = vi.fn();
    const browser = mockBrowser({
      inspectDocumentPurchase: vi.fn().mockResolvedValue({
        visibleMainText: "Purchase this document",
        visibleMainControls: ["Add to cart"],
        rowPriceText: "$3.50",
      }),
      captureFullPage,
    });
    const result = await acquireIndexHits({
      jobId: "job-1",
      portalId: "bastrop-aumentum",
      hits: [
        {
          recordingRef: "2024-1",
          documentType: "DEED",
          recordingDate: null,
          parties: "A",
          detailUrl: "https://portal/doc/1",
        },
      ],
      browser,
      purchaseApproved: true,
    });
    expect(result.kind).toBe("needs-human");
    expect(captureFullPage).not.toHaveBeenCalled();
    if (result.kind === "needs-human") {
      expect(result.reason).toContain("does not drive checkout");
    }
  });
});
