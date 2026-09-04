import { describe, expect, it, vi } from "vitest";
import {
  listRegisteredRecipes,
  resolvePortalIdForJob,
  runRecipeForJob,
} from "./index.js";
import { P85_DEFAULT_PORTAL_BY_COUNTY, P85_PORTALS } from "./p85Portals.js";
import { SEARCH_FILL_DID_NOT_SUBMIT } from "./searchOutcome.js";
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
    currentUrl: vi.fn().mockResolvedValue("https://example.test/search"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "",
      visibleMainControls: [],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

describe("P-85 portal registry", () => {
  it("registers all six county default portals", () => {
    expect(listRegisteredRecipes()).toHaveLength(P85_PORTALS.length);
    for (const [county, portalId] of Object.entries(P85_DEFAULT_PORTAL_BY_COUNTY)) {
      expect(resolvePortalIdForJob(county, {})).toBe(portalId);
    }
  });

  it("defaults Williamson to publicsearch (TylerHost headless 403)", () => {
    expect(resolvePortalIdForJob("48491", {})).toBe("williamson-publicsearch");
  });

  it("Williamson publicsearch entryUrl is portal root (not /terms — prod 404)", () => {
    const portal = P85_PORTALS.find((p) => p.portalId === "williamson-publicsearch");
    expect(portal?.entryUrl).toBe("https://williamson.tx.publicsearch.us/");
    expect(portal?.entryUrl).not.toMatch(/\/terms/);
  });

  it("honours explicit portalId in request payload", () => {
    expect(
      resolvePortalIdForJob("48491", { portalId: "williamson-tylerhost" }),
    ).toBe("williamson-tylerhost");
  });

  it("returns null for counties outside P-85", () => {
    expect(resolvePortalIdForJob("48141", {})).toBeNull();
  });
});

describe("runRecipeForJob — Aumentum index search", () => {
  const bastropCtx: RecordsRecipeContext = {
    jobId: "job-bastrop",
    countyFips: "48021",
    parcelKey: "apn:48021:34161",
    portalId: "bastrop-aumentum",
    requestPayload: {
      searchTerms: {
        ownerName: "SMITH JOHN",
        legalDescription: "LOT 1 BLK 2 PECAN GROVE",
      },
    },
  };

  it("completes Bastrop index search when queries submit", async () => {
    const browser = mockBrowser({
      fill: vi.fn().mockResolvedValue({ ok: true }),
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchResults.aspx",
        ),
      pageIncludes: vi.fn(async (text: string) =>
        text.toLowerCase().includes("records found"),
      ),
    });
    const result = await runRecipeForJob(bastropCtx, browser);
    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.portalId).toBe("bastrop-aumentum");
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "owner-name" }),
      ]),
    );
  });

  it("fails closed when owner search stays on SearchEntry after submit", async () => {
    const browser = mockBrowser({
      fill: vi.fn().mockResolvedValue({ ok: true }),
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://cc.co.bastrop.tx.us/RealEstate/SearchEntry.aspx",
        ),
      pageIncludes: vi.fn(async (text: string) =>
        text.toLowerCase().includes("please enter search criteria"),
      ),
    });
    const result = await runRecipeForJob(bastropCtx, browser);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe(SEARCH_FILL_DID_NOT_SUBMIT);
    expect(result.status).not.toBe("complete");
  });

  it("fails closed when entry navigation fails", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    });
    const result = await runRecipeForJob(bastropCtx, browser);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("portal-unreachable");
  });

  it("routes to needs-human when search terms are absent", async () => {
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: true }),
    });
    const result = await runRecipeForJob(
      { ...bastropCtx, requestPayload: {} },
      browser,
    );
    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("search-terms-missing");
  });
});

describe("runRecipeForJob — Caldwell CountyGovernmentRecords index search (P-113)", () => {
  const caldwellCtx: RecordsRecipeContext = {
    jobId: "job-caldwell",
    countyFips: "48055",
    parcelKey: "apn:48055:10001",
    portalId: "caldwell-clerk-web",
    requestPayload: {
      searchTerms: { ownerName: "SMITH JOHN" },
    },
  };

  it("fails closed to needs-human/login-required on the real splash-to-login flow (verified live 2026-09-03: no anonymous search path exists on this vendor)", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue(
          "https://tx.countygovernmentrecords.com/texas/web/login.jsp?submit=Enter",
        ),
    });
    const result = await runRecipeForJob(caldwellCtx, browser);
    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("login-required");
    expect(result.scopeSearched?.recipeVersion).toBe(
      "p85-caldwell-countygovernmentrecords-v1",
    );
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(browser.goto).toHaveBeenCalledWith(
      "https://tx.countygovernmentrecords.com/texas/web/",
    );
    // Evidentiary capture of the login wall, SHA-256 present.
    expect(result.scopeSearched?.captures).toEqual(
      expect.arrayContaining([expect.objectContaining({ sha256: "abc123" })]),
    );
  });

  it("fails closed when entry navigation fails", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    });
    const result = await runRecipeForJob(caldwellCtx, browser);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("portal-unreachable");
  });

  it("would run an owner-name search if the vendor ever exposed an anonymous surface (dead-code guard — not reachable on the real portal today)", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      click: vi.fn().mockResolvedValue({ ok: true }),
      fill: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi
        .fn()
        .mockResolvedValue("https://tx.countygovernmentrecords.com/texas/web/search.jsp"),
      pageIncludes: vi.fn().mockResolvedValue(false),
    });
    const result = await runRecipeForJob(caldwellCtx, browser);
    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.queries).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "owner-name" })]),
    );
  });
});

describe("runRecipeForJob — Tyler index search", () => {
  const haysCtx: RecordsRecipeContext = {
    jobId: "job-hays",
    countyFips: "48209",
    parcelKey: "apn:48209:12345",
    portalId: "hays-erss",
    requestPayload: {
      searchTerms: { ownerName: "SMITH JOHN" },
    },
  };

  it("completes with capture when owner search submits", async () => {
    const browser = mockBrowser({
      fill: vi.fn().mockResolvedValue({ ok: true }),
      click: vi.fn().mockResolvedValue({ ok: true }),
      currentUrl: vi.fn().mockResolvedValue("https://erss.co.hays.tx.us/web/search/DOCSEARCH149S1"),
    });
    const result = await runRecipeForJob(haysCtx, browser);
    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.captures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: "abc123" }),
      ]),
    );
  });

  it("routes to needs-human when owner name is absent", async () => {
    const browser = mockBrowser();
    const result = await runRecipeForJob(
      { ...haysCtx, requestPayload: {} },
      browser,
    );
    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("search-terms-missing");
  });
});
