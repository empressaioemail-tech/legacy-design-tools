import { describe, expect, it } from "vitest";

import {
  executeFeasibilityExport,
  feasibilityNotConfiguredResult,
} from "../src/feasibility-export.js";

const CONFIG = { baseUrl: "https://hauska-engine.test", gateToken: "gate-key" };
const PARCEL = "48021:34137";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// P-155 (OPS-23 FEASIBILITY, 2026-09-11): the engine's refresh is now
// asynchronous — executeFeasibilityExport reads STATUS first (never blindly
// re-refreshes), starts a job only when none is in flight or the last one
// failed, then polls status inside its own budget before downloading. These
// tests route by URL SUFFIX exactly like the pre-P-155 file, adding a
// third leg (the bare feasibility-export resource, no /refresh or
// /download suffix) for the status read.
function router(routes: {
  status?: (call: number) => unknown | Response;
  refresh?: () => unknown | Response;
  download?: () => unknown | Response;
}) {
  let statusCalls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/refresh")) {
      if (!routes.refresh) throw new Error(`unexpected refresh fetch: ${url}`);
      const out = routes.refresh();
      return out instanceof Response ? out : jsonResponse(out);
    }
    if (url.endsWith("/download")) {
      if (!routes.download) throw new Error(`unexpected download fetch: ${url}`);
      const out = routes.download();
      return out instanceof Response ? out : jsonResponse(out);
    }
    // Status GETs the bare resource — checked last so its substring never
    // shadows the two more specific suffixes above.
    if (!routes.status) throw new Error(`unexpected status fetch: ${url}`);
    statusCalls += 1;
    const out = routes.status(statusCalls);
    void init;
    return out instanceof Response ? out : jsonResponse(out);
  }) as typeof fetch;
}

