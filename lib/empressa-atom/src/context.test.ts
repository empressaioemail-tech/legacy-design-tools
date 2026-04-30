import { describe, it, expect, vi } from "vitest";
import { httpContextSummary } from "./context";
import { defaultScope } from "./scope";

function makeFetch(
  responses: Array<{ status?: number; body: unknown } | Error>,
): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++];
    if (!r) throw new Error("fetch called more times than scripted");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("httpContextSummary", () => {
  it("returns a four-layer payload with safe defaults", async () => {
    const handle = httpContextSummary("task", {
      fetchImpl: makeFetch([{ body: { prose: "hello" } }]),
      ttlMs: 0,
    });
    const got = await handle.contextSummary("id-1", defaultScope());
    expect(got.prose).toBe("hello");
    expect(got.typed).toEqual({});
    expect(got.keyMetrics).toEqual([]);
    expect(got.relatedAtoms).toEqual([]);
    expect(got.historyProvenance).toEqual({
      latestEventId: "",
      latestEventAt: "",
    });
    expect(got.scopeFiltered).toBe(false);
  });

  it("caches within TTL and refreshes after invalidate", async () => {
    const fetchSpy = vi.fn();
    const fetchImpl = (async (...args: unknown[]) => {
      fetchSpy(...args);
      return new Response(JSON.stringify({ prose: `n=${fetchSpy.mock.calls.length}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handle = httpContextSummary("task", { fetchImpl, ttlMs: 60_000 });
    const a = await handle.contextSummary("id-1", defaultScope());
    const b = await handle.contextSummary("id-1", defaultScope());
    expect(a.prose).toBe("n=1");
    expect(b.prose).toBe("n=1"); // cache hit
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    handle.invalidate("id-1");
    const c = await handle.contextSummary("id-1", defaultScope());
    expect(c.prose).toBe("n=2");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("expires entries after the TTL elapses", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const handle = httpContextSummary("task", {
        fetchImpl: makeFetch([
          { body: { prose: "first" } },
          { body: { prose: "second" } },
        ]),
        ttlMs: 1_000,
      });
      const a = await handle.contextSummary("id-1", defaultScope());
      expect(a.prose).toBe("first");
      now += 2_000; // step past TTL
      const b = await handle.contextSummary("id-1", defaultScope());
      expect(b.prose).toBe("second");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("throws on non-200 with a useful message", async () => {
    const handle = httpContextSummary("task", {
      fetchImpl: makeFetch([{ status: 503, body: { error: "down" } }]),
      ttlMs: 0,
    });
    await expect(
      handle.contextSummary("id-1", defaultScope()),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("keys the cache by scope so different audiences do not share entries", async () => {
    const fetchSpy = vi.fn();
    const fetchImpl = (async (...args: unknown[]) => {
      fetchSpy(...args);
      return new Response(
        JSON.stringify({ prose: `n=${fetchSpy.mock.calls.length}` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const handle = httpContextSummary("task", { fetchImpl, ttlMs: 60_000 });
    const ai = await handle.contextSummary("id-1", { audience: "ai" });
    const user = await handle.contextSummary("id-1", { audience: "user" });
    const aiAgain = await handle.contextSummary("id-1", { audience: "ai" });
    expect(ai.prose).toBe("n=1");
    expect(user.prose).toBe("n=2");
    expect(aiAgain.prose).toBe("n=1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // as-of is part of the cache key too
    const t1 = await handle.contextSummary("id-1", {
      audience: "ai",
      asOf: new Date("2026-01-01T00:00:00Z"),
    });
    expect(t1.prose).toBe("n=3");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("forwards the scope to the server as a query parameter", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = (async (url: string) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({ prose: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const handle = httpContextSummary("task", { fetchImpl, ttlMs: 0 });
    await handle.contextSummary("id-1", {
      audience: "ai",
      requestor: { kind: "user", id: "u-1" },
    });
    expect(seenUrls).toHaveLength(1);
    const url = seenUrls[0]!;
    expect(url).toMatch(/\/atoms\/task\/id-1\/summary\?scope=/);
    const scopeParam = decodeURIComponent(url.split("scope=")[1]!);
    const parsed = JSON.parse(scopeParam);
    expect(parsed.a).toBe("ai");
    expect(parsed.r).toBe("user:u-1");
  });

  it("invalidate() drops all scope variants for the entity", async () => {
    const fetchSpy = vi.fn();
    const fetchImpl = (async () => {
      fetchSpy();
      return new Response(
        JSON.stringify({ prose: `n=${fetchSpy.mock.calls.length}` }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const handle = httpContextSummary("task", { fetchImpl, ttlMs: 60_000 });
    await handle.contextSummary("id-1", { audience: "ai" });
    await handle.contextSummary("id-1", { audience: "user" });
    await handle.contextSummary("id-2", { audience: "ai" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    handle.invalidate("id-1");
    // id-1 variants are gone, id-2 still cached
    await handle.contextSummary("id-1", { audience: "ai" });
    await handle.contextSummary("id-1", { audience: "user" });
    await handle.contextSummary("id-2", { audience: "ai" });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it("clear() drops every cached entry", async () => {
    const fetchSpy = vi.fn();
    const fetchImpl = (async () => {
      fetchSpy();
      return new Response(JSON.stringify({ prose: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const handle = httpContextSummary("task", { fetchImpl, ttlMs: 60_000 });
    await handle.contextSummary("id-1", defaultScope());
    await handle.contextSummary("id-2", defaultScope());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    handle.clear();
    await handle.contextSummary("id-1", defaultScope());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
