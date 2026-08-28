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

describe("p85Portals — Caldwell entry URL", () => {
  it("uses County.Clerk path that returns HTTP 200 (not lowercase 403 path)", () => {
    const portal = portalConfigById("caldwell-clerk-web");
    expect(portal?.entryUrl).toBe("https://www.co.caldwell.tx.us/page/County.Clerk");
    expect(portal?.recipeVersion).toBe("p85-caldwell-clerk-scaffold-v1");
  });
});
