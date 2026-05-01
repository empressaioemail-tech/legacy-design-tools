/**
 * `HttpConverterClient` — unit coverage for the production DXF→glb
 * client. Exercises the wire contract (signed multipart POST), the
 * retry/backoff policy (5xx + timeouts retried, 4xx not), and the
 * fatal failure modes (wrong content-type, empty body).
 *
 * The route-level tests in `parcel-briefings.test.ts` swap the
 * converter for `MockConverterClient`, so the real HTTP path has no
 * coverage there. This file pins it directly: every fetch is stubbed
 * via the injected `fetchImpl`, and the sleep between retries is
 * stubbed to a no-op so the suite stays fast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  HttpConverterClient,
  ConverterError,
  type ConvertDxfRequest,
} from "../lib/converterClient";

const URL = "https://converter.test.invalid/convert";
const SECRET = "smoke-secret";

function makeRequest(): ConvertDxfRequest {
  return {
    dxfBytes: Buffer.from("FAKE-DXF"),
    layerKind: "terrain",
    originalFilename: "terrain.dxf",
  };
}

/**
 * Build a minimal but well-formed glb response (header + JSON chunk).
 * Mirrors the bytes the real converter would return so the
 * client's content-type + non-empty checks pass.
 */
function makeGlbResponse(): Response {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: "2.0" } }),
    "utf8",
  );
  const paddedLen = Math.ceil(json.length / 4) * 4;
  const padded = Buffer.alloc(paddedLen);
  json.copy(padded, 0);
  for (let i = json.length; i < padded.length; i++) padded[i] = 0x20;
  const total = 12 + 8 + padded.length;
  const out = Buffer.alloc(total);
  out.write("glTF", 0, "ascii");
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(padded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(out, 20);
  return new Response(out, {
    status: 200,
    headers: { "content-type": "model/gltf-binary" },
  });
}

const noopSleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

beforeEach(() => {
  noopSleep.mockClear();
});

describe("HttpConverterClient — wire contract", () => {
  it("sends multipart body with HMAC signature header and returns the glb bytes", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} };
      return makeGlbResponse();
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: noopSleep,
    });

    const result = await client.convert(makeRequest());

    expect(result.glbBytes.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(typeof result.requestId).toBe("string");
    expect(result.requestId.length).toBeGreaterThan(0);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(URL);
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-converter-request-id"]).toBe(result.requestId);
    const expectedSig = createHmac("sha256", SECRET)
      .update(`${result.requestId}.terrain`)
      .digest("hex");
    expect(headers["x-converter-signature"]).toBe(expectedSig);
    expect(captured!.init.body).toBeInstanceOf(FormData);
    const body = captured!.init.body as FormData;
    expect(body.get("layerKind")).toBe("terrain");
    expect(body.get("dxf")).toBeInstanceOf(Blob);
  });
});

describe("HttpConverterClient — retry policy", () => {
  it("retries a 503 then succeeds, reusing the same requestId across attempts", async () => {
    const seenRequestIds: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenRequestIds.push(headers["x-converter-request-id"]);
      calls++;
      if (calls === 1) {
        return new Response("upstream busy", { status: 503 });
      }
      return makeGlbResponse();
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      initialBackoffMs: 10,
      sleepImpl: noopSleep,
    });

    const result = await client.convert(makeRequest());
    expect(result.glbBytes.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The same requestId is sent on each attempt so the converter
    // can correlate the retry with the original request in its logs.
    expect(seenRequestIds).toHaveLength(2);
    expect(seenRequestIds[0]).toBe(seenRequestIds[1]);
    expect(noopSleep).toHaveBeenCalledTimes(1);
    expect(noopSleep).toHaveBeenCalledWith(10);
  });

  it("does NOT retry a 4xx — it's a deterministic rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("bad signature", { status: 401 });
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 5,
      initialBackoffMs: 10,
      sleepImpl: noopSleep,
    });

    await expect(client.convert(makeRequest())).rejects.toMatchObject({
      name: "ConverterError",
      code: "converter_rejected",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noopSleep).not.toHaveBeenCalled();
  });

  it("does NOT retry an invalid content-type — that's a contract drift, not a flake", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("oops", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      initialBackoffMs: 10,
      sleepImpl: noopSleep,
    });

    await expect(client.convert(makeRequest())).rejects.toMatchObject({
      name: "ConverterError",
      code: "converter_invalid_response",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noopSleep).not.toHaveBeenCalled();
  });

  it("does NOT retry an empty body with the right content-type — also a contract drift", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-type": "model/gltf-binary" },
      });
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      initialBackoffMs: 10,
      sleepImpl: noopSleep,
    });

    await expect(client.convert(makeRequest())).rejects.toMatchObject({
      name: "ConverterError",
      code: "converter_invalid_response",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and gives up after maxRetries+1 attempts", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      initialBackoffMs: 10,
      sleepImpl: noopSleep,
    });

    await expect(client.convert(makeRequest())).rejects.toMatchObject({
      name: "ConverterError",
      code: "converter_unavailable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Backoff happens between attempts (n attempts ⇒ n-1 sleeps).
    expect(noopSleep).toHaveBeenCalledTimes(2);
    expect(noopSleep.mock.calls[0]![0]).toBe(10);
    expect(noopSleep.mock.calls[1]![0]).toBe(20);
  });

  it("translates AbortSignal.timeout aborts into converter_timeout and retries them", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      }
      return makeGlbResponse();
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 3,
      initialBackoffMs: 5,
      sleepImpl: noopSleep,
    });

    const result = await client.convert(makeRequest());
    expect(result.glbBytes.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noopSleep).toHaveBeenCalledTimes(2);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("nope");
    });

    const client = new HttpConverterClient({
      url: URL,
      sharedSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 4,
      initialBackoffMs: 100,
      maxBackoffMs: 250,
      sleepImpl: noopSleep,
    });

    await expect(client.convert(makeRequest())).rejects.toBeInstanceOf(
      ConverterError,
    );
    // 100, 200, capped 250, capped 250
    expect(noopSleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 250, 250]);
  });
});
