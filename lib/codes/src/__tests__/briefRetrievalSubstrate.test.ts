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
    expect(hits[0]?.id).toBe("abc");
    expect(hits[0]?.retrievalMode).toBe("substrate-gate");
    expect(hits[0]?.body).toBe("ADU requirements");
  });

  it("prefers entityId for BDC section citations", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            atomDid:
              "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
            entityId: "bastrop_tx-bdc-2026-adopted/14-02-003",
            snippet: "GC General Commercial district uses and dimensions",
            score: 0.88,
            sectionNumber: "14-02-003",
            jurisdictionTenant: "bastrop_tx",
          },
        ],
      }),
    }) as typeof fetch;

    const hits = await retrieveAtomsFromSubstrate({
      jurisdictionKey: "bastrop_tx",
      question: "GC zoning district permitted uses dimensional standards",
      limit: 5,
    });

    expect(hits[0]?.id).toBe("bastrop_tx-bdc-2026-adopted/14-02-003");
    expect(hits[0]?.codeBook).toBe("BDC");
    expect(hits[0]?.sectionTitle).toBe("§14-02-003");
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
