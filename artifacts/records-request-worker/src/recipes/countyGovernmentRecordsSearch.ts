/**
 * P-113 — Caldwell County Government Records (Tyler Technologies
 * "CountyGovernmentRecords.com" / landrecords product) index search.
 *
 * Ground truth, verified live 2026-09-03 (read-only navigation only — no
 * search submitted, no document purchased): this vendor is a DIFFERENT
 * Tyler Technologies product than the ERSS/web-self-service surfaces used
 * by Hays and McLennan. The splash page's only action is "Enter", which
 * always routes to /texas/web/login.jsp. There is no anonymous search path
 * at all — "Users of this site must register to conduct document searches."
 * (splash page copy, verbatim). This matches the P-113 dispatch's own
 * warning that two counties on a same-looking vendor name can expose
 * materially different surfaces: same company as McLennan's Tyler product,
 * materially different (login-gated) product.
 *
 * This recipe therefore reaches as far as an anonymous run legitimately
 * can — open entry, acknowledge the splash, detect the login wall — and
 * fails closed to needs-human/login-required, exactly the convention this
 * worker already uses for every other login-walled surface (Aumentum,
 * publicsearch, Tyler self-service). It does not register a scraper
 * account or hold a credential: NO PRIVILEGED DATA canon.
 *
 * The owner-name-search branch below is real, working code (unit-tested)
 * kept for the day the vendor exposes an anonymous search surface, or for
 * a differently-configured county on the same vendor — it is not reachable
 * against the real Caldwell deployment today, and the live test asserts
 * the verified login-required outcome, not the optimistic branch.
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

export const COUNTY_GOV_RECORDS_RECIPE_VERSION =
  "p85-caldwell-countygovernmentrecords-v1";

const SPLASH_ENTER_SELECTORS = [
  'form.splash input[type="submit"]',
  'input[type="submit"][value="Enter" i]',
] as const;

const NAME_INPUT_SELECTORS = [
  'input[name*="grantor" i]',
  'input[name*="grantee" i]',
  'input[id*="grantor" i]',
  'input[id*="grantee" i]',
  'input[name*="name" i]',
  'input[id*="name" i]',
] as const;

const SEARCH_SUBMIT_SELECTORS = [
  'input[type="submit"][value*="Search" i]',
  'button:has-text("Search")',
  'input[type="submit"]',
] as const;

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

export function countyGovernmentRecordsScope(
  ctx: RecordsRecipeContext,
  portal: Pick<P85PortalConfig, "portalId" | "countyFips">,
  details: {
    stepsReached: string[];
    captures: Array<Record<string, unknown>>;
    queries?: Array<Record<string, unknown>>;
    loginRequired?: boolean;
  },
): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    parcelKey: ctx.parcelKey,
    recipeVersion: COUNTY_GOV_RECORDS_RECIPE_VERSION,
    mode: "index-search",
    stepsReached: details.stepsReached,
    captures: details.captures,
  };
  if (details.queries) scope.queries = details.queries;
  if (details.loginRequired) scope.loginRequired = true;
  return scope;
}

export async function runCountyGovernmentRecordsSearch(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const stepsReached: string[] = [];
  const captures: Array<Record<string, unknown>> = [];

  const entryNav = await browser.goto(portal.entryUrl);
  const entryFailure = recipeResultFromNavigation(
    entryNav,
    `CountyGovernmentRecords entry unreachable (${portal.entryUrl})`,
  );
  if (entryFailure) {
    return entryFailure;
  }
  stepsReached.push("open-entry");

  const acknowledged = await tryClickFirst(browser, SPLASH_ENTER_SELECTORS);
  if (acknowledged) {
    stepsReached.push("acknowledge-splash");
  }

  const url = await browser.currentUrl();
  const loginTextHint = await browser.pageIncludes("register to conduct document searches");
  if (url.toLowerCase().includes("login") || loginTextHint) {
    const capture = await browser.captureFullPage("login-wall");
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
      errorCode: "login-required",
      errorMessage:
        "CountyGovernmentRecords.com requires free registration and login before any index search; no anonymous search path exists (verified live 2026-09-03)",
      scopeSearched: countyGovernmentRecordsScope(ctx, portal, {
        stepsReached,
        captures,
        loginRequired: true,
      }),
    };
  }

  // Not reached against the real, verified Caldwell deployment today (kept
  // for a future anonymous-search surface or a differently-configured
  // county on this vendor — see file header).
  const terms = resolveSearchTerms(ctx);
  const ownerQuery = terms.ownerName;
  if (!ownerQuery) {
    const capture = await browser.captureFullPage("countygovernmentrecords-no-search-terms");
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
      errorCode: "search-terms-missing",
      errorMessage: "Job payload lacks ownerName for CountyGovernmentRecords index search",
      scopeSearched: countyGovernmentRecordsScope(ctx, portal, {
        stepsReached,
        captures,
      }),
    };
  }

  const filled = await tryFillFirst(browser, NAME_INPUT_SELECTORS, ownerQuery);
  if (!filled) {
    return {
      status: "needs-human",
      errorCode: "search-ui-not-found",
      errorMessage: "CountyGovernmentRecords search form not found post-splash",
      scopeSearched: countyGovernmentRecordsScope(ctx, portal, {
        stepsReached,
        captures,
      }),
    };
  }
  stepsReached.push("fill-owner-query");
  const queries = [
    {
      kind: "owner-name",
      query: ownerQuery,
      timestamp: new Date().toISOString(),
    },
  ];

  const submitted =
    (await tryClickFirst(browser, SEARCH_SUBMIT_SELECTORS)) ||
    (await browser.pressEnter()).ok;
  if (!submitted) {
    return {
      status: "failed",
      errorCode: "search-submit-failed",
      errorMessage: "CountyGovernmentRecords owner-name search could not be submitted",
    };
  }
  stepsReached.push("submit-search");

  const resultsCapture = await browser.captureFullPage("owner-name-results");
  if (!resultsCapture.ok || !resultsCapture.sha256) {
    return {
      status: "failed",
      errorCode: "capture-failed",
      errorMessage:
        resultsCapture.errorMessage ?? "Failed to capture CountyGovernmentRecords results page",
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
    scope: countyGovernmentRecordsScope(ctx, portal, { stepsReached, captures, queries }),
    resultCount: null,
  });
}
