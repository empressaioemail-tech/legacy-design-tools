import { afterEach, describe, expect, it, vi } from "vitest";

import { cortexFetch } from "../src/cortex-client.js";
import { ANCHOR_TIMEOUT_MS } from "../src/parcel-anchor.js";

const CONFIG = { baseUrl: "http://cortex.test", serviceApiKey: "test-key" };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The anchor's bound is only real if cortexFetch actually honours timeoutMs.
 * These run against the real client with fetch stubbed, so the abort has to
 * come from the client's own controller.
 */
describe("cortexFetch timeoutMs (P-91 v3 M-1)", () => {
  function stubHangingFetch(): { seen: Array<AbortSignal | undefined> } {
    const seen: Array<AbortSignal | undefined> = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      seen.push(init.signal ?? undefined);
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    return { seen };
  }

  it("aborts a hanging call at the supplied bound", async () => {
    const { seen } = stubHangingFetch();
    await expect(
      cortexFetch(CONFIG, "/api/brokerage/v1/place/node/x/facets", {
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen[0]?.aborted).toBe(true);
  });

  it("does not abort inside the bound when the call answers", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const res = await cortexFetch(CONFIG, "/x", { timeoutMs: ANCHOR_TIMEOUT_MS });
    expect(res.status).toBe(200);
  });

  it("a call with no timeoutMs keeps the 30s default and does not abort at the anchor bound", async () => {
    const { seen } = stubHangingFetch();
    const pending = cortexFetch(CONFIG, "/api/property-explorer/v1/research/brief", {
      method: "POST",
      body: "{}",
    });
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen[0]?.aborted, "default-timeout call aborted early").toBe(false);
  });
});
