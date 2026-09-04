import { describe, expect, it, vi } from "vitest";
import {
  BROKEN_CANARY_SELECTOR_FIXTURE,
  checkRecipeCanarySelectors,
  canaryProbeForPortal,
} from "./recipeCanarySelectors.js";
import type { RecordsRecipeBrowser } from "./types.js";

function mockBrowser(overrides: Partial<RecordsRecipeBrowser> = {}): RecordsRecipeBrowser {
  return {
    goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    captureFullPage: vi.fn().mockResolvedValue({ ok: true, sha256: "x" }),
    click: vi.fn().mockResolvedValue({ ok: false }),
    fill: vi.fn().mockResolvedValue({ ok: false }),
    pressEnter: vi.fn().mockResolvedValue({ ok: false }),
    pageIncludes: vi.fn().mockResolvedValue(false),
    currentUrl: vi.fn().mockResolvedValue("https://example.test/"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    inspectDocumentPurchase: vi.fn().mockResolvedValue({
      visibleMainText: "",
      visibleMainControls: [],
      rowPriceText: null,
    }),
    ...overrides,
  };
}

describe("recipeCanarySelectors", () => {
  it("registers versioned probes for index-search portals", () => {
    const probe = canaryProbeForPortal("hays-erss");
    expect(probe?.recipeVersion).toBe("p85-tyler-self-service-v2");
    expect(probe?.driftSelectors.length).toBeGreaterThan(0);
  });

  it("passes when at least one drift selector clicks", async () => {
    const browser = mockBrowser({
      click: vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true }),
    });

    const result = await checkRecipeCanarySelectors("hays-erss", browser);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recipeVersion).toBe("p85-tyler-self-service-v2");
    }
  });

  it("fails visibly on deliberately broken selector fixture", async () => {
    const browser = mockBrowser({
      click: vi.fn().mockResolvedValue({ ok: false }),
    });

    const result = await checkRecipeCanarySelectors("williamson-publicsearch", browser, {
      driftSelectors: [BROKEN_CANARY_SELECTOR_FIXTURE],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("canary selector drift");
      expect(result.reason).toContain(BROKEN_CANARY_SELECTOR_FIXTURE);
      expect(result.recipeVersion).toBe("p85-publicsearch-v1");
    }
  });

  it("fails when entry navigation fails", async () => {
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue({ ok: false, status: 503, errorMessage: "down" }),
    });

    const result = await checkRecipeCanarySelectors("travis-tccsearch", browser);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("down");
    }
  });

  it("P-113: registers McLennan under the shared Tyler self-service probe (scaffold retired)", () => {
    const probe = canaryProbeForPortal("mclennan-online-records");
    expect(probe?.probeId).toBe("tyler-self-service-v2");
    expect(probe?.recipeVersion).toBe("p85-tyler-self-service-v2");
  });

  it("P-113: registers Caldwell under its own CountyGovernmentRecords probe (scaffold retired)", async () => {
    const probe = canaryProbeForPortal("caldwell-clerk-web");
    expect(probe?.probeId).toBe("caldwell-countygovernmentrecords-v1");
    expect(probe?.recipeVersion).toBe("p85-caldwell-countygovernmentrecords-v1");

    const browser = mockBrowser({
      click: vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true }),
    });
    const result = await checkRecipeCanarySelectors("caldwell-clerk-web", browser);
    expect(result.ok).toBe(true);
  });
});
