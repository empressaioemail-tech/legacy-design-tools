import { describe, expect, it, vi } from "vitest";
import {
  fetchRobotsTxt,
  originFromPortalUrl,
  parseDisallowRules,
  robotsTxtUrlForOrigin,
} from "./robotsTxt.js";

describe("parseDisallowRules", () => {
  it("collects Disallow paths for User-agent: *", () => {
    const body = [
      "User-agent: *",
      "Disallow: /admin/",
      "Disallow: /private",
      "User-agent: Googlebot",
      "Disallow: /secret",
    ].join("\n");

    expect(parseDisallowRules(body)).toEqual(["/admin/", "/private"]);
  });
});

describe("originFromPortalUrl", () => {
  it("derives origin from portal entry URL", () => {
    expect(
      originFromPortalUrl("https://cc.co.bastrop.tx.us/RealEstate"),
    ).toBe("https://cc.co.bastrop.tx.us");
  });
});

describe("fetchRobotsTxt", () => {
  it("fetches GET /robots.txt and returns parsed disallow rules", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      text: async () =>
        "User-agent: *\nDisallow: /RealEstate/Search\nAllow: /RealEstate\n",
    });

    const result = await fetchRobotsTxt(
      "https://cc.co.bastrop.tx.us/RealEstate",
      { fetchFn, now: () => 1_700_000_000_000 },
    );

    expect(fetchFn).toHaveBeenCalledWith(
      robotsTxtUrlForOrigin("https://cc.co.bastrop.tx.us"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("https://cc.co.bastrop.tx.us/robots.txt");
      expect(result.status).toBe(200);
      expect(result.disallowRules).toEqual(["/RealEstate/Search"]);
      expect(result.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString());
      expect(result.bodySnippet).toContain("Disallow");
    }
  });

  it("returns error record when fetch fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await fetchRobotsTxt("https://example.com/entry", {
      fetchFn,
      now: () => 1_700_000_000_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.url).toBe("https://example.com/robots.txt");
      expect(result.errorMessage).toContain("network down");
    }
  });
});

describe("runRecipeForJob robots wiring", () => {
  it("includes robotsTxt on scopeSearched before recipe navigation", async () => {
    const { runRecipeForJob } = await import("./recipes/index.js");
    const browser = {
      goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      captureFullPage: vi.fn(),
      click: vi.fn(),
      fill: vi.fn(),
      pressEnter: vi.fn(),
      pageIncludes: vi.fn().mockResolvedValue(false),
      currentUrl: vi.fn().mockResolvedValue("https://example.com"),
      extractResultRows: vi.fn().mockResolvedValue([]),
      inspectDocumentPurchase: vi.fn(),
    };

    const fetchRobotsTxtFn = vi.fn().mockResolvedValue({
      ok: true,
      url: "https://www.co.caldwell.tx.us/robots.txt",
      status: 200,
      bodySnippet: "User-agent: *\nDisallow: /private",
      fetchedAt: "2026-09-01T00:00:00.000Z",
      disallowRules: ["/private"],
    });

    const result = await runRecipeForJob(
      {
        jobId: "job-caldwell",
        countyFips: "48055",
        parcelKey: "apn:48055:123",
        portalId: "caldwell-clerk-web",
        requestPayload: {},
      },
      browser,
      { fetchRobotsTxtFn },
    );

    expect(fetchRobotsTxtFn).toHaveBeenCalledWith(
      "https://www.co.caldwell.tx.us/page/County.Clerk",
    );
    expect(fetchRobotsTxtFn.mock.invocationCallOrder[0]).toBeLessThan(
      (browser.goto as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(result.scopeSearched?.robotsTxt).toEqual({
      url: "https://www.co.caldwell.tx.us/robots.txt",
      status: 200,
      bodySnippet: "User-agent: *\nDisallow: /private",
      fetchedAt: "2026-09-01T00:00:00.000Z",
      disallowRules: ["/private"],
    });
  });
});
