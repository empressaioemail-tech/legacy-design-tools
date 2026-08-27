/**
 * P-85 item 5 — Tyler self-service clerk index search (Williamson TylerHost, Hays ERSS).
 *
 * Opens disclaimer, accepts when offered, detects login walls, runs owner-name
 * search when terms are present, and captures the results surface with hash.
 */

import type { P85PortalConfig } from "./p85Portals.js";
import { resolveSearchTerms } from "./searchTerms.js";
import { finalizeIndexSearchWithAcquisition } from "./searchPostProcess.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";

export const TYLER_SELF_SERVICE_RECIPE_VERSION = "p85-tyler-self-service-v1";

const TYLER_ACCEPT_SELECTORS = [
  'input[type="submit"][value*="Accept" i]',
  'button:has-text("I Accept")',
  'button:has-text("Accept")',
  'a:has-text("Accept")',
  "#acceptDisclaimer",
  "#btnAccept",
] as const;

const TYLER_SEARCH_INPUT_SELECTORS = [
  'input[name*="name" i]',
  'input[id*="name" i]',
  'input[placeholder*="name" i]',
  'input[type="search"]',
  'input[type="text"]',
] as const;

const TYLER_SEARCH_SUBMIT_SELECTORS = [
  'input[type="submit"][value*="Search" i]',
  'button:has-text("Search")',
  'button[type="submit"]',
] as const;

export interface TylerPortalSurface {
  portalId: string;
  countyFips: string;
  disclaimerUrl: string;
  loginUrlHint: string;
}

export function tylerSurfaceFromPortal(portal: P85PortalConfig): TylerPortalSurface {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    disclaimerUrl: portal.entryUrl,
    loginUrlHint: portal.portalUrl,
  };
}

async function tryClickFirst(
  browser: RecordsRecipeBrowser,
  selectors: readonly string[],
): Promise<boolean> {
  for (const selector of selectors) {
    const result = await browser.click(selector);
    if (result.ok) return true;
  }
  return false;
}

async function tryFillFirst(
  browser: RecordsRecipeBrowser,
  selectors: readonly string[],
  value: string,
): Promise<boolean> {
  for (const selector of selectors) {
    const result = await browser.fill(selector, value);
    if (result.ok) return true;
  }
  return false;
}

function loginLikely(url: string, pageTextHints: boolean): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("/login") ||
    lower.includes("/signin") ||
    lower.includes("user/login") ||
    pageTextHints
  );
}

export function tylerSearchCompleteScope(
  ctx: RecordsRecipeContext,
  portal: TylerPortalSurface,
  details: {
    queries: Array<Record<string, unknown>>;
    captures: Array<Record<string, unknown>>;
    resultCount: number | null;
    stepsReached: string[];
  },
): Record<string, unknown> {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    parcelKey: ctx.parcelKey,
    recipeVersion: TYLER_SELF_SERVICE_RECIPE_VERSION,
    mode: "index-search",
    stepsReached: details.stepsReached,
    queries: details.queries,
    captures: details.captures,
    resultCount: details.resultCount,
    documentTypes: "all",
    dateRange: "portal-default",
  };
}

export async function runTylerSelfServiceSearch(
  ctx: RecordsRecipeContext,
  portal: TylerPortalSurface,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const stepsReached: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const captures: Array<Record<string, unknown>> = [];

  const disclaimerNav = await browser.goto(portal.disclaimerUrl);
  if (!disclaimerNav.ok) {
    return {
      status: "failed",
      errorCode: "portal-unreachable",
      errorMessage: `Tyler disclaimer unreachable (${portal.disclaimerUrl}): ${disclaimerNav.errorMessage ?? "navigation failed"}`,
    };
  }
  stepsReached.push("open-disclaimer");

  const accepted = await tryClickFirst(browser, TYLER_ACCEPT_SELECTORS);
  if (accepted) {
    stepsReached.push("accept-disclaimer");
  }

  const currentUrl = await browser.currentUrl();
  const loginTextHint = await browser.pageIncludes("sign in");
  if (loginLikely(currentUrl, loginTextHint)) {
    return {
      status: "needs-human",
      scopeSearched: {
        portalId: portal.portalId,
        countyFips: portal.countyFips,
        parcelKey: ctx.parcelKey,
        recipeVersion: TYLER_SELF_SERVICE_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        loginRequired: true,
        reason: "Tyler portal presented login before index search could run",
      },
      errorCode: "login-required",
      errorMessage: "Portal requires login; routed to needs-human",
    };
  }

  const terms = resolveSearchTerms(ctx);
  const ownerQuery = terms.ownerName;
  if (!ownerQuery) {
    const capture = await browser.captureFullPage("post-disclaimer-no-search-terms");
    if (capture.ok && capture.sha256) {
      captures.push({
        label: capture.label,
        sha256: capture.sha256,
        byteLength: capture.byteLength,
        timestamp: new Date().toISOString(),
      });
    }
    return {
      status: "needs-human",
      scopeSearched: {
        portalId: portal.portalId,
        countyFips: portal.countyFips,
        parcelKey: ctx.parcelKey,
        recipeVersion: TYLER_SELF_SERVICE_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        captures,
        missingInput: "ownerName",
        reason: "No CAD owner name on job payload; cannot run Tyler name search",
      },
      errorCode: "search-terms-missing",
      errorMessage: "Job payload lacks ownerName for Tyler index search",
    };
  }

  const filled = await tryFillFirst(browser, TYLER_SEARCH_INPUT_SELECTORS, ownerQuery);
  if (!filled) {
    return {
      status: "needs-human",
      scopeSearched: {
        portalId: portal.portalId,
        countyFips: portal.countyFips,
        parcelKey: ctx.parcelKey,
        recipeVersion: TYLER_SELF_SERVICE_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        reason: "Could not locate Tyler search input on post-disclaimer surface",
      },
      errorCode: "search-ui-not-found",
      errorMessage: "Tyler search form not found after disclaimer",
    };
  }
  stepsReached.push("fill-owner-query");
  queries.push({
    kind: "owner-name",
    query: ownerQuery,
    timestamp: new Date().toISOString(),
  });

  const submitted =
    (await tryClickFirst(browser, TYLER_SEARCH_SUBMIT_SELECTORS)) ||
    (await browser.pressEnter()).ok;
  if (!submitted) {
    return {
      status: "failed",
      errorCode: "search-submit-failed",
      errorMessage: "Tyler owner-name search could not be submitted",
    };
  }
  stepsReached.push("submit-search");

  const resultsCapture = await browser.captureFullPage("owner-name-results");
  if (!resultsCapture.ok || !resultsCapture.sha256) {
    return {
      status: "failed",
      errorCode: "capture-failed",
      errorMessage:
        resultsCapture.errorMessage ??
        "Failed to capture Tyler results page after search",
    };
  }
  captures.push({
    label: resultsCapture.label,
    sha256: resultsCapture.sha256,
    byteLength: resultsCapture.byteLength,
    timestamp: new Date().toISOString(),
  });
  stepsReached.push("capture-results");

  return finalizeIndexSearchWithAcquisition({
    ctx,
    portalId: portal.portalId,
    browser,
    scope: tylerSearchCompleteScope(ctx, portal, {
      queries,
      captures,
      resultCount: null,
      stepsReached,
    }),
    resultCount: null,
  });
}
