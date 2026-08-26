import { describe, expect, it, vi, beforeEach } from "vitest";

const selectMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    select: selectMock,
  },
  clerkPortalTerms: { portalId: "portal_id" },
}));

describe("clerkPortalSearchGate", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  function mockRow(row: Record<string, unknown> | undefined) {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(row ? [row] : []),
    };
    selectMock.mockReturnValue(chain);
    return chain;
  }

  it("refuses when portal terms row is missing", async () => {
    mockRow(undefined);
    const { assertPortalAllowsAutomatedSearch } = await import(
      "../clerkPortalSearchGate"
    );
    const result = await assertPortalAllowsAutomatedSearch("missing-portal");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PORTAL_TERMS_MISSING");
    }
  });

  it("refuses when automated_search is unknown", async () => {
    mockRow({ portalId: "hays-erss", automatedSearch: "unknown" });
    const { assertPortalAllowsAutomatedSearch } = await import(
      "../clerkPortalSearchGate"
    );
    const result = await assertPortalAllowsAutomatedSearch("hays-erss");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PORTAL_TERMS_UNKNOWN");
    }
  });

  it("refuses when automated_search is prohibited", async () => {
    mockRow({ portalId: "travis-tccsearch", automatedSearch: "prohibited" });
    const { assertPortalAllowsAutomatedSearch } = await import(
      "../clerkPortalSearchGate"
    );
    const result = await assertPortalAllowsAutomatedSearch("travis-tccsearch");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PORTAL_AUTOMATED_SEARCH_PROHIBITED");
    }
  });

  it("allows permitted and tolerated", async () => {
    mockRow({ portalId: "hays-erss", automatedSearch: "permitted" });
    const { assertPortalAllowsAutomatedSearch } = await import(
      "../clerkPortalSearchGate"
    );
    const result = await assertPortalAllowsAutomatedSearch("hays-erss");
    expect(result).toEqual({ ok: true, automatedSearch: "permitted" });
  });

  it("assertCountyPortalsAllowAutomatedSearch refuses when any portal fails", async () => {
    mockRow({ portalId: "williamson-tylerhost", automatedSearch: "permitted" });
    const { assertCountyPortalsAllowAutomatedSearch } = await import(
      "../clerkPortalSearchGate"
    );

    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi
        .fn()
        .mockResolvedValueOnce([
          { portalId: "williamson-tylerhost", automatedSearch: "permitted" },
        ])
        .mockResolvedValueOnce([
          { portalId: "williamson-publicsearch", automatedSearch: "unknown" },
        ]),
    };
    selectMock.mockReturnValue(chain);

    const result = await assertCountyPortalsAllowAutomatedSearch("48491");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PORTAL_TERMS_UNKNOWN");
      expect(result.portalId).toBe("williamson-publicsearch");
    }
  });
});
