/**
 * P-85 item 5 — Tyler self-service clerk index search (Williamson TylerHost, Hays ERSS).
 *
 * Opens disclaimer, accepts when offered, detects login walls and reCAPTCHA,
 * navigates to the county search action when configured, runs owner-name
 * search when terms are present, and captures the results surface with hash.
 */

import {
  SEARCH_SUBMIT_SELECTORS,
  tryClickFirst,
  tryFillFirst,
} from "./browserSelectors.js";
import type { P85PortalConfig } from "./p85Portals.js";
import { resolveSearchTerms } from "./searchTerms.js";
import { finalizeIndexSearchWithAcquisition } from "./searchPostProcess.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";

export const TYLER_SELF_SERVICE_RECIPE_VERSION = "p85-tyler-self-service-v2";

/** Hays ERSS disclaimer accept control (disabled until reCAPTCHA completes). */
export const TYLER_ERSS_ACCEPT_SELECTORS = [
  "#submitDisclaimerAccept",
  'button:has-text("I Accept")',
] as const;

const TYLER_ACCEPT_SELECTORS = [
  ...TYLER_ERSS_ACCEPT_SELECTORS,
  'input[type="submit"][value*="Accept" i]',
  'button:has-text("Accept")',
  'a:has-text("Accept")',
  "#acceptDisclaimer",
  "#btnAccept",
] as const;

/** Tyler ERSS property index name fields (Grantor/Grantee/Both). */
export const TYLER_ERSS_SEARCH_INPUT_SELECTORS = [
  "#field_GrantorGrantee",
  'input[name="field_GrantorGrantee"]',
  "#field_Grantor",
  'input[name="field_Grantor"]',
  "#field_Grantee",
  'input[name="field_Grantee"]',
  'input[id*="GrantorGrantee" i]',
  'input[id*="Grantor" i]',
  'input[name*="Grantor" i]',
] as const;

const TYLER_SEARCH_INPUT_SELECTORS = [
  ...TYLER_ERSS_SEARCH_INPUT_SELECTORS,
  'input[name*="name" i]',
  'input[id*="name" i]',
  'input[placeholder*="name" i]',
  'input[type="search"]',
  'input[type="text"]',
] as const;

/**
 * McLennan Tyler self-service combined-name field (P-113, verified live
 * 2026-09-03 on DOCSEARCH402S1). Same "Tyler self-service" product family as
 * Hays ERSS but a different deployment: the combined grantor/grantee field
 * id is field_BothNamesID, not field_GrantorGrantee. Without this override,
 * the generic `input[id*="Grantor" i]` fallback (from
 * TYLER_ERSS_SEARCH_INPUT_SELECTORS, spread into the generic list above)
 * would match McLennan's Grantor-ONLY field first and silently miss the
 * Grantee side of an owner-name search.
 */
export const TYLER_MCLENNAN_SEARCH_INPUT_SELECTORS = [
  "#field_BothNamesID",
  'input[name="field_BothNamesID"]',
  'input[id*="BothNames" i]',
  ...TYLER_SEARCH_INPUT_SELECTORS,
] as const;

const TYLER_SEARCH_SUBMIT_SELECTORS = [
  ...SEARCH_SUBMIT_SELECTORS,
  "#searchButton",
  "#submit",
] as const;

export interface TylerPortalSurface {
  portalId: string;
  countyFips: string;
  disclaimerUrl: string;
  loginUrlHint: string;
  searchEntryUrl?: string;
}

export function tylerSurfaceFromPortal(portal: P85PortalConfig): TylerPortalSurface {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    disclaimerUrl: portal.entryUrl,
    loginUrlHint: portal.portalUrl,
    searchEntryUrl: portal.searchEntryUrl,
  };
}

export function disclaimerStillActive(url: string): boolean {
  return url.toLowerCase().includes("/user/disclaimer");
}

export function tylerSearchInputSelectorsForPortal(
  portalId: string,
): readonly string[] {
  if (portalId === "hays-erss") {
    return TYLER_ERSS_SEARCH_INPUT_SELECTORS;
  }
  if (portalId === "mclennan-online-records") {
    return TYLER_MCLENNAN_SEARCH_INPUT_SELECTORS;
  }
  return TYLER_SEARCH_INPUT_SELECTORS;
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

  const recaptchaPresent =
    (await browser.pageIncludes("g-recaptcha")) ||
    (await browser.pageIncludes("recaptcha"));

  const accepted = await tryClickFirst(browser, TYLER_ACCEPT_SELECTORS);
  if (accepted) {
    stepsReached.push("accept-disclaimer");
    // P-113 hardening (found via McLennan live grading 2026-09-03): the
    // disclaimer-accept click triggers an async cookie write; navigating to
    // searchEntryUrl before it lands bounces back to the disclaimer
    // (errorCode disclaimer-not-accepted even though accept-disclaimer was
    // reached). Bounded settle wait, not a fixed assumption of success.
    await browser.wait?.(1000);
  }

  if (portal.searchEntryUrl) {
    const searchNav = await browser.goto(portal.searchEntryUrl);
    if (searchNav.ok) {
      stepsReached.push("open-search-surface");
    }
  }

  const currentUrl = await browser.currentUrl();
  if (disclaimerStillActive(currentUrl)) {
    return {
      status: "needs-human",
      scopeSearched: {
        portalId: portal.portalId,
        countyFips: portal.countyFips,
        parcelKey: ctx.parcelKey,
        recipeVersion: TYLER_SELF_SERVICE_RECIPE_VERSION,
        mode: "index-search",
        stepsReached,
        recaptchaPresent,
        reason: recaptchaPresent
          ? "Tyler ERSS disclaimer requires reCAPTCHA before index search"
          : "Tyler disclaimer was not accepted; search surface unavailable",
      },
      errorCode: recaptchaPresent ? "captcha-required" : "disclaimer-not-accepted",
      errorMessage: recaptchaPresent
        ? "Hays ERSS disclaimer blocked by reCAPTCHA; routed to needs-human"
        : "Tyler disclaimer not accepted; cannot reach index search",
    };
  }

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

  const searchSelectors = tylerSearchInputSelectorsForPortal(portal.portalId);
  const filled = await tryFillFirst(browser, searchSelectors, ownerQuery);
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
  // P-113 hardening (found via McLennan live grading 2026-09-03): this
  // vendor's search-results panel renders via async AJAX after submit
  // (searchPost + searchResults requests), not a synchronous page nav.
  // Capturing/extracting immediately raced the render and produced a
  // fabricated-looking zero (1,706 real results, 0 rows seen). Bounded
  // settle wait before capture, not a fixed assumption of completion.
  await browser.wait?.(2000);

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
