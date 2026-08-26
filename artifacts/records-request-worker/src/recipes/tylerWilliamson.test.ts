import { describe, expect, it, vi } from "vitest";
import {
  resolvePortalIdForJob,
  runRecipeForJob,
} from "./index.js";
import {
  portalUnreachableResult,
  runTylerWilliamsonRecipe,
  tylerWilliamsonRecipeSteps,
  tylerWilliamsonScaffoldCompleteScope,
  TYLER_WILLIAMSON_RECIPE_VERSION,
  WILLIAMSON_TYLERHOST_PORTAL,
  WILLIAMSON_TYLERHOST_PORTAL_ID,
} from "./tylerWilliamson.js";
import type { RecordsRecipeBrowser, RecordsRecipeContext } from "./types.js";

const BASE_CTX: RecordsRecipeContext = {
  jobId: "job-1",
  countyFips: "48491",
  parcelKey: "apn:48491:R123456",
  portalId: WILLIAMSON_TYLERHOST_PORTAL_ID,
  requestPayload: {},
};

describe("resolvePortalIdForJob", () => {
  it("defaults Williamson to TylerHost when payload omits portalId", () => {
    expect(resolvePortalIdForJob("48491", {})).toBe(WILLIAMSON_TYLERHOST_PORTAL_ID);
  });

  it("honours explicit portalId in request payload", () => {
    expect(
      resolvePortalIdForJob("48491", { portalId: "williamson-publicsearch" }),
    ).toBe("williamson-publicsearch");
  });

  it("returns null for counties without a registered recipe", () => {
    expect(resolvePortalIdForJob("48453", {})).toBeNull();
  });
});

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
    const browser: RecordsRecipeBrowser = { goto };

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
    const browser: RecordsRecipeBrowser = {
      goto: vi.fn().mockResolvedValue(nav),
    };

    const result = await runTylerWilliamsonRecipe(BASE_CTX, browser);

    expect(result).toEqual(
      portalUnreachableResult(tylerWilliamsonRecipeSteps()[0]!, nav),
    );
  });

  it("does not attempt login in scaffold mode", async () => {
    const goto = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await runTylerWilliamsonRecipe(BASE_CTX, { goto });

    const loginStep = tylerWilliamsonRecipeSteps().find(
      (s) => s.kind === "login-placeholder",
    );
    expect(loginStep).toBeDefined();
    expect(goto).not.toHaveBeenCalledWith(loginStep!.url);
  });
});

describe("runRecipeForJob", () => {
  it("refuses unregistered portal ids", async () => {
    const browser: RecordsRecipeBrowser = {
      goto: vi.fn(),
    };
    const result = await runRecipeForJob(
      { ...BASE_CTX, portalId: "travis-tccsearch" },
      browser,
    );
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("recipe-not-registered");
    expect(browser.goto).not.toHaveBeenCalled();
  });

  it("runs the TylerHost recipe for Williamson", async () => {
    const browser: RecordsRecipeBrowser = {
      goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    };
    const result = await runRecipeForJob(BASE_CTX, browser);
    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.recipeVersion).toBe(TYLER_WILLIAMSON_RECIPE_VERSION);
  });
});
