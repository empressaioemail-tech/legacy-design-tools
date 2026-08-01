import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SubstrateRetrievalError,
  retrieveAtomsFromSubstrate,
} from "../briefRetrievalSubstrate";

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

  it("distinguishes a missing substrate configuration from zero hits", async () => {
    delete process.env.BRIEF_RETRIEVAL_API_URL;
    await expect(retrieveAtomsFromSubstrate({
      jurisdictionKey: "austin_tx",
      question: "setbacks",
    })).rejects.toMatchObject({
      name: "SubstrateRetrievalError",
      reason: "not_configured",
    });
  });

  it("returns [] only for a successful search with zero legitimate hits", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }) as typeof fetch;

    await expect(retrieveAtomsFromSubstrate({
      jurisdictionKey: "austin_tx",
      question: "setbacks",
    })).resolves.toEqual([]);
  });

  it("throws a typed observable error for a non-ok substrate response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as typeof fetch;

    const error = await retrieveAtomsFromSubstrate({
      jurisdictionKey: "austin_tx",
      question: "setbacks",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SubstrateRetrievalError);
    expect(error).toMatchObject({ reason: "http_error", status: 503 });
  });
});
