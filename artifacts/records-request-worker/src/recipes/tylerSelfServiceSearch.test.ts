import { describe, expect, it, vi } from "vitest";
import { portalConfigById } from "./p85Portals.js";
import {
  disclaimerStillActive,
  runTylerSelfServiceSearch,
  tylerSearchInputSelectorsForPortal,
  tylerSurfaceFromPortal,
  TYLER_ERSS_SEARCH_INPUT_SELECTORS,
} from "./tylerSelfServiceSearch.js";
import type { RecordsRecipeBrowser, RecordsRecipeContext } from "./types.js";

const haysCtx: RecordsRecipeContext = {
  jobId: "job-hays",
  countyFips: "48209",
  parcelKey: "apn:48209:12345",
  portalId: "hays-erss",
  requestPayload: {
    searchTerms: { ownerName: "SMITH JOHN" },
  },
};

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
    currentUrl: vi.fn().mockResolvedValue("https://erss.co.hays.tx.us/web/search/DOCSEARCH149S1"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "",
      visibleMainControls: [],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

describe("tylerSelfServiceSearch helpers", () => {
  it("detects disclaimer URLs", () => {
    expect(disclaimerStillActive("https://erss.co.hays.tx.us/web/user/disclaimer")).toBe(true);
    expect(disclaimerStillActive("https://erss.co.hays.tx.us/web/search/DOCSEARCH149S1")).toBe(
      false,
    );
  });

  it("registers Hays search entry URL and ERSS selectors", () => {
    const portal = portalConfigById("hays-erss");
    expect(portal?.searchEntryUrl).toBe(
      "https://erss.co.hays.tx.us/web/search/DOCSEARCH149S1",
    );
    expect(portal?.recipeVersion).toBe("p85-hays-erss-v2");
    const surface = tylerSurfaceFromPortal(portal!);
    expect(surface.searchEntryUrl).toBe(portal?.searchEntryUrl);
    expect(tylerSearchInputSelectorsForPortal("hays-erss")).toEqual(
      TYLER_ERSS_SEARCH_INPUT_SELECTORS,
    );
  });
});

describe("runTylerSelfServiceSearch — Hays ERSS", () => {
  it("routes to needs-human when reCAPTCHA blocks disclaimer acceptance", async () => {
    const portal = tylerSurfaceFromPortal(portalConfigById("hays-erss")!);
    const browser = mockBrowser({
      pageIncludes: vi.fn(async (text: string) => text.toLowerCase().includes("recaptcha")),
      currentUrl: vi.fn().mockResolvedValue("https://erss.co.hays.tx.us/web/user/disclaimer"),
    });

    const result = await runTylerSelfServiceSearch(haysCtx, portal, browser);

    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("captcha-required");
    expect(browser.goto).toHaveBeenCalledWith(portal.searchEntryUrl);
  });

  it("completes when search surface accepts owner query", async () => {
    const portal = tylerSurfaceFromPortal(portalConfigById("hays-erss")!);
    const browser = mockBrowser({
      fill: vi.fn(async (selector: string) =>
        selector === "#field_GrantorGrantee" ? { ok: true } : { ok: false },
      ),
      click: vi.fn().mockResolvedValue({ ok: true }),
    });

    const result = await runTylerSelfServiceSearch(haysCtx, portal, browser);

    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.stepsReached).toEqual(
      expect.arrayContaining(["open-disclaimer", "open-search-surface", "fill-owner-query"]),
    );
  });

  it("reports search-ui-not-found only after reaching a non-disclaimer surface", async () => {
    const portal = tylerSurfaceFromPortal(portalConfigById("hays-erss")!);
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi.fn().mockResolvedValue("https://erss.co.hays.tx.us/web/search/DOCSEARCH149S1"),
    });

    const result = await runTylerSelfServiceSearch(haysCtx, portal, browser);

    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("search-ui-not-found");
  });
});

const mclennanCtx: RecordsRecipeContext = {
  jobId: "job-mclennan",
  countyFips: "48309",
  parcelKey: "apn:48309:12345",
  portalId: "mclennan-online-records",
  requestPayload: {
    searchTerms: { ownerName: "BAYLOR UNIVERSITY" },
  },
};

describe("runTylerSelfServiceSearch — McLennan (P-113)", () => {
  it("fills the combined BothNames field, not the Grantor-only field (regression guard for the field-id divergence from Hays)", async () => {
    const portal = tylerSurfaceFromPortal(portalConfigById("mclennan-online-records")!);
    const fill = vi.fn(async (selector: string) =>
      // Both the correct combined field AND the generic Grantor-only
      // fallback would "succeed" if filled — proves priority order, not
      // just reachability.
      selector === "#field_BothNamesID" || selector === 'input[id*="Grantor" i]'
        ? { ok: true }
        : { ok: false },
    );
    const browser = mockBrowser({
      fill,
      click: vi.fn().mockResolvedValue({ ok: true }),
    });

    const result = await runTylerSelfServiceSearch(mclennanCtx, portal, browser);

    expect(result.status).toBe("complete");
    expect(fill.mock.calls[0]?.[0]).toBe("#field_BothNamesID");
  });

  it("completes with capture when owner search submits via #searchButton", async () => {
    const portal = tylerSurfaceFromPortal(portalConfigById("mclennan-online-records")!);
    const browser = mockBrowser({
      fill: vi.fn(async (selector: string) =>
        selector === "#field_BothNamesID" ? { ok: true } : { ok: false },
      ),
      click: vi.fn(async (selector: string) =>
        selector === "#searchButton" ? { ok: true } : { ok: false },
      ),
    });

    const result = await runTylerSelfServiceSearch(mclennanCtx, portal, browser);

    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.captures).toEqual(
      expect.arrayContaining([expect.objectContaining({ sha256: "abc123" })]),
    );
  });

  it("routes to needs-human when owner name is absent", async () => {
    const portal = tylerSurfaceFromPortal(portalConfigById("mclennan-online-records")!);
    const browser = mockBrowser();
    const result = await runTylerSelfServiceSearch(
      { ...mclennanCtx, requestPayload: {} },
      portal,
      browser,
    );
    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("search-terms-missing");
  });
});

describe("p85Portals — Caldwell entry URL (P-113, verified live 2026-09-03)", () => {
  it("uses the real CountyGovernmentRecords.com splash, not the informational county page", () => {
    const portal = portalConfigById("caldwell-clerk-web");
    expect(portal?.entryUrl).toBe("https://tx.countygovernmentrecords.com/texas/web/");
    expect(portal?.recipeVersion).toBe("p85-caldwell-countygovernmentrecords-v1");
  });
});

describe("p85Portals — McLennan entry URL and search entry (P-113, verified live 2026-09-03)", () => {
  it("uses the real McLennan TylerHost disclaimer and DOCSEARCH402S1 search action, and the BothNames selector override", () => {
    const portal = portalConfigById("mclennan-online-records");
    expect(portal?.entryUrl).toBe(
      "https://mclennancountytx-web.tylerhost.net/web/user/disclaimer",
    );
    expect(portal?.searchEntryUrl).toBe(
      "https://mclennancountytx-web.tylerhost.net/web/search/DOCSEARCH402S1",
    );
    expect(portal?.recipeVersion).toBe("p85-mclennan-tylerhost-v1");
    const surface = tylerSurfaceFromPortal(portal!);
    expect(surface.searchEntryUrl).toBe(portal?.searchEntryUrl);
    const selectors = tylerSearchInputSelectorsForPortal("mclennan-online-records");
    expect(selectors[0]).toBe("#field_BothNamesID");
  });
});
