import { describe, expect, it, vi } from "vitest";
import {
  BODY_EXCERPT_MAX_CHARS,
  fetchWithRetry,
  TRANSIENT_STATUS_CODES,
} from "../retry";
import { AdapterRunError } from "../types";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

function ok(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textRes(body: string, status: number, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("fetchWithRetry", () => {
  it("returns a 200 immediately without retrying", async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true }));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep },
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries each transient HTTP status the brief enumerates and succeeds on attempt 2", async () => {
    for (const status of TRANSIENT_STATUS_CODES) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(ok({}, status))
        .mockResolvedValueOnce(ok({ healed: true }, 200));
      const { response, attempts } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(200);
      expect(attempts).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("does NOT retry on hard 4xx like 400 / 404 / 422", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const fetchImpl = vi.fn(async () => ok({ msg: "no" }, status));
      const { response, attempts } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(status);
      expect(attempts).toBe(1);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("retries on a transient network-reset throw and surfaces the final response", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(
        Object.assign(new Error("ECONNRESET"), { name: "Error" }),
      )
      .mockResolvedValueOnce(ok({ ok: true }));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("gives up after `maxAttempts` transient failures and returns the last response", async () => {
    const fetchImpl = vi.fn(async () => ok({}, 503));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
    );
    expect(response.status).toBe(503);
    expect(attempts).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws an AdapterRunError(network-error) if every attempt rejects with a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      fetchWithRetry("https://example.test/x", undefined, {
        fetchImpl,
        sleepImpl: noSleep,
        maxAttempts: 2,
        upstreamLabel: "Test Upstream",
      }),
    ).rejects.toMatchObject({
      name: "AdapterRunError",
      code: "network-error",
      message: expect.stringContaining("Test Upstream"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("propagates the caller's abort as a `timeout` AdapterRunError without retrying", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(async () => ok());
    await expect(
      fetchWithRetry("https://example.test/x", undefined, {
        fetchImpl,
        sleepImpl: noSleep,
        signal: ac.signal,
        upstreamLabel: "X",
      }),
    ).rejects.toMatchObject({
      name: "AdapterRunError",
      code: "timeout",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a fetch throw as `timeout` (not retryable) when the caller's signal aborted mid-flight", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn(async () => {
      ac.abort();
      const err = new Error("aborted by caller");
      err.name = "AbortError";
      throw err;
    });
    await expect(
      fetchWithRetry("https://example.test/x", undefined, {
        fetchImpl,
        sleepImpl: noSleep,
        signal: ac.signal,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(AdapterRunError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries an unattributed AbortError (not caused by the caller's signal)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce(ok({ ok: true }));
    const { response, attempts } = await fetchWithRetry(
      "https://example.test/x",
      undefined,
      { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
    );
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  // QA-22 reopen — body-excerpt capture so adapter failure pills can
  // carry the upstream's actual error text without operators needing
  // Cloud Run log access for every triage round.
  describe("bodyExcerpt capture (QA-22)", () => {
    it("captures the body excerpt on transient-status retry exhaustion", async () => {
      const fetchImpl = vi.fn(async () =>
        textRes("Service is down for scheduled maintenance until 22:00 UTC.", 503),
      );
      const { response, attempts, bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(503);
      expect(attempts).toBe(3);
      expect(bodyExcerpt).toBe(
        "Service is down for scheduled maintenance until 22:00 UTC.",
      );
    });

    it("captures the body excerpt on a hard 4xx (single attempt, no retry)", async () => {
      const fetchImpl = vi.fn(async () =>
        textRes(
          JSON.stringify({ error: { code: 400, message: "Layer 0 not found" } }),
          400,
          "application/json",
        ),
      );
      const { response, attempts, bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(400);
      expect(attempts).toBe(1);
      expect(bodyExcerpt).toContain("Layer 0 not found");
    });

    it("collapses whitespace so a pretty-printed HTML error stays compact", async () => {
      const html = `
        <html>
          <body>
            <h1>503 Service Unavailable</h1>
            <p>The upstream is overloaded.</p>
          </body>
        </html>
      `;
      const fetchImpl = vi.fn(async () => textRes(html, 503, "text/html"));
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeDefined();
      // No double-space runs left after the collapse — the excerpt is
      // one line regardless of how the upstream pretty-printed.
      expect(bodyExcerpt).not.toMatch(/ {2,}/);
      // And the visible characters survive in order.
      expect(bodyExcerpt).toContain("503 Service Unavailable");
      expect(bodyExcerpt).toContain("The upstream is overloaded.");
    });

    it(`truncates excerpts longer than BODY_EXCERPT_MAX_CHARS (${BODY_EXCERPT_MAX_CHARS}) with a trailing ellipsis`, async () => {
      const long = "x".repeat(BODY_EXCERPT_MAX_CHARS * 2);
      const fetchImpl = vi.fn(async () => textRes(long, 502));
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeDefined();
      // The visible-character cap is exact; the appended ellipsis is the
      // single character `…`, so total length is +1.
      expect(bodyExcerpt!.length).toBe(BODY_EXCERPT_MAX_CHARS + 1);
      expect(bodyExcerpt!.endsWith("…")).toBe(true);
    });

    it("returns bodyExcerpt undefined when the body is empty", async () => {
      const fetchImpl = vi.fn(async () => textRes("", 502));
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeUndefined();
    });

    it("does NOT populate bodyExcerpt on a successful (2xx) response", async () => {
      const fetchImpl = vi.fn(async () => ok({ ok: true }));
      const { response, bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 3 },
      );
      expect(response.status).toBe(200);
      expect(bodyExcerpt).toBeUndefined();
    });

    it("returns undefined excerpt when the body read itself throws", async () => {
      // Build a Response whose .text() rejects, simulating a transport
      // reset mid-read. Constructing this requires reaching into the
      // Response prototype because Response is designed to be inert
      // until consumed.
      const res = textRes("ignored", 503);
      Object.defineProperty(res, "text", {
        value: async () => {
          throw new TypeError("network reset mid-read");
        },
      });
      const fetchImpl = vi.fn(async () => res);
      const { bodyExcerpt } = await fetchWithRetry(
        "https://example.test/x",
        undefined,
        { fetchImpl, sleepImpl: noSleep, maxAttempts: 1 },
      );
      expect(bodyExcerpt).toBeUndefined();
    });
  });
});
