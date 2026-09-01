/**
 * P-85 item 5 — Williamson publicsearch.us index search.
 *
 * Default Williamson portal (TylerHost returns HTTP 403 to headless bots).
 */

import type { P85PortalConfig } from "./p85Portals.js";
import { resolveSearchTerms } from "./searchTerms.js";
import { finalizeIndexSearchWithAcquisition } from "./searchPostProcess.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";
import { recipeResultFromNavigation } from "../navigationFailure.js";

export const PUBLICSEARCH_RECIPE_VERSION = "p85-publicsearch-v1";

/** Grading fixture — Williamson R-account with TxGIO owner (joinIntegrityGate.test). */
export const WILLIAMSON_GRADING_PARCEL: RecordsRecipeContext = {
  jobId: "job-williamson-grade",
  countyFips: "48491",
  parcelKey: "apn:48491:R062578",
  portalId: "williamson-publicsearch",
  requestPayload: {
    searchTerms: {
      ownerName: "PURVIS MICHAEL",
      propId: "R062578",
    },
  },
};

const TERMS_ACCEPT_SELECTORS = [
  'button:has-text("Accept")',
  'button:has-text("I Agree")',
  'a:has-text("Accept")',
  'input[type="submit"][value*="Accept" i]',
] as const;

const SEARCH_INPUT_SELECTORS = [
  'input[name*="name" i]',
  'input[placeholder*="name" i]',
  'input[type="search"]',
  'input[aria-label*="search" i]',
] as const;

const SEARCH_SUBMIT_SELECTORS = [
  'button:has-text("Search")',
  'button[type="submit"]',
  'input[type="submit"]',
] as const;

/** Expected scopeSearched shape for a successful Williamson publicsearch index search. */
export function publicsearchIndexSearchScope(
  ctx: RecordsRecipeContext,
  portal: Pick<P85PortalConfig, "portalId" | "countyFips">,
  details: {
    stepsReached: string[];
    queries: Array<Record<string, unknown>>;
    captures: Array<Record<string, unknown>>;
    resultCount: number | null;
    indexHits?: Array<Record<string, unknown>>;
    acquisition?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    parcelKey: ctx.parcelKey,
    recipeVersion: PUBLICSEARCH_RECIPE_VERSION,
    mode: "index-search",
    stepsReached: details.stepsReached,
    queries: details.queries,
    captures: details.captures,
    resultCount: details.resultCount,
    documentTypes: "all",
    dateRange: "portal-default",
  };
  if (details.indexHits) {
    scope.indexHits = details.indexHits;
  }
  if (details.acquisition) {
    scope.acquisition = details.acquisition;
  }
  return scope;
}

export async function runPublicsearchRecipe(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const stepsReached: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const captures: Array<Record<string, unknown>> = [];

  const entryNav = await browser.goto(portal.entryUrl);
  const entryFailure = recipeResultFromNavigation(
    entryNav,
    `publicsearch entry unreachable (${portal.entryUrl})`,
  );
  if (entryFailure) {
    return entryFailure;
  }
  stepsReached.push("open-entry");

  const accepted = await tryClickFirst(browser, TERMS_ACCEPT_SELECTORS);
  if (accepted) {
    stepsReached.push("accept-terms");
  }

  const portalNav = await browser.goto(portal.portalUrl);
  const portalFailure = recipeResultFromNavigation(
    portalNav,
    `publicsearch portal unreachable (${portal.portalUrl})`,
  );
  if (portalFailure) {
    return portalFailure;
  }
  stepsReached.push("open-portal");

  const url = await browser.currentUrl();
  if (url.toLowerCase().includes("login") || (await browser.pageIncludes("sign in"))) {
    return {
      status: "needs-human",
      scopeSearched: {
        portalId: portal.portalId,
        countyFips: portal.countyFips,
        parcelKey: ctx.parcelKey,
        recipeVersion: PUBLICSEARCH_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        loginRequired: true,
        reason: "publicsearch presented login before search",
      },
      errorCode: "login-required",
      errorMessage: "publicsearch requires login; routed to needs-human",
    };
  }

  const terms = resolveSearchTerms(ctx);
  const ownerQuery = terms.ownerName;
  if (!ownerQuery) {
    const capture = await browser.captureFullPage("publicsearch-no-search-terms");
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
        recipeVersion: PUBLICSEARCH_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        captures,
        missingInput: "ownerName",
      },
      errorCode: "search-terms-missing",
      errorMessage: "Job payload lacks ownerName for publicsearch index search",
    };
  }

  const filled = await tryFillFirst(browser, SEARCH_INPUT_SELECTORS, ownerQuery);
  if (!filled) {
    return {
      status: "needs-human",
      scopeSearched: {
        portalId: portal.portalId,
        countyFips: portal.countyFips,
        parcelKey: ctx.parcelKey,
        recipeVersion: PUBLICSEARCH_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        reason: "publicsearch search input not found",
      },
      errorCode: "search-ui-not-found",
      errorMessage: "publicsearch search form not found",
    };
  }
  stepsReached.push("fill-owner-query");
  queries.push({
    kind: "owner-name",
    query: ownerQuery,
    timestamp: new Date().toISOString(),
  });

  const submitted =
    (await tryClickFirst(browser, SEARCH_SUBMIT_SELECTORS)) ||
    (await browser.pressEnter()).ok;
  if (!submitted) {
    return {
      status: "failed",
      errorCode: "search-submit-failed",
      errorMessage: "publicsearch owner-name search could not be submitted",
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
        "Failed to capture publicsearch results page",
    };
  }
  captures.push({
    label: resultsCapture.label,
    sha256: resultsCapture.sha256,
    byteLength: resultsCapture.byteLength,
    timestamp: new Date().toISOString(),
  });

  return finalizeIndexSearchWithAcquisition({
    ctx,
    portalId: portal.portalId,
    browser,
    scope: publicsearchIndexSearchScope(ctx, portal, {
      stepsReached,
      queries,
      captures,
      resultCount: null,
    }),
    resultCount: null,
  });
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