describe("feasibility-export (P-119 / OPS-16 A-103, async since P-155)", () => {
  it("feasibilityNotConfiguredResult is a declared degraded body, tool-scoped like the Hauska one", () => {
    const result = feasibilityNotConfiguredResult();
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      status: "degraded",
      tool: "export_instrument",
      kind: "feasibility",
      reason: "engine_api_not_configured",
      dependency: "hauska-engine-api",
    });
  });

  it("executeFeasibilityExport returns the not-configured result when no engine-api config loads, and never calls fetch", async () => {
    const fetchImpl = async () => {
      throw new Error("fetch must not run when engine-api is not configured");
    };
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => null, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "degraded",
      reason: "engine_api_not_configured",
    });
  });

  it("never-requested: starts a job, polls to ready, downloads — returns base64 bytes with the result summary fields", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries());
      calls.push({ url, method: init?.method ?? "GET", headers });
      if (url.endsWith("/refresh")) {
        return jsonResponse({ state: "queued", jobRef: "job-1", pollAfterMs: 1 });
      }
      if (url.endsWith("/download")) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      // status: first call (before refresh) -> never-requested; after
      // refresh -> ready on the FIRST poll.
      const isFirstStatusCall = calls.filter((c) => !c.url.endsWith("/refresh") && !c.url.endsWith("/download")).length === 1;
      if (isFirstStatusCall) return jsonResponse({ state: "never-requested" });
      return jsonResponse({
        state: "ready",
        result: {
          pageCount: 16,
          feasibilityPageCount: 12,
          sitePlanAppended: true,
          sectionCount: 16,
          openItemCount: 3,
          narrativeIsDeterministicSkeleton: true,
        },
      });
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      status: "ok",
      tool: "export_instrument",
      kind: "feasibility",
      parcelNodeId: PARCEL,
      format: "pdf-feasibility",
      pageCount: 16,
      feasibilityPageCount: 12,
      sitePlanAppended: true,
      sectionCount: 16,
      openItemCount: 3,
      narrativeIsDeterministicSkeleton: true,
    });
    expect(parsed.download).toMatchObject({
      format: "pdf-feasibility",
      contentType: "application/pdf",
      byteCount: 4,
    });
    expect(Buffer.from(parsed.download.base64, "base64")).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
    );

    // Pinned route shape: /v1/property-nodes/{parcelNodeId}/feasibility-export{,/refresh,/download}.
    expect(calls[0]!.url).toBe(
      "https://hauska-engine.test/v1/property-nodes/48021%3A34137/feasibility-export",
    );
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe("Bearer gate-key");
    expect(calls[0]!.headers["x-hauska-package-id"]).toBe("feasibility-export");
    const refreshCall = calls.find((c) => c.url.endsWith("/refresh"));
    expect(refreshCall?.method).toBe("POST");
    const downloadCall = calls.find((c) => c.url.endsWith("/download"));
    expect(downloadCall).toBeTruthy();
  });

  it("ready on the FIRST status read (a prior call already finished the job) downloads immediately, no refresh", async () => {
    const fetchImpl = router({
      status: () => ({
        state: "ready",
        result: { pageCount: 9, sectionCount: 5, openItemCount: 1 },
      }),
      refresh: () => {
        throw new Error("refresh must not run when the job is already ready");
      },
      download: () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "ok", sectionCount: 5 });
  });

  it("running on the first read waits (no refresh) and settles to ready on a later poll", async () => {
    const fetchImpl = router({
      status: (call) =>
        call === 1
          ? { state: "running", jobRef: "job-2", pollAfterMs: 1 }
          : { state: "ready", result: { sectionCount: 7 } },
      refresh: () => {
        throw new Error("refresh must not run when a job is already running");
      },
      download: () => new Response(new Uint8Array([9]), { status: 200 }),
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "ok", sectionCount: 7 });
  });

  it("a 422 refresh failure is the engine's own honest miss, declared with the shared envelope — never a bare pass-through", async () => {
    const fetchImpl = router({
      status: () => ({ state: "never-requested" }),
      refresh: () => jsonResponse({ message: "No resolvable site plan for this parcel." }, 422),
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "error",
      tool: "export_instrument",
      kind: "feasibility",
      reason: "feasibility_export_failed",
      message: "No resolvable site plan for this parcel.",
    });
  });

  it("a generic non-OK refresh is a declared upstream error carrying the shared envelope", async () => {
    const fetchImpl = router({
      status: () => ({ state: "never-requested" }),
      refresh: () => new Response("gateway timeout", { status: 504 }),
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({ status: "error", tool: "export_instrument", kind: "feasibility" });
    expect(parsed.message).toContain("gateway timeout");
  });

  it("a job that SETTLES to failed maps to the shared envelope with its errorClass, never reported as ready", async () => {
    const fetchImpl = router({
      status: (call) =>
        call === 1
          ? { state: "never-requested" }
          : { state: "failed", errorClass: "geometry_unavailable", errorMessage: "parcel geometry could not be resolved" },
      refresh: () => ({ state: "queued", jobRef: "job-3", pollAfterMs: 1 }),
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "error",
      reason: "geometry_unavailable",
      message: "parcel geometry could not be resolved",
    });
  });

  it.each([
    [404, "artifact_unavailable"],
    [410, "artifact_evicted"],
  ] as const)(
    "a %i download is the pinned honest cache-miss state (%s), declared with the shared envelope",
    async (status, reason) => {
      const fetchImpl = router({
        status: () => ({ state: "ready", result: {} }),
        download: () => jsonResponse({ error: reason }, status),
      });
      const result = await executeFeasibilityExport(
        { parcelNodeId: PARCEL },
        { loadConfig: () => CONFIG, fetchImpl },
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        status: "error",
        tool: "export_instrument",
        kind: "feasibility",
        reason,
      });
    },
  );

  it("a generic non-OK download is a declared upstream error", async () => {
    const fetchImpl = router({
      status: () => ({ state: "ready", result: {} }),
      download: () => new Response("bad gateway", { status: 502 }),
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("bad gateway");
  });

  it("a thrown transport error on the status read is DECLARED (the bare abort text is retired)", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      status: "error",
      tool: "export_instrument",
      kind: "feasibility",
      reason: "engine_unreachable",
      message: "fetch failed: ECONNREFUSED",
    });
  });

  it("a thrown transport error on refresh is DECLARED the same way", async () => {
    const fetchImpl = router({
      status: () => ({ state: "never-requested" }),
      refresh: () => {
        throw new Error("engine-api refresh hop: socket hang up");
      },
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "error",
      reason: "engine_unreachable",
      message: "engine-api refresh hop: socket hang up",
    });
  });

  it("a thrown transport error on download is DECLARED the same way, and the ready state is not reported as success", async () => {
    const fetchImpl = router({
      status: () => ({ state: "ready", result: {} }),
      download: () => {
        throw new Error("engine-api download hop: socket hang up");
      },
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "error",
      reason: "engine_unreachable",
      message: "engine-api download hop: socket hang up",
    });
  });

  it("still queued/running past this call's own poll budget returns a DECLARED in-progress result — isError:false, never a failure", async () => {
    const fetchImpl = router({
      // Every status read says running with a tiny pollAfterMs, so the
      // poll loop spins quickly against the (short, test-only) budget
      // rather than genuinely waiting the production 55s.
      status: () => ({ state: "running", jobRef: "job-4", pollAfterMs: 1 }),
      refresh: () => {
        throw new Error("refresh must not run when a job is already running");
      },
    });
    const result = await executeFeasibilityExport(
      { parcelNodeId: PARCEL },
      // Test-only short budget (see FeasibilityExportDeps.pollBudgetMs) so
      // this exercises the real "still not done" branch in milliseconds
      // rather than the production 55s.
      { loadConfig: () => CONFIG, fetchImpl, pollBudgetMs: 20 },
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      status: "in_progress",
      tool: "export_instrument",
      kind: "feasibility",
      state: "running",
      jobRef: "job-4",
    });
    expect(typeof parsed.pollAfterMs).toBe("number");
  });
});
