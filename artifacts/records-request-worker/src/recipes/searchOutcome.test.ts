import { describe, expect, it, vi } from "vitest";
import type { RecordsRecipeBrowser } from "./types.js";
import {
  SEARCH_FILL_DID_NOT_SUBMIT,
  SEARCH_RESULTS_UNSETTLED,
  assertBastropSearchSettled,
} from "./searchOutcome.js";

function mockBrowser(
  overrides: Partial<RecordsRecipeBrowser> = {},
): RecordsRecipeBrowser {
  return {
    goto: vi.fn(),
    captureFullPage: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    pressEnter: vi.fn(),
    pageIncludes: vi.fn().mockResolvedValue(false),
    currentUrl: vi.fn().mockResolvedValue("https://cc.co.bastrop.tx.us/RealEstate/SearchEntry.aspx"),
    extractResultRows: vi.fn(),
    inspectDocumentPurchase: vi.fn(),
    ...overrides,
  };
}

describe("assertBastropSearchSettled", () => {
  it("accepts SearchResults plus a published hit count", async () => {
    const browser = mockBrowser({
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchResults.aspx",
        ),
      pageIncludes: vi.fn(async (text: string) => {
        const needle = text.toLowerCase();
        return needle === "records found" || needle === "showing records";
      }),
    });
    const settled = await assertBastropSearchSettled(browser, "owner-name", {
      timeoutMs: 200,
      fillMissAfterMs: 50,
      pollMs: 10,
    });
    expect(settled.ok).toBe(true);
    if (settled.ok) expect(settled.outcome).toBe("hits");
  });

  it("accepts SearchResults plus 0 records found as an honest empty", async () => {
    const browser = mockBrowser({
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchResults.aspx",
        ),
      pageIncludes: vi.fn(async (text: string) =>
        text.toLowerCase().includes("0 records found"),
      ),
    });
    const settled = await assertBastropSearchSettled(browser, "legal-description", {
      timeoutMs: 200,
      fillMissAfterMs: 50,
      pollMs: 10,
    });
    expect(settled.ok).toBe(true);
    if (settled.ok) expect(settled.outcome).toBe("zero");
  });

  it("refuses SearchEntry plus please-enter as a fill miss, not 0 hits", async () => {
    const browser = mockBrowser({
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchEntry.aspx",
        ),
      pageIncludes: vi.fn(async (text: string) =>
        text.toLowerCase().includes("please enter search criteria"),
      ),
    });
    const settled = await assertBastropSearchSettled(browser, "owner-name", {
      timeoutMs: 200,
      fillMissAfterMs: 0,
      pollMs: 10,
    });
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.result.errorCode).toBe(SEARCH_FILL_DID_NOT_SUBMIT);
      expect(settled.result.status).toBe("failed");
    }
  });

  it("does not infer 0 hits from SearchEntry without a published outcome", async () => {
    const browser = mockBrowser({
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchEntry.aspx",
        ),
      pageIncludes: vi.fn().mockResolvedValue(false),
    });
    const settled = await assertBastropSearchSettled(browser, "owner-name", {
      timeoutMs: 80,
      fillMissAfterMs: 200,
      pollMs: 10,
    });
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.result.errorCode).toBe(SEARCH_RESULTS_UNSETTLED);
    }
  });

  it("does not settle on SearchResults without a records-found label", async () => {
    const browser = mockBrowser({
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchResults.aspx",
        ),
      pageIncludes: vi.fn().mockResolvedValue(false),
    });
    const settled = await assertBastropSearchSettled(browser, "owner-name", {
      timeoutMs: 80,
      fillMissAfterMs: 0,
      pollMs: 10,
    });
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.result.errorCode).toBe(SEARCH_RESULTS_UNSETTLED);
    }
  });
});
