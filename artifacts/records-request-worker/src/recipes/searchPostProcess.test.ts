import { describe, expect, it, vi } from "vitest";
import { finalizeIndexSearchWithAcquisition } from "./searchPostProcess.js";
import type { RecordsRecipeBrowser, RecordsRecipeContext } from "./types.js";

function mockBrowser(overrides: Partial<RecordsRecipeBrowser> = {}): RecordsRecipeBrowser {
  return {
    goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    captureFullPage: vi.fn().mockResolvedValue({
      ok: true,
      sha256: "abc123",
      byteLength: 100,
      label: "test",
    }),
    click: vi.fn().mockResolvedValue({ ok: false }),
    fill: vi.fn().mockResolvedValue({ ok: false }),
    pressEnter: vi.fn().mockResolvedValue({ ok: false }),
    pageIncludes: vi.fn().mockResolvedValue(false),
    currentUrl: vi.fn().mockResolvedValue("https://example.test/"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "",
      visibleMainControls: [],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

const ctx: RecordsRecipeContext = {
  jobId: "job-x",
  countyFips: "48309",
  parcelKey: "apn:48309:1",
  portalId: "mclennan-online-records",
  requestPayload: {},
};

describe("finalizeIndexSearchWithAcquisition — P-113 total-results-hint hardening", () => {
  it("reports complete/zero as before when the portal publishes no total-results hint (no regression for portals without the signal, e.g. Hays)", async () => {
    const browser = mockBrowser(); // extractTotalResultsHint not implemented — undefined
    const result = await finalizeIndexSearchWithAcquisition({
      ctx,
      portalId: "hays-erss",
      browser,
      scope: { mode: "index-search" },
      resultCount: null,
    });
    expect(result.status).toBe("complete");
  });

  it("reports complete when the hint agrees with a genuine zero", async () => {
    const browser = mockBrowser({
      extractTotalResultsHint: vi.fn().mockResolvedValue(0),
    });
    const result = await finalizeIndexSearchWithAcquisition({
      ctx,
      portalId: "mclennan-online-records",
      browser,
      scope: { mode: "index-search" },
      resultCount: null,
    });
    expect(result.status).toBe("complete");
  });

  it("refuses (needs-human) rather than report a fabricated zero when the portal declares results but 0 rows were extracted", async () => {
    const browser = mockBrowser({
      extractTotalResultsHint: vi.fn().mockResolvedValue(1706),
    });
    const result = await finalizeIndexSearchWithAcquisition({
      ctx,
      portalId: "mclennan-online-records",
      browser,
      scope: { mode: "index-search" },
      resultCount: null,
    });
    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("index-hit-extraction-unsupported");
    expect(result.scopeSearched?.portalDeclaredResultCount).toBe(1706);
  });

  it("does not consult the hint when real hits were already extracted", async () => {
    const browser = mockBrowser({
      extractResultRows: vi.fn().mockResolvedValue([
        {
          cells: ["2026026010"],
          headers: ["INSTRUMENT NUMBER"],
          link: null,
        },
      ]),
      extractTotalResultsHint: vi.fn(),
    });
    const result = await finalizeIndexSearchWithAcquisition({
      ctx,
      portalId: "mclennan-online-records",
      browser,
      scope: { mode: "index-search" },
      resultCount: null,
    });
    // Real hit with no detailUrl routes to needs-human via the pre-existing
    // acquisition pipeline (unrelated to this hardening) — the point of
    // this test is narrower: the total-results-hint short-circuit must
    // never fire once real rows were extracted.
    expect(result.status).not.toBe("failed");
    expect(result.scopeSearched?.indexHits).toHaveLength(1);
    expect(browser.extractTotalResultsHint).not.toHaveBeenCalled();
  });
});
