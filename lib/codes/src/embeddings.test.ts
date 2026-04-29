/**
 * embeddings.ts must be safe in two regimes:
 *   - OPENAI_API_KEY missing: returns nulls, never throws. Atoms then ship
 *     without vectors (lexical fallback handles retrieval).
 *   - HTTP failure: returns nulls + skipReason="request_failed", never throws.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { embedTexts, embedQuery, EMBEDDING_DIMENSIONS, isEmbeddingAvailable } from "./embeddings";

describe("embeddings: missing API key path", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("isEmbeddingAvailable returns false when key is empty", () => {
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it("embedTexts returns nulls with skipReason='no_api_key'", async () => {
    const result = await embedTexts(["hello", "world"]);
    expect(result.vectors).toEqual([null, null]);
    expect(result.embeddedAny).toBe(false);
    expect(result.skipReason).toBe("no_api_key");
  });

  it("embedTexts handles empty input array", async () => {
    const result = await embedTexts([]);
    expect(result.vectors).toEqual([]);
    expect(result.embeddedAny).toBe(false);
  });

  it("embedQuery returns null", async () => {
    expect(await embedQuery("anything")).toBeNull();
  });

  it("never invokes fetch when key is missing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await embedTexts(["x"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("embeddings: with API key (mocked OpenAI)", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-fake");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("isEmbeddingAvailable returns true", () => {
    expect(isEmbeddingAvailable()).toBe(true);
  });

  it("happy path: returns vectors keyed by index", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: [0.1, 0.2], index: 0 },
            { embedding: [0.3, 0.4], index: 1 },
          ],
          model: "text-embedding-3-small",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await embedTexts(["foo", "bar"]);
    expect(result.vectors[0]).toEqual([0.1, 0.2]);
    expect(result.vectors[1]).toEqual([0.3, 0.4]);
    expect(result.embeddedAny).toBe(true);
    expect(result.skipReason).toBeUndefined();

    // Inspect the request: should hit /embeddings with Bearer auth and the
    // expected model + dimensions.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test-fake");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(body.input).toEqual(["foo", "bar"]);
  });

  it("HTTP error returns nulls + skipReason='request_failed', does not throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );
    const result = await embedTexts(["x"]);
    expect(result.vectors).toEqual([null]);
    expect(result.embeddedAny).toBe(false);
    expect(result.skipReason).toBe("request_failed");
  });

  it("network throw returns nulls + skipReason='request_failed', does not throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    const result = await embedTexts(["x"]);
    expect(result.vectors).toEqual([null]);
    expect(result.embeddedAny).toBe(false);
    expect(result.skipReason).toBe("request_failed");
  });

  it("clamps very long inputs to 32k chars", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.5], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const huge = "x".repeat(100_000);
    await embedTexts([huge]);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.input[0].length).toBe(32_000);
  });

  it("substitutes a single space for empty inputs (OpenAI rejects empty)", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await embedTexts([""]);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.input[0]).toBe(" ");
  });

  it("embedQuery returns the single vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [9, 9, 9], index: 0 }],
            model: "text-embedding-3-small",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    expect(await embedQuery("hi")).toEqual([9, 9, 9]);
  });
});
