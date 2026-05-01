/**
 * HttpMnmlClient — covers the wire contract (POST/GET/DELETE against
 * the Spec 54 §5 endpoints with `Authorization: Bearer …`), the
 * happy-path response mappers, the timeout / network failure
 * translations into MnmlError, and the mnml.ai-side error category
 * mapping (4xx / 429 / 5xx + body `error.code`).
 *
 * Every fetch is stubbed via the injected `fetcher` option so no real
 * network happens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpMnmlClient } from "../httpClient";
import { MnmlError } from "../types";
import type { StillRenderRequest } from "../types";

const BASE_URL = "https://api.mnml.test.invalid";
const API_KEY = "test-key-abc";

const STILL: StillRenderRequest = {
  kind: "still",
  cameraPosition: { x: 0, y: 0, z: 0 },
  cameraTarget: { x: 1, y: 0, z: 0 },
  resolution: "1920x1080",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedCall {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  body?: string;
}

function captureFetcher(
  responses: Response[],
): { fetcher: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers["Authorization"],
      contentType: headers["Content-Type"],
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (i >= responses.length) {
      throw new Error(`captureFetcher: no canned response for call #${i + 1}`);
    }
    return responses[i++]!;
  });
  return { fetcher: fn as unknown as typeof fetch, calls };
}

describe("HttpMnmlClient — triggerRender wire contract", () => {
  it("POSTs JSON to /v1/renders with Bearer auth and returns the renderId", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ id: "rnd-42", status: "queued" }, 202),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const result = await client.triggerRender(STILL);
    expect(result).toEqual({ renderId: "rnd-42", status: "queued" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/renders`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]!.contentType).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual(STILL);
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ id: "rnd-1" }, 202),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: `${BASE_URL}///`,
      apiKey: API_KEY,
      fetcher,
    });
    await client.triggerRender(STILL);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/renders`);
  });

  it("accepts alternate id field names from mnml.ai (`render_id`, `job_id`)", async () => {
    const { fetcher: f1 } = captureFetcher([
      jsonResponse({ render_id: "rnd-render-id" }),
    ]);
    const c1 = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher: f1,
    });
    expect((await c1.triggerRender(STILL)).renderId).toBe("rnd-render-id");

    const { fetcher: f2 } = captureFetcher([
      jsonResponse({ job_id: "rnd-job-id" }),
    ]);
    const c2 = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher: f2,
    });
    expect((await c2.triggerRender(STILL)).renderId).toBe("rnd-job-id");
  });

  it("throws MnmlError(internal_error) when the trigger response has no id", async () => {
    const { fetcher } = captureFetcher([jsonResponse({ status: "queued" })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "internal_error",
    });
  });
});

describe("HttpMnmlClient — getRenderStatus", () => {
  it("GETs /v1/renders/{id} and maps a ready response with outputs", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({
        id: "rnd-42",
        status: "ready",
        outputs: [
          {
            role: "primary",
            url: "https://cdn.mnml.test/out.png",
            format: "png",
            resolution: "1920x1080",
            size_bytes: 1234,
            output_id: "out-1",
          },
        ],
      }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const status = await client.getRenderStatus("rnd-42");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/renders/rnd-42`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(status.status).toBe("ready");
    expect(status.outputs).toHaveLength(1);
    expect(status.outputs![0]).toMatchObject({
      role: "primary",
      url: "https://cdn.mnml.test/out.png",
      format: "png",
      resolution: "1920x1080",
      sizeBytes: 1234,
      mnmlOutputId: "out-1",
    });
  });

  it("normalizes mnml.ai status synonyms (pending/processing/complete/canceled)", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "pending" }),
      jsonResponse({ status: "processing" }),
      jsonResponse({ status: "complete", outputs: [] }),
      jsonResponse({ status: "canceled" }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    expect((await client.getRenderStatus("a")).status).toBe("queued");
    expect((await client.getRenderStatus("b")).status).toBe("rendering");
    expect((await client.getRenderStatus("c")).status).toBe("ready");
    expect((await client.getRenderStatus("d")).status).toBe("cancelled");
  });

  it("propagates a failed render's error.code through the bucket map", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({
        id: "rnd-x",
        status: "failed",
        error: { code: "invalid-scene", message: "bad geometry" },
      }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const status = await client.getRenderStatus("rnd-x");
    expect(status.status).toBe("failed");
    expect(status.error).toEqual({
      code: "invalid_scene",
      message: "bad geometry",
    });
  });

  it("URL-encodes the renderId path segment", async () => {
    const { fetcher, calls } = captureFetcher([jsonResponse({ status: "queued" })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await client.getRenderStatus("rnd/with spaces");
    expect(calls[0]!.url).toBe(
      `${BASE_URL}/v1/renders/rnd%2Fwith%20spaces`,
    );
  });
});

describe("HttpMnmlClient — cancelRender", () => {
  it("DELETEs /v1/renders/{id} with Bearer auth", async () => {
    const { fetcher, calls } = captureFetcher([new Response(null, { status: 204 })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const result = await client.cancelRender("rnd-7");
    expect(result).toEqual({ renderId: "rnd-7", status: "cancelled" });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/renders/rnd-7`);
    expect(calls[0]!.authorization).toBe(`Bearer ${API_KEY}`);
  });
});

describe("HttpMnmlClient — error mapping", () => {
  it("maps 429 → quota_exceeded", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ error: {} }, 429),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "quota_exceeded",
    });
  });

  it("maps 504 → timeout", async () => {
    const { fetcher } = captureFetcher([new Response("upstream", { status: 504 })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "timeout",
    });
  });

  it("maps 4xx (no body code) → invalid_scene", async () => {
    const { fetcher } = captureFetcher([new Response("nope", { status: 400 })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "invalid_scene",
    });
  });

  it("maps 5xx → internal_error", async () => {
    const { fetcher } = captureFetcher([new Response("oops", { status: 500 })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "internal_error",
    });
  });

  it("body error.code wins over the http status bucket", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse(
        { error: { code: "quota_exceeded", message: "hit cap" } },
        500,
      ),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "quota_exceeded",
      message: "hit cap",
    });
  });

  it("translates AbortSignal.timeout aborts into MnmlError(timeout)", async () => {
    const fetcher = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      timeoutMs: 50,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "timeout",
    });
  });

  it("translates network errors into MnmlError(unavailable)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(STILL)).rejects.toMatchObject({
      name: "MnmlError",
      code: "unavailable",
    });
  });
});

describe("HttpMnmlClient — structured logging", () => {
  let logs: { level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg: string }[];
  beforeEach(() => {
    logs = [];
  });
  const captureLogger = {
    info: (obj: Record<string, unknown>, msg: string) =>
      logs.push({ level: "info", obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) =>
      logs.push({ level: "warn", obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) =>
      logs.push({ level: "error", obj, msg }),
  };

  it("emits an info record on success", async () => {
    const { fetcher } = captureFetcher([jsonResponse({ id: "rnd-1" }, 202)]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
    });
    await client.triggerRender(STILL);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("info");
    expect(logs[0]!.obj["op"]).toBe("triggerRender");
    expect(logs[0]!.obj["renderId"]).toBe("rnd-1");
  });

  it("emits a warn record on failure", async () => {
    const { fetcher } = captureFetcher([new Response("nope", { status: 500 })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
    });
    await expect(client.triggerRender(STILL)).rejects.toBeInstanceOf(MnmlError);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.obj["code"]).toBe("internal_error");
  });

  it("emits a warn record on transport-side timeout (doFetch)", async () => {
    const fetcher = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
      timeoutMs: 50,
    });
    await expect(client.getRenderStatus("rnd-1")).rejects.toBeInstanceOf(MnmlError);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.obj["op"]).toBe("getRenderStatus");
    expect(logs[0]!.obj["code"]).toBe("timeout");
  });

  it("emits a warn record on transport-side network failure (doFetch)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
    });
    await expect(client.cancelRender("rnd-2")).rejects.toBeInstanceOf(MnmlError);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.obj["op"]).toBe("cancelRender");
    expect(logs[0]!.obj["code"]).toBe("unavailable");
  });
});
