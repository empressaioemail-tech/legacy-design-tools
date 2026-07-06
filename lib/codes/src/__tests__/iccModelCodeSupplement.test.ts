import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the db module before importing retrieval
vi.mock("@workspace/db", () => ({
  db: {},
  codeAtoms: {},
  codeAtomSources: {},
}));

// Mock embeddings module to avoid OpenAI dependency
vi.mock("../embeddings", () => ({
  embedQuery: vi.fn().mockResolvedValue(null),
}));

import { retrieveAtomsForQuestion } from "../retrieval";

describe("ICC model-code supplement", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Use substrate mode to avoid DB queries in tests
    process.env.BRIEF_CODE_RETRIEVAL = "gate";
    delete process.env.BRIEF_RETRIEVAL_API_URL;
    delete process.env.BRIEF_RETRIEVAL_API_KEY;
    delete process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("supplements jurisdiction atoms with ICC model-code atoms", async () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.BRIEF_RETRIEVAL_API_KEY = "test-key";
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "true";

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      // ICC supplement call
      if (urlStr.includes("jurisdiction=icc-model-code")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:icc:ibc2018:section-1234",
                snippet: "IBC 2018 building height limits",
                score: 0.85,
                sectionNumber: "503.1",
                jurisdictionTenant: "icc-model-code",
              },
            ],
          }),
        } as Response;
      }
      
      // Primary jurisdiction call - return one atom
      if (urlStr.includes("jurisdiction=bastrop_tx")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:local:bastrop:section-primary",
                snippet: "Bastrop height requirements",
                score: 0.92,
                sectionNumber: "H.1",
                jurisdictionTenant: "bastrop_tx",
              },
            ],
          }),
        } as Response;
      }
      
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    const atoms = await retrieveAtomsForQuestion({
      jurisdictionKey: "bastrop_tx",
      question: "building height limits",
      limit: 8,
    });

    // Should have 1 primary + 1 ICC supplement atom
    expect(atoms).toHaveLength(2);
    
    const jurisdictionAtoms = atoms.filter((a) => a.codeSource === "jurisdiction");
    expect(jurisdictionAtoms).toHaveLength(1);
    expect(jurisdictionAtoms[0]?.id).toBe("did:local:bastrop:section-primary");
    
    const iccAtoms = atoms.filter((a) => a.codeSource === "icc-model-code");
    expect(iccAtoms).toHaveLength(1);
    expect(iccAtoms[0]?.id).toBe("did:icc:ibc2018:section-1234");
    expect(iccAtoms[0]?.body).toBe("IBC 2018 building height limits");
  });

  it("tags primary atoms with codeSource='jurisdiction'", async () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "false";
    
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (urlStr.includes("jurisdiction=bastrop_tx")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:local:bastrop:section-abc",
                snippet: "Bastrop setback requirements",
                score: 0.92,
                sectionNumber: "10.2.1",
                jurisdictionTenant: "bastrop_tx",
              },
            ],
          }),
        } as Response;
      }
      
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    const atoms = await retrieveAtomsForQuestion({
      jurisdictionKey: "bastrop_tx",
      question: "setbacks",
      limit: 8,
    });

    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.codeSource).toBe("jurisdiction");
  });

  it("degrades gracefully when ICC supplement call fails", async () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "true";

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (urlStr.includes("jurisdiction=icc-model-code")) {
        throw new Error("Network error");
      }
      
      if (urlStr.includes("jurisdiction=bastrop_tx")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:local:bastrop:section-xyz",
                snippet: "Bastrop building code",
                score: 0.88,
                sectionNumber: "5.1",
                jurisdictionTenant: "bastrop_tx",
              },
            ],
          }),
        } as Response;
      }
      
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    const atoms = await retrieveAtomsForQuestion({
      jurisdictionKey: "bastrop_tx",
      question: "building code",
      limit: 8,
    });

    // Should still have the primary jurisdiction atom even though supplement failed
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.codeSource).toBe("jurisdiction");
    expect(atoms[0]?.id).toBe("did:local:bastrop:section-xyz");
  });

  it("skips supplement when FINDINGS_ICC_MODEL_CODE_SUPPLEMENT=false", async () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "false";

    let iccCallMade = false;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (urlStr.includes("jurisdiction=icc-model-code")) {
        iccCallMade = true;
      }
      
      // Primary jurisdiction call
      if (urlStr.includes("jurisdiction=bastrop_tx")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:local:bastrop:section-xyz",
                snippet: "Bastrop setback requirements",
                score: 0.88,
                sectionNumber: "5.1",
                jurisdictionTenant: "bastrop_tx",
              },
            ],
          }),
        } as Response;
      }
      
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    await retrieveAtomsForQuestion({
      jurisdictionKey: "bastrop_tx",
      question: "setbacks",
      limit: 8,
    });

    expect(iccCallMade).toBe(false);
  });

  it("skips supplement when BRIEF_RETRIEVAL_API_URL is unset", async () => {
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "true";
    // BRIEF_RETRIEVAL_API_URL is NOT set
    // BRIEF_CODE_RETRIEVAL is 'gate' but will fail and fall back to neon
    // Since we're in neon mode without substrate, supplement won't run
    
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    // This will fall back to neon mode (which will fail with db.select error in real use)
    // but the supplement won't run because BRIEF_RETRIEVAL_API_URL is unset
    try {
      await retrieveAtomsForQuestion({
        jurisdictionKey: "bastrop_tx",
        question: "setbacks",
        limit: 8,
      });
    } catch (err) {
      // Expected to fail with db.select error in neon mode
    }

    // No fetch should have been made for the supplement
    expect(fetchCalled).toBe(false);
  });

  it("caps ICC supplement at 6 atoms", async () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "true";

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (urlStr.includes("jurisdiction=icc-model-code")) {
        // Return 10 atoms, but we should cap at 6
        const results = Array.from({ length: 10 }, (_, i) => ({
          atomDid: `did:icc:section-${i}`,
          snippet: `IBC section ${i}`,
          score: 0.9 - i * 0.05,
          sectionNumber: `${i}.1`,
          jurisdictionTenant: "icc-model-code",
        }));
        
        return {
          ok: true,
          json: async () => ({ results }),
        } as Response;
      }
      
      // Primary jurisdiction call
      if (urlStr.includes("jurisdiction=bastrop_tx")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:local:bastrop:section-main",
                snippet: "Bastrop building code",
                score: 0.95,
                sectionNumber: "1.1",
                jurisdictionTenant: "bastrop_tx",
              },
            ],
          }),
        } as Response;
      }
      
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    const atoms = await retrieveAtomsForQuestion({
      jurisdictionKey: "bastrop_tx",
      question: "building code",
      limit: 8,
    });

    const iccAtoms = atoms.filter((a) => a.codeSource === "icc-model-code");
    // Check that the request was made with limit=6
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("limit=6"),
      expect.anything()
    );
  });

  it("allows caller to explicitly disable supplement via options", async () => {
    process.env.BRIEF_RETRIEVAL_API_URL = "https://retrieval.test";
    process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT = "true";

    let iccCallMade = false;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (urlStr.includes("jurisdiction=icc-model-code")) {
        iccCallMade = true;
      }
      
      // Primary jurisdiction call
      if (urlStr.includes("jurisdiction=bastrop_tx")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                atomDid: "did:local:bastrop:section-abc",
                snippet: "Bastrop setback requirements",
                score: 0.92,
                sectionNumber: "10.1",
                jurisdictionTenant: "bastrop_tx",
              },
            ],
          }),
        } as Response;
      }
      
      return {
        ok: true,
        json: async () => ({ results: [] }),
      } as Response;
    }) as typeof fetch;

    await retrieveAtomsForQuestion({
      jurisdictionKey: "bastrop_tx",
      question: "setbacks",
      limit: 8,
      includeIccModelCodeSupplement: false,
    });

    expect(iccCallMade).toBe(false);
  });
});
