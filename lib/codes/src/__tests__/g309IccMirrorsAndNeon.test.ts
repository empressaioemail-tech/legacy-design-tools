import { describe, expect, it, vi, beforeEach } from "vitest";

let planted: Array<Record<string, unknown>> = [];

vi.mock("@workspace/db", () => {
  const chain: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown) => res(planted);
      }
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return { db: { select: () => chain }, codeAtoms: {}, codeAtomSources: {} };
});
vi.mock("../embeddings", () => ({
  embedQuery: vi.fn().mockResolvedValue(null),
}));

import {
  fetchAllowlistedUrl,
  fetchCodeSection,
  isAllowlistedWebHost,
} from "../webCodeFetch/index";
import { buildDriverUrls } from "../webCodeFetch/drivers";
import type { HttpFetcher } from "../webCodeFetch/types";
import { retrieveAtomsForQuestion } from "../retrieval";

const ICC_MIRROR_URLS = [
  "https://up.codes/viewer/texas/irc-2021/chapter/3/R301.1",
  "https://up.codes/viewer/texas/ibc-2021/chapter/10",
  "https://up.codes/viewer/colorado/iwuic-2021/chapter/5",
  "https://www.up.codes/viewer/austin/iecc-2021/chapter/4",
  "https://up.codes/viewer/texas/international-fire-code-2021/chapter/5",
  "https://up.codes/viewer/texas/icc-a117.1-2017/chapter/3",
];

describe("G-309 A15: ICC I-Code titles are refused on mirrors", () => {
  it.each(ICC_MIRROR_URLS)("fetchAllowlistedUrl refuses %s", async (url) => {
    const http = vi.fn<HttpFetcher>();
    await expect(fetchAllowlistedUrl(url, http)).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });

  it("non-ICC up.codes URLs are still accepted", async () => {
    for (const url of [
      "https://up.codes/viewer/florida/florida-building-code-2023",
      "https://up.codes/viewer/texas/nfpa-70-2017/chapter/2",
      "https://up.codes/viewer/austin/city-of-austin-ordinance/chapter/25",
    ]) {
      const http = vi.fn<HttpFetcher>().mockResolvedValue({
        status: 200,
        body: "ok",
        finalUrl: url,
      });
      const res = await fetchAllowlistedUrl(url, http);
      expect(res.status).toBe(200);
      expect(http).toHaveBeenCalledTimes(1);
    }
  });

  it("buildDriverUrls builds no ICC-title URL for any driver", () => {
    for (const [codeRef, edition, editionSlug] of [
      ["IRC-R301.1", "IRC 2021", "irc-2021"],
      ["IBC-1004.5", "IBC 2021", "ibc-2021"],
      ["IECC-R-402.1", "IECC 2021", "iecc-2021"],
    ]) {
      const urls = buildDriverUrls({
        codeRef: codeRef!,
        edition: edition!,
        editionSlug: editionSlug!,
        jurisdictionKey: "austin_tx",
        drivers: ["icc", "upcodes", "florida", "nfpa"],
      });
      expect(urls.map((u) => u.url)).toEqual([]);
    }
  });

  it("fetchCodeSection for an ICC title never calls the fetcher", async () => {
    const http = vi.fn<HttpFetcher>();
    await fetchCodeSection(
      { codeRef: "IRC-R301.1", edition: "IRC 2021", jurisdictionKey: "austin_tx" },
      { http },
    ).catch(() => undefined);
    expect(http).not.toHaveBeenCalled();
  });
});

describe("G-309 lookalike hosts", () => {
  it("rejects lookalikes, accepts exact host and true subdomain", () => {
    expect(isAllowlistedWebHost("notnfpa.org")).toBe(false);
    expect(isAllowlistedWebHost("nfpa.org.evil.com")).toBe(false);
    expect(isAllowlistedWebHost("xup.codes")).toBe(false);
    expect(isAllowlistedWebHost("nfpa.org")).toBe(true);
    expect(isAllowlistedWebHost("www.nfpa.org")).toBe(true);
    expect(isAllowlistedWebHost("sub.nfpa.org")).toBe(true);
    expect(isAllowlistedWebHost("up.codes")).toBe(true);
  });
});

describe("G-309 fix 3: Neon retrieval keeps ICC-title atoms out", () => {
  beforeEach(() => {
    process.env.BRIEF_CODE_RETRIEVAL = "neon";
    delete process.env.BRIEF_RETRIEVAL_API_URL;
    delete process.env.BRIEF_RETRIEVAL_API_KEY;
  });

  const row = (over: Record<string, unknown>) => ({
    id: "id",
    sourceName: "grand_county_pdf",
    jurisdictionKey: "grand_county_ut",
    codeBook: "LAND_USE",
    edition: "2021",
    sectionNumber: "5.4",
    sectionTitle: "setback requirements",
    body: "setback requirements local text",
    sourceUrl: "https://example.test/x",
    ...over,
  });

  it("drops ICC-title atoms from a county source, keeps local atoms", async () => {
    planted = [
      row({ id: "a1", codeBook: "IWUIC", sourceName: "grand_county_pdf" }),
      row({ id: "a2", codeBook: "IRC_R301_2_1", sourceName: "grand_county_html" }),
      row({ id: "a3", codeBook: "LAND_USE" }),
    ];
    const out = await retrieveAtomsForQuestion({
      jurisdictionKey: "grand_county_ut",
      question: "setback requirements",
    });
    expect(out.map((a) => a.id)).toEqual(["a3"]);
  });
});
