import { describe, expect, it, vi } from "vitest";
import {
  portalUnreachableResult,
  runTylerWilliamsonRecipe,
  tylerWilliamsonRecipeSteps,
  tylerWilliamsonScaffoldCompleteScope,
  WILLIAMSON_TYLERHOST_PORTAL,
  WILLIAMSON_TYLERHOST_PORTAL_ID,
} from "./tylerWilliamson.js";
import type { RecordsRecipeBrowser, RecordsRecipeContext } from "./types.js";

function mockBrowser(overrides: Partial<RecordsRecipeBrowser> = {}): RecordsRecipeBrowser {
  return {
    goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    captureFullPage: vi.fn().mockResolvedValue({ ok: true, sha256: "x", byteLength: 1, label: "t" }),
    click: vi.fn().mockResolvedValue({ ok: false }),
    fill: vi.fn().mockResolvedValue({ ok: false }),
    pressEnter: vi.fn().mockResolvedValue({ ok: false }),
    pageIncludes: vi.fn().mockResolvedValue(false),
    currentUrl: vi.fn().mockResolvedValue("https://example.test"),
    extractResultRows: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const BASE_CTX: RecordsRecipeContext = {
  jobId: "job-1",
  countyFips: "48491",
  parcelKey: "apn:48491:R123456",
  portalId: WILLIAMSON_TYLERHOST_PORTAL_ID,
  requestPayload: {},
};

describe("tylerWilliamsonRecipeSteps", () => {
  it("declares disclaimer before login placeholder", () => {
    const steps = tylerWilliamsonRecipeSteps();
    expect(steps[0]?.kind).toBe("disclaimer");
    expect(steps.some((s) => s.kind === "login-placeholder")).toBe(true);
    expect(steps[steps.length - 1]?.kind).toBe("search-placeholder");
  });
});

describe("runTylerWilliamsonRecipe", () => {
  it("completes with scaffold scope when disclaimer is reachable", async () => {
    const goto = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const browser = mockBrowser({ goto });

    const result = await runTylerWilliamsonRecipe(BASE_CTX, browser);

    expect(result.status).toBe("complete");
    expect(result.scopeSearched).toEqual(
      tylerWilliamsonScaffoldCompleteScope(BASE_CTX, ["open-disclaimer"]),
    );
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith(WILLIAMSON_TYLERHOST_PORTAL.disclaimerUrl);
  });

  it("fails closed when disclaimer navigation is unreachable", async () => {
    const nav = { ok: false, status: 503, errorMessage: "HTTP 503" };
    const browser = mockBrowser({
      goto: vi.fn().mockResolvedValue(nav),
    });

    const result = await runTylerWilliamsonRecipe(BASE_CTX, browser);

    expect(result).toEqual(
      portalUnreachableResult(tylerWilliamsonRecipeSteps()[0]!, nav),
    );
  });

  it("does not attempt login in scaffold mode", async () => {
    const goto = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await runTylerWilliamsonRecipe(BASE_CTX, mockBrowser({ goto }));

    const loginStep = tylerWilliamsonRecipeSteps().find(
      (s) => s.kind === "login-placeholder",
    );
    expect(loginStep).toBeDefined();
    expect(goto).not.toHaveBeenCalledWith(loginStep!.url);
  });
});
