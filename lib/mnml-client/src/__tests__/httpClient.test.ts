/**
 * HttpMnmlClient — covers the wire contract (POST multipart against
 * the per-capability Spec 54 v2 §2 endpoints with `Authorization:
 * Bearer …`), the happy-path response mappers, the timeout / network
 * failure translations into MnmlError, and the seven-bucket error
 * mapping (validation / auth / insufficient_credits / not_found /
 * rate_limited / unavailable / transport).
 *
 * Every fetch is stubbed via the injected `fetcher` option so no real
 * network happens. The `captureFetcher` helper drains FormData
 * entries (image / prompt / expert_name / etc.) so multipart-form
 * assertions land on field-by-field equality rather than raw bytes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpMnmlClient } from "../httpClient";
import { MnmlError } from "../types";
import type { ArchDiffusionRequest, VideoAiRequest } from "../types";

const BASE_URL = "https://api.mnmlai.dev";
const API_KEY = "test-key-abc";

/** A tiny 3-byte JPEG-magic Blob — enough for the multipart wire. */
function imageBlob(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff])]);
}

const ARCHDIFFUSION: ArchDiffusionRequest = {
  kind: "archdiffusion",
  image: imageBlob(),
  prompt: "a small modern home on a hillside, photoreal",
  expertName: "exterior",
  renderStyle: "photoreal",
  geometry: "precise",
  viewMode: "auto",
  expertParams: {
    camera_angle: "eye_level",
    camera_direction: "front",
    time_of_day: "midday",
    weather: "clear",
  },
  seed: 42,
};

const VIDEO: VideoAiRequest = {
  kind: "video",
  image: imageBlob(),
  prompt: "slow horizontal pan",
  duration: 10,
  cfgScale: 0.5,
  aspectRatio: "16:9",
  movementType: "horizontal",
  direction: "right",
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
  /**
   * The api-server MUST NOT set Content-Type on a multipart body —
   * fetch sets it automatically with the boundary. Captured here so
   * tests can assert it stays unset.
   */
  contentType?: string;
  /** When the body was a FormData, its drained string fields. */
  formFields?: Record<string, string>;
  /** When the body was a FormData, the names of file-typed parts. */
  formFiles?: string[];
}

/**
 * Stub fetch + capture every call. FormData bodies are drained into
 * `formFields` (string entries) and `formFiles` (file entries); JSON
 * / null bodies pass through.
 */
function captureFetcher(
  responses: Response[],
): { fetcher: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const captured: CapturedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers["Authorization"],
      contentType: headers["Content-Type"],
    };
    const body = init?.body;
    if (body instanceof FormData) {
      const fields: Record<string, string> = {};
      const files: string[] = [];
      for (const [key, value] of body.entries()) {
        if (typeof value === "string") {
          fields[key] = value;
        } else {
          files.push(key);
        }
      }
      captured.formFields = fields;
      captured.formFiles = files;
    }
    calls.push(captured);
    if (i >= responses.length) {
      throw new Error(`captureFetcher: no canned response for call #${i + 1}`);
    }
    return responses[i++]!;
  });
  return { fetcher: fn as unknown as typeof fetch, calls };
}

// ─────────────────────────────────────────────────────────────────────
// triggerRender — wire contract per Spec 54 v2 §2.1 / §2.2
// ─────────────────────────────────────────────────────────────────────

