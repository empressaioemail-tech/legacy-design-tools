import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retrieveAtomsFromSubstrate } from "../briefRetrievalSubstrate";

describe("retrieveAtomsFromSubstrate", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.BRIEF_RETRIEVAL_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.BRIEF_RETRIEVAL_API_URL;
    delete process.env.BRIEF_RETRIEVAL_API_KEY;
  });

  it("maps substrate /search hits to RetrievedAtom shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            atomDid: "did:hauska:code-section:abc",
            snippet: "ADU requirements",
            score: 0.91,
            sectionNumber: "R302.1",
            jurisdictionTenant: "austin_tx",
          },
        ],
      }),
    }) as typeof fetch;

    const hits = await retrieveAtomsFromSubstrate({
      jurisdictionKey: "austin_tx",
      question: "ADU",
      limit: 2,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("did:hauska:code-section:abc");
    expect(hits[0]?.retrievalMode).toBe("substrate-gate");
    expect(hits[0]?.body).toBe("ADU requirements");
  });

  it("sends platform-internal gate headers when gateContext is set", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }) as typeof fetch;

    await retrieveAtomsFromSubstrate({
      jurisdictionKey: "icc-model-code",
      question: "egress width",
      gateContext: {
        accessTier: "platform-internal",
        jurisdictionTenant: "icc-model-code",
        surfaceKey: "plan-review-ibc",
      },
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers["x-hauska-access-tier"]).toBe("platform-internal");
    expect(headers["x-hauska-jurisdiction-tenant"]).toBe("icc-model-code");
    expect(headers["x-hauska-product"]).toBe("plan-review-ibc");
  });
});
