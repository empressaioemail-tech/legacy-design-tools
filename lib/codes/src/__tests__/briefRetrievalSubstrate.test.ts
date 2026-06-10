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

  it("returns empty array when substrate URL is unset", async () => {
    delete process.env.BRIEF_RETRIEVAL_API_URL;
    const hits = await retrieveAtomsFromSubstrate({
      jurisdictionKey: "austin_tx",
      question: "setbacks",
    });
    expect(hits).toEqual([]);
  });
});