describe("HttpMnmlClient — triggerRender archdiffusion wire contract", () => {
  it("POSTs multipart to /v1/archDiffusion-v43 with Bearer auth and returns renderId + credits", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ status: "success", id: "rnd-42", credits: 96 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const result = await client.triggerRender(ARCHDIFFUSION);
    expect(result).toEqual({ renderId: "rnd-42", remainingCredits: 96 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/archDiffusion-v43`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    // We MUST NOT set Content-Type on a multipart body — fetch sets
    // it (with the boundary) automatically. Setting it manually
    // breaks the boundary parameter and mnml returns a MISSING_IMAGE.
    expect(calls[0]!.contentType).toBeUndefined();
  });

  it("uploads image as a file part and writes Spec 54 v2 §2.1 form fields", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ status: "success", id: "rnd-1", credits: 10 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await client.triggerRender(ARCHDIFFUSION);

    expect(calls[0]!.formFiles).toContain("image");
    expect(calls[0]!.formFields).toMatchObject({
      prompt: "a small modern home on a hillside, photoreal",
      expert_name: "exterior",
      render_style: "photoreal",
      geometry: "precise",
      view_mode: "auto",
      camera_angle: "eye_level",
      camera_direction: "front",
      time_of_day: "midday",
      weather: "clear",
      seed: "42",
    });
  });

  it("uploads up to 4 reference_image parts and silently drops extras", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ status: "success", id: "rnd-1", credits: 10 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const refs = [imageBlob(), imageBlob(), imageBlob(), imageBlob(), imageBlob(), imageBlob()];
    await client.triggerRender({ ...ARCHDIFFUSION, referenceImages: refs });

    const refFiles = calls[0]!.formFiles!.filter((k) =>
      k.startsWith("reference_image_"),
    );
    expect(refFiles.sort()).toEqual([
      "reference_image_1",
      "reference_image_2",
      "reference_image_3",
      "reference_image_4",
    ]);
  });

  it("strips trailing slashes from baseUrl", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ status: "success", id: "rnd-1", credits: 10 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: `${BASE_URL}///`,
      apiKey: API_KEY,
      fetcher,
    });
    await client.triggerRender(ARCHDIFFUSION);
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/archDiffusion-v43`);
  });

  it("returns remainingCredits=-1 sentinel when mnml omits the credits field", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "success", id: "rnd-1" }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const result = await client.triggerRender(ARCHDIFFUSION);
    expect(result.remainingCredits).toBe(-1);
  });

  it("throws MnmlError(validation, MISSING_ID) when the trigger response has no id", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "success", credits: 10 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      name: "MnmlError",
      kind: "validation",
      code: "MISSING_ID",
    });
  });
});

describe("HttpMnmlClient — triggerRender video wire contract", () => {
  it("POSTs multipart to /v1/video-ai with the Spec 54 v2 §2.2 fields", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ status: "success", id: "vid-1", seed: 7 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const result = await client.triggerRender(VIDEO);
    expect(result.renderId).toBe("vid-1");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/video-ai`);
    expect(calls[0]!.formFiles).toContain("image");
    expect(calls[0]!.formFields).toMatchObject({
      prompt: "slow horizontal pan",
      duration: "10",
      cfg_scale: "0.5",
      aspect_ratio: "16:9",
      movement_type: "horizontal",
      direction: "right",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// getRenderStatus — Spec 54 v2 §2.3 + §3 status translation
// ─────────────────────────────────────────────────────────────────────

describe("HttpMnmlClient — getRenderStatus", () => {
  it("GETs /v1/status/{id} and maps a success response with message[] urls", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({
        status: "success",
        message: ["https://api.mnmlai.dev/v1/images/abc/out.png"],
        seed: 1234,
      }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const status = await client.getRenderStatus("rnd-42");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/status/rnd-42`);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(status.status).toBe("ready");
    expect(status.outputUrls).toEqual([
      "https://api.mnmlai.dev/v1/images/abc/out.png",
    ]);
    expect(status.seed).toBe(1234);
  });

  it("translates wire status synonyms per Spec 54 v2 §3", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "starting" }),
      jsonResponse({ status: "processing" }),
      jsonResponse({ status: "success", message: [] }),
      jsonResponse({ status: "canceled" }),
      jsonResponse({ status: "failed", error: "boom" }),
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
    expect((await client.getRenderStatus("e")).status).toBe("failed");
  });

  it("falls back to rendering for unknown wire statuses (defer to next poll)", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "warming-up-the-gpu" }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    expect((await client.getRenderStatus("a")).status).toBe("rendering");
  });

  it("populates error on failed status with the wire `error` string", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "failed", error: "could not render that scene" }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const status = await client.getRenderStatus("rnd-x");
    expect(status.status).toBe("failed");
    expect(status.error).toEqual({
      code: "render_failed",
      message: "could not render that scene",
    });
  });

  it("accepts a single-string `message` field (defensive against wire variance)", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "success", message: "https://api.mnmlai.dev/single.png" }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    const status = await client.getRenderStatus("rnd-42");
    expect(status.outputUrls).toEqual(["https://api.mnmlai.dev/single.png"]);
  });

  it("URL-encodes the renderId path segment", async () => {
    const { fetcher, calls } = captureFetcher([
      jsonResponse({ status: "starting" }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await client.getRenderStatus("rnd/with spaces");
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/status/rnd%2Fwith%20spaces`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Error mapping — Spec 54 v2 §5 (7 buckets)
// ─────────────────────────────────────────────────────────────────────

describe("HttpMnmlClient — error mapping (Spec 54 v2 §5)", () => {
  it("maps 400 → validation with mnml's wire code preserved", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse(
        { status: "error", code: "MISSING_PROMPT", message: "prompt required" },
        400,
      ),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      name: "MnmlError",
      kind: "validation",
      code: "MISSING_PROMPT",
      message: "prompt required",
    });
  });

  it("maps 401 → auth", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "error", code: "invalid_api_key", message: "bad key" }, 401),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "auth",
      code: "invalid_api_key",
    });
  });

  it("maps 403 → insufficient_credits and surfaces details", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse(
        {
          status: "error",
          code: "NO_CREDITS",
          message: "out of credits",
          details: { required_credits: 3, available_credits: 1 },
        },
        403,
      ),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "insufficient_credits",
      code: "NO_CREDITS",
      details: { required_credits: 3, available_credits: 1 },
    });
  });

  it("maps 404 → not_found", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "error", code: "resource_not_found", message: "" }, 404),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.getRenderStatus("nope")).rejects.toMatchObject({
      kind: "not_found",
      code: "resource_not_found",
    });
  });

  it("maps 429 → rate_limited and surfaces retryAfterSeconds", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse(
        {
          status: "error",
          code: "rate_limit_exceeded",
          message: "slow down",
          details: { retryAfterSeconds: 30 },
        },
        429,
      ),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "rate_limited",
      code: "rate_limit_exceeded",
      details: { retryAfterSeconds: 30 },
    });
  });

  it("maps 5xx → unavailable", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "error", code: "internal_server_error", message: "oops" }, 500),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "unavailable",
      code: "internal_server_error",
    });
  });

  it("synthesizes HTTP_<status> code when body has no code field", async () => {
    const { fetcher } = captureFetcher([new Response("nope", { status: 503 })]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "unavailable",
      code: "HTTP_503",
    });
  });

  it("translates AbortSignal.timeout aborts into MnmlError(transport, timeout)", async () => {
    const fetcher = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      triggerTimeoutMs: 50,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "transport",
      code: "timeout",
    });
  });

  it("translates network errors into MnmlError(transport, network)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toMatchObject({
      kind: "transport",
      code: "network",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Structured logging
// ─────────────────────────────────────────────────────────────────────

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

  it("emits an info record on triggerRender success", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "success", id: "rnd-1", credits: 10 }),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
    });
    await client.triggerRender(ARCHDIFFUSION);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("info");
    expect(logs[0]!.obj["op"]).toBe("triggerRender");
    expect(logs[0]!.obj["renderId"]).toBe("rnd-1");
    expect(logs[0]!.obj["remainingCredits"]).toBe(10);
  });

  it("emits a warn record on http failure with mnmlKind populated", async () => {
    const { fetcher } = captureFetcher([
      jsonResponse({ status: "error", code: "internal_server_error", message: "x" }, 500),
    ]);
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
    });
    await expect(client.triggerRender(ARCHDIFFUSION)).rejects.toBeInstanceOf(
      MnmlError,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.obj["mnmlKind"]).toBe("unavailable");
    expect(logs[0]!.obj["code"]).toBe("internal_server_error");
  });

  it("emits a warn record on transport-side timeout", async () => {
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
      statusTimeoutMs: 50,
    });
    await expect(client.getRenderStatus("rnd-1")).rejects.toBeInstanceOf(
      MnmlError,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.obj["op"]).toBe("getRenderStatus");
    expect(logs[0]!.obj["mnmlKind"]).toBe("transport");
    expect(logs[0]!.obj["code"]).toBe("timeout");
  });

  it("emits a warn record on transport-side network failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = new HttpMnmlClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetcher,
      logger: captureLogger,
    });
    await expect(client.getRenderStatus("rnd-1")).rejects.toBeInstanceOf(
      MnmlError,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.obj["mnmlKind"]).toBe("transport");
    expect(logs[0]!.obj["code"]).toBe("network");
  });
});
