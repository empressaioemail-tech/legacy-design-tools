import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, TRANSIENT_STATUS_CODES } from "../retry";
import { AdapterRunError } from "../types";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

function ok(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
});
