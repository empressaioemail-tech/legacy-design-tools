import { describe, expect, it, vi } from "vitest";
import { portalConfigById } from "./p85Portals.js";
import {
  COUNTY_GOV_RECORDS_RECIPE_VERSION,
  runCountyGovernmentRecordsSearch,
} from "./countyGovernmentRecordsSearch.js";
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
    currentUrl: vi.fn().mockResolvedValue("https://tx.countygovernmentrecords.com/texas/web/"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "",
      visibleMainControls: [],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

const caldwellCtx: RecordsRecipeContext = {
  jobId: "job-caldwell",
  countyFips: "48055",
  parcelKey: "apn:48055:10001",
  portalId: "caldwell-clerk-web",
  requestPayload: {
    searchTerms: { ownerName: "SMITH JOHN" },
  },
};

const portal = portalConfigById("caldwell-clerk-web")!;

describe("runCountyGovernmentRecordsSearch", () => {
  it("fails closed to needs-human/login-required when the splash routes to login.jsp (the real, verified surface)", async () => {
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://tx.countygovernmentrecords.com/texas/web/login.jsp?submit=Enter",
        ),
    });

    const result = await runCountyGovernmentRecordsSearch(caldwellCtx, portal, browser);

    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("login-required");
    expect(result.scopeSearched?.stepsReached).toEqual(
      expect.arrayContaining(["open-entry", "acknowledge-splash"]),
    );
    expect(result.scopeSearched?.loginRequired).toBe(true);
    expect(result.scopeSearched?.recipeVersion).toBe(COUNTY_GOV_RECORDS_RECIPE_VERSION);
  });

  it("also detects the login wall from splash page copy when the URL itself has not yet changed", async () => {
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: false }), // Enter click did not register
      pageIncludes: vi.fn(async (text: string) =>
        text.toLowerCase().includes("register to conduct document searches"),
      ),
    });

    const result = await runCountyGovernmentRecordsSearch(caldwellCtx, portal, browser);

    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("login-required");
  });

  it("fails closed when entry navigation fails", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    });
    const result = await runCountyGovernmentRecordsSearch(caldwellCtx, portal, browser);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("portal-unreachable");
  });

  it("routes to needs-human when search terms are absent (would-be positive path)", async () => {
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue("https://tx.countygovernmentrecords.com/texas/web/search.jsp"),
    });
    const result = await runCountyGovernmentRecordsSearch(
      { ...caldwellCtx, requestPayload: {} },
      portal,
      browser,
    );
    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("search-terms-missing");
  });

  it("completes an owner-name search when the (hypothetical) anonymous surface accepts it", async () => {
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: true }),
      fill: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue("https://tx.countygovernmentrecords.com/texas/web/search.jsp"),
    });
    const result = await runCountyGovernmentRecordsSearch(caldwellCtx, portal, browser);
    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.captures).toEqual(
      expect.arrayContaining([expect.objectContaining({ sha256: "abc123" })]),
    );
  });
});
