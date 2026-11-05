import { describe, expect, it, vi } from "vitest";
import {
  fetchAllowlistedUrl,
  fetchCodeSection,
  isAllowlistedWebHost,
} from "../webCodeFetch/index";
import { buildDriverUrls } from "../webCodeFetch/drivers";
import type { HttpFetcher } from "../webCodeFetch/types";

// G-309 item 5: nothing fetches any iccsafe.org page (any subdomain).
const PLANTED = [
  "https://codes.iccsafe.org/content/IRC2021P1/chapter-3",
  "https://www.iccsafe.org/products-and-services/",
  "https://shop.iccsafe.org/x",
  "https://CODES.ICCSAFE.ORG./content/IBC2021P1",
];

describe("G-309 item 5: ICC site is never fetched", () => {
  it.each(PLANTED)("fetchAllowlistedUrl refuses %s and never calls the fetcher", async (url) => {
    const http = vi.fn<HttpFetcher>();
    await expect(fetchAllowlistedUrl(url, http)).rejects.toThrow(/not on allowlist/);
    expect(http).not.toHaveBeenCalled();
  });

  it("no ICC host is allowlisted, even by subdomain or lookalike", () => {
    for (const u of PLANTED) {
      expect(isAllowlistedWebHost(new URL(u).hostname)).toBe(false);
    }
  });

  it("buildDriverUrls with the icc driver yields no iccsafe URL (national, Texas, Florida)", () => {
    for (const jurisdictionKey of ["austin_tx", "miami_beach_fl"]) {
      const urls = buildDriverUrls({
        codeRef: "IRC-R301.1",
        edition: "IRC 2021",
        editionSlug: "irc-2021",
        jurisdictionKey,
        drivers: ["icc", "upcodes", "florida"],
      });
      expect(urls.some((u) => /iccsafe/i.test(u.url))).toBe(false);
      expect(urls.some((u) => u.driver === "icc")).toBe(false);
    }
  });

  it("fetchCodeSection never passes an iccsafe URL to the fetcher; other hosts still served", async () => {
    const seen: string[] = [];
    const http: HttpFetcher = async (url) => {
      seen.push(url);
      return { status: 200, body: "<html><body>nothing</body></html>", finalUrl: url };
    };
    await fetchCodeSection(
      { codeRef: "NEC Art. 220", edition: "NEC 2017", jurisdictionKey: "austin_tx" },
      { http },
    );
    expect(seen.length).toBeGreaterThan(0); // non-ICC (up.codes) driver still works
    expect(seen.some((u) => /iccsafe/i.test(u))).toBe(false);
  });

  it("non-ICC allowlisted host is still accepted", async () => {
    const http = vi.fn<HttpFetcher>().mockResolvedValue({
      status: 200,
      body: "ok",
      finalUrl: "https://www.nfpa.org/x",
    });
    const res = await fetchAllowlistedUrl("https://www.nfpa.org/x", http);
    expect(res.status).toBe(200);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
