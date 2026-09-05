import { describe, expect, it } from "vitest";

import {
  executeFeasibilityExport,
  feasibilityNotConfiguredResult,
} from "../src/feasibility-export.js";

const CONFIG = { baseUrl: "https://hauska-engine.test", gateToken: "gate-key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("feasibility-export (P-119 / OPS-16 A-103)", () => {
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
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => null, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "degraded",
      reason: "engine_api_not_configured",
    });
  });

  it("refreshes then downloads against the pinned engine-api route shape, and returns base64 bytes with the refresh's honesty fields", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries(),
      );
      calls.push({ url, method: init?.method ?? "GET", headers });
      if (url.endsWith("/refresh")) {
        return jsonResponse({
          atom: { parcelNodeId: "48021:34137" },
          artifacts: { "pdf-feasibility": { format: "pdf-feasibility" } },
          pageCount: 16,
          feasibilityPageCount: 12,
          sitePlanAppended: true,
          sectionCount: 16,
          openItemCount: 3,
          narrativeIsDeterministicSkeleton: true,
        });
      }
      if (url.endsWith("/download")) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => CONFIG, fetchImpl },
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toMatchObject({
      status: "ok",
      tool: "export_instrument",
      kind: "feasibility",
      parcelNodeId: "48021:34137",
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

    // Pinned route shape (hauska-map's own already-live BFF caller, read
    // 2026-09-05): /v1/property-nodes/{parcelNodeId}/feasibility-export/{refresh,download}.
    expect(calls[0]!.url).toBe(
      "https://hauska-engine.test/v1/property-nodes/48021%3A34137/feasibility-export/refresh",
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer gate-key");
    expect(calls[0]!.headers["x-hauska-package-id"]).toBe("feasibility-export");
    expect(calls[1]!.url).toBe(
      "https://hauska-engine.test/v1/property-nodes/48021%3A34137/feasibility-export/download",
    );
  });

  it("a 422 refresh failure is the engine's own honest miss, passed through verbatim — never mapped onto a generic error", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/refresh")) {
        return jsonResponse(
          { message: "No resolvable site plan for this parcel." },
          422,
        );
      }
      throw new Error("download must not be called after a refresh failure");
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      message: "No resolvable site plan for this parcel.",
    });
  });

  it("a generic non-OK refresh is a declared upstream error, and download is never reached", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/refresh")) {
        return new Response("gateway timeout", { status: 504 });
      }
      throw new Error("download must not be called after a refresh failure");
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("gateway timeout");
  });

  it.each([
    [404, "artifact_unavailable"],
    [410, "artifact_evicted"],
  ] as const)(
    "a %i download is the pinned honest cache-miss state (%s), never a fabricated download",
    async (status, reason) => {
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/refresh")) {
          return jsonResponse({
            atom: {},
            artifacts: { "pdf-feasibility": {} },
          });
        }
        if (url.endsWith("/download")) {
          return jsonResponse({ error: reason }, status);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await executeFeasibilityExport(
        { parcelNodeId: "48021:34137" },
        { loadConfig: () => CONFIG, fetchImpl },
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: reason });
    },
  );

  it("a generic non-OK download is a declared upstream error", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/refresh")) {
        return jsonResponse({ atom: {}, artifacts: { "pdf-feasibility": {} } });
      }
      if (url.endsWith("/download")) {
        return new Response("bad gateway", { status: 502 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("bad gateway");
  });

  it("a thrown transport error on refresh surfaces as raw undeclared text (wrapped by tools.ts's ensureDeclaredError, same as export-instrument.ts)", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("fetch failed: ECONNREFUSED");
  });

  it("a thrown transport error on download surfaces the same way, and refresh's own success is not reported", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/refresh")) {
        return jsonResponse({ atom: {}, artifacts: { "pdf-feasibility": {} } });
      }
      throw new Error("engine-api download hop: socket hang up");
    }) as typeof fetch;

    const result = await executeFeasibilityExport(
      { parcelNodeId: "48021:34137" },
      { loadConfig: () => CONFIG, fetchImpl },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("engine-api download hop: socket hang up");
  });
});
