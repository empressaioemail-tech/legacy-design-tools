import { describe, expect, it, vi } from "vitest";
import { runRecipeForJob } from "./index.js";
import {
  PUBLICSEARCH_RECIPE_VERSION,
  publicsearchIndexSearchScope,
  runPublicsearchRecipe,
  WILLIAMSON_GRADING_PARCEL,
} from "./publicsearchSearch.js";
import { portalConfigById } from "./p85Portals.js";
import type { RecordsRecipeBrowser } from "./types.js";

function mockBrowser(overrides: Partial<RecordsRecipeBrowser> = {}): RecordsRecipeBrowser {
  return {
    goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    captureFullPage: vi.fn().mockResolvedValue({
      ok: true,
      sha256: "deadbeefcafe",
      byteLength: 2048,
      label: "owner-name-results",
    }),
    click: vi.fn().mockResolvedValue({ ok: false }),
    fill: vi.fn().mockResolvedValue({ ok: false }),
    pressEnter: vi.fn().mockResolvedValue({ ok: false }),
    pageIncludes: vi.fn().mockResolvedValue(false),
    currentUrl: vi.fn().mockResolvedValue("https://williamson.tx.publicsearch.us/"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "",
      visibleMainControls: [],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

describe("publicsearchIndexSearchScope fixture", () => {
  it("documents the expected scopeSearched shape for Williamson index-search grading", () => {
    const portal = portalConfigById("williamson-publicsearch")!;
    const captures = [
      {
        label: "owner-name-results",
        sha256: "deadbeefcafe",
        byteLength: 2048,
        timestamp: "2026-08-27T12:00:00.000Z",
      },
    ];
    const queries = [
      {
        kind: "owner-name",
        query: "PURVIS MICHAEL",
        timestamp: "2026-08-27T12:00:00.000Z",
      },
    ];

    expect(
      publicsearchIndexSearchScope(WILLIAMSON_GRADING_PARCEL, portal, {
        stepsReached: [
          "open-entry",
          "accept-terms",
          "open-portal",
          "fill-owner-query",
          "submit-search",
        ],
        queries,
        captures,
        resultCount: 0,
        indexHits: [],
      }),
    ).toEqual({
      portalId: "williamson-publicsearch",
      countyFips: "48491",
      parcelKey: "apn:48491:R062578",
      recipeVersion: PUBLICSEARCH_RECIPE_VERSION,
      mode: "index-search",
      stepsReached: [
        "open-entry",
        "accept-terms",
        "open-portal",
        "fill-owner-query",
        "submit-search",
      ],
      queries,
      captures,
      resultCount: 0,
      indexHits: [],
      documentTypes: "all",
      dateRange: "portal-default",
    });
  });
});

describe("runPublicsearchRecipe", () => {
  const portal = portalConfigById("williamson-publicsearch")!;

  it("completes with index-search scope and capture hash when owner search submits", async () => {
    const browser = mockBrowser({
      click: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true }),
      fill: vi.fn().mockResolvedValue({ ok: true }),
    });

    const result = await runPublicsearchRecipe(
      WILLIAMSON_GRADING_PARCEL,
      portal,
      browser,
    );

    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.portalId).toBe("williamson-publicsearch");
    expect(result.scopeSearched?.recipeVersion).toBe(PUBLICSEARCH_RECIPE_VERSION);
    expect(result.scopeSearched?.captures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "owner-name-results",
          sha256: "deadbeefcafe",
          byteLength: 2048,
        }),
      ]),
    );
    expect(result.scopeSearched?.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "owner-name",
          query: "PURVIS MICHAEL",
        }),
      ]),
    );
    expect(result.scopeSearched?.stepsReached).toEqual(
      expect.arrayContaining([
        "open-entry",
        "open-portal",
        "fill-owner-query",
        "submit-search",
      ]),
    );
  });

  it("routes to needs-human with index-search scope when owner name is absent", async () => {
    const browser = mockBrowser();
    const result = await runPublicsearchRecipe(
      { ...WILLIAMSON_GRADING_PARCEL, requestPayload: {} },
      portal,
      browser,
    );

    expect(result.status).toBe("needs-human");
    expect(result.errorCode).toBe("search-terms-missing");
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.missingInput).toBe("ownerName");
  });

  it("fails closed when entry navigation fails", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    });
    const result = await runPublicsearchRecipe(
      WILLIAMSON_GRADING_PARCEL,
      portal,
      browser,
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("portal-unreachable");
    expect(result.scopeSearched).toBeUndefined();
  });
});

describe("runRecipeForJob — Williamson publicsearch (default portal)", () => {
  it("resolves williamson-publicsearch by county default and runs index-search", async () => {
    const browser = mockBrowser({
      click: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true }),
      fill: vi.fn().mockResolvedValue({ ok: true }),
    });

    const result = await runRecipeForJob(WILLIAMSON_GRADING_PARCEL, browser);

    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.captures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sha256: expect.any(String) }),
      ]),
    );
  });
});
