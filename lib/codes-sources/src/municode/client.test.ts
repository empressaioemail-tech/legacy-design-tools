/**
 * municode/client.ts protects against:
 *   - hammering api.municode.com (1.5s spacing, daily cap)
 *   - retryable transient failures (429, 5xx) — bounded retry with backoff
 *   - non-retryable client errors (4xx) — fail loud
 *
 * Tests run with rate-limit overrides set to 0 so they finish quickly. The
 * production defaults are restored between tests by
 * __resetMunicodeClientStateForTesting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClientByName,
  getClientContent,
  getCodesContent,
  getLatestJob,
  getTocChildren,
  municodeGet,
  municodeStats,
  MunicodeError,
  MunicodeDailyCapExceeded,
  __resetMunicodeClientStateForTesting,
  __setRateLimitOverridesForTesting,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  __resetMunicodeClientStateForTesting();
  __setRateLimitOverridesForTesting({
    minGapMs: 0,
    jitterMaxMs: 0,
    retryBackoffsMs: [1, 1, 1],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetMunicodeClientStateForTesting();
});

describe("municodeGet: HTTP basics", () => {
  it("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ hello: "world" })));
    const data = await municodeGet({ path: "/x", params: {} });
    expect(data).toEqual({ hello: "world" });
  });

  it("returns null on 204 (no content)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const data = await municodeGet({ path: "/x", params: {} });
    expect(data).toBeNull();
  });

  it("sends the Hauska User-Agent and Accept: application/json", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await municodeGet({ path: "/x", params: {} });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Hauska-CodeAtoms/);
    expect(headers.Accept).toBe("application/json");
  });

  it("serializes params into the query string", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await municodeGet({
      path: "/codesToc/children",
      params: { jobId: 123, productId: 456, nodeId: "ABC" },
    });
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toMatch(/api\.municode\.com\/codesToc\/children/);
    expect(url).toMatch(/jobId=123/);
    expect(url).toMatch(/productId=456/);
    expect(url).toMatch(/nodeId=ABC/);
  });

  it("skips undefined params (does not write 'undefined' into the URL)", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await municodeGet({
      path: "/codesToc/children",
      params: { jobId: 1, productId: 2, nodeId: undefined },
    });
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).not.toMatch(/nodeId/);
  });
});

describe("municodeGet: error handling and retry", () => {
  it("throws MunicodeError with the status code on a non-retryable 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    await expect(municodeGet({ path: "/x", params: {} })).rejects.toBeInstanceOf(
      MunicodeError,
    );
    try {
      await municodeGet({ path: "/x", params: {} });
    } catch (e) {
      expect((e as MunicodeError).status).toBe(404);
      expect((e as MunicodeError).body).toBe("Not Found");
    }
  });

  it("retries on 429, then succeeds on the second attempt", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("Rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await municodeGet({ path: "/x", params: {} });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx up to the backoff schedule, then throws", async () => {
    // backoffs = [1,1,1] → 4 attempts total
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("server boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(municodeGet({ path: "/x", params: {} })).rejects.toBeInstanceOf(
      MunicodeError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry on a non-retryable 4xx (one fetch call only)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(municodeGet({ path: "/x", params: {} })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("municodeGet: daily cap", () => {
  it("throws MunicodeDailyCapExceeded once dailyUsed reaches the cap", async () => {
    __setRateLimitOverridesForTesting({
      minGapMs: 0,
      jitterMaxMs: 0,
      dailyCap: 2,
      retryBackoffsMs: [1],
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    await municodeGet({ path: "/x", params: {} });
    await municodeGet({ path: "/x", params: {} });
    await expect(municodeGet({ path: "/x", params: {} })).rejects.toBeInstanceOf(
      MunicodeDailyCapExceeded,
    );
  });

  it("municodeStats reports current usage and the user-agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    await municodeGet({ path: "/x", params: {} });
    const stats = municodeStats();
    expect(stats.dailyUsed).toBeGreaterThanOrEqual(1);
    expect(stats.userAgent).toMatch(/Hauska-CodeAtoms/);
    expect(stats.dailyResetIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("typed wrappers", () => {
  it("getClientByName returns null when API returns a non-object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(null)));
    expect(await getClientByName("Bogus", "ZZ")).toBeNull();
  });

  it("getClientByName returns the object when API returns one with ClientID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ClientID: 42, ClientName: "Bastrop" }),
      ),
    );
    const info = await getClientByName("Bastrop", "TX");
    expect(info?.ClientID).toBe(42);
  });

  it("getClientContent returns the codes envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ codes: [{ productName: "C", productId: 7 }] }),
      ),
    );
    const out = await getClientContent(1);
    expect(out.codes[0].productId).toBe(7);
  });

  it("getLatestJob returns the job object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ Id: 99, Name: "Sup 1", ProductId: 7 })),
    );
    const job = await getLatestJob(7);
    expect(job?.Id).toBe(99);
  });

  it("getTocChildren returns [] when API returns null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(null)));
    expect(await getTocChildren(1, 2)).toEqual([]);
  });

  it("getTocChildren returns the array when API returns one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { Id: "x", Heading: "Ch1", ParentId: "", NodeDepth: 1, HasChildren: true, DocOrderId: 1 },
        ]),
      ),
    );
    const out = await getTocChildren(1, 2);
    expect(out).toHaveLength(1);
    expect(out[0].Heading).toBe("Ch1");
  });

  it("getCodesContent returns the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ Docs: [], PdfUrl: null, ShowToc: false }),
      ),
    );
    const env = await getCodesContent(1, 2, "X");
    expect(env.Docs).toEqual([]);
  });
});
