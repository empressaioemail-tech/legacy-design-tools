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
    ...overrides,
  };
}

describe("normalizeIndexHit", () => {
  it("maps table cells to index fields", () => {
    expect(
      normalizeIndexHit({
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
      pageIncludes: vi.fn().mockResolvedValue(true),
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
});
