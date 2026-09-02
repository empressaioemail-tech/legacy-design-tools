/**
 * P-85 item 5 — Aumentum clerk index search (Bastrop, Travis tccsearch).
 *
 * Opens the RealEstate search surface, runs each planned query, captures
 * every results page with SHA-256, and extracts index hits for acquisition.
 */

import type { P85PortalConfig } from "./p85Portals.js";
import {
  SEARCH_SUBMIT_SELECTORS,
  TERMS_ACCEPT_SELECTORS,
  tryClickFirst,
  tryFillFirst,
} from "./browserSelectors.js";
import {
  UNRESOLVED_RESULT_ROW_HEADER,
  dedupeIndexHits,
  extractIndexHitsFromPage,
  parseIndexHitsFromScope,
  vendorFamilyFromPortalId,
  type IndexSearchHit,
} from "./indexHits.js";
import {
  acquireIndexHits,
  acquisitionAwaitingPurchaseResult,
  acquisitionNeedsHumanResult,
  mergeAcquisitionIntoScope,
} from "./instrumentAcquisition.js";
import { assertBastropSearchSettled } from "./searchOutcome.js";
import { resolveSearchTerms } from "./searchTerms.js";
import {
  buildSearchQueryPlan,
  type PlannedSearchQuery,
} from "./searchQueryPlan.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";
import { recipeResultFromNavigation } from "../navigationFailure.js";

export const AUMENTUM_INDEX_SEARCH_RECIPE_VERSION = "p85-aumentum-index-search-v3";

function isBastropSearchEntryPortal(portal: P85PortalConfig): boolean {
  return portal.portalId === "bastrop-aumentum";
}

const GRANTOR_ENTRY_SELECTORS = [
  'a:has-text("Grantor")',
  'a:has-text("Grantee")',
  'a[href*="Grantor" i]',
  'a[href*="Grantee" i]',
  'a[href*="Name" i]',
] as const;

const LEGAL_ENTRY_SELECTORS = [
  'a:has-text("Legal Description")',
  'a[href*="Legal" i]',
] as const;

const SUBDIVISION_ENTRY_SELECTORS = [
  'a:has-text("Subdivision")',
  'a:has-text("Lot/Block")',
  'a[href*="Subdivision" i]',
] as const;

const NAME_INPUT_SELECTORS = [
  'input[name*="Grantor" i]',
  'input[name*="Grantee" i]',
  'input[name*="Name" i]',
  'input[id*="Name" i]',
  'input[type="text"]',
] as const;

const LEGAL_INPUT_SELECTORS = [
  'textarea[name*="Legal" i]',
  'input[name*="Legal" i]',
  'textarea[id*="Legal" i]',
  'textarea',
] as const;

const SUBDIVISION_INPUT_SELECTORS = [
  'input[name*="Subdivision" i]',
  'input[name*="Lot" i]',
  'input[name*="Block" i]',
  'textarea[name*="Subdivision" i]',
] as const;

function searchTermsUrlForPortal(portal: P85PortalConfig): string {
  const base = portal.portalUrl.replace(/\/$/, "");
  if (portal.portalId === "travis-tccsearch") {
    return `${base}/RealEstate/SearchTerms.aspx`;
  }
  if (isBastropSearchEntryPortal(portal)) {
    return `${base}/SearchEntry.aspx`;
  }
  return portal.entryUrl;
}

function disclaimerUrlForPortal(portal: P85PortalConfig): string | null {
  if (portal.portalId === "travis-tccsearch") {
    return portal.entryUrl;
  }
  if (isBastropSearchEntryPortal(portal)) {
    return portal.portalUrl;
  }
  return null;
}

function bastropSearchEntryUrl(portal: P85PortalConfig): string {
  return `${portal.portalUrl.replace(/\/$/, "")}/SearchEntry.aspx`;
}

export function aumentumIndexSearchScope(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  details: {
    stepsReached: string[];
    queries: Array<Record<string, unknown>>;
    captures: Array<Record<string, unknown>>;
    indexHits: IndexSearchHit[];
  },
): Record<string, unknown> {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    parcelKey: ctx.parcelKey,
    recipeVersion: AUMENTUM_INDEX_SEARCH_RECIPE_VERSION,
    mode: "index-search",
    stepsReached: details.stepsReached,
    queries: details.queries,
    captures: details.captures,
    resultCount: details.indexHits.length,
    indexHits: details.indexHits.map((h) => ({
      recordingRef: h.recordingRef,
      documentType: h.documentType,
      recordingDate: h.recordingDate,
      parties: h.parties,
      detailUrl: h.detailUrl,
    })),
    documentTypes: "all",
    dateRange: "portal-default",
  };
}

async function openSearchTermsSurface(
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
  stepsReached: string[],
): Promise<{ ok: true } | { ok: false; result: RecordsRecipeResult }> {
  const disclaimer = disclaimerUrlForPortal(portal);
  if (disclaimer) {
    const nav = await browser.goto(disclaimer);
    const navFailure = recipeResultFromNavigation(
      nav,
      `Aumentum disclaimer unreachable (${disclaimer})`,
    );
    if (navFailure) {
      return { ok: false, result: navFailure };
    }
    stepsReached.push("open-disclaimer");
    if (!(await tryClickFirst(browser, TERMS_ACCEPT_SELECTORS))) {
      return {
        ok: false,
        result: {
          status: "failed",
          errorCode: "portal-unreachable",
          errorMessage: "Aumentum disclaimer accept control not found",
        },
      };
    }
    stepsReached.push("accept-disclaimer");
  }

  if (isBastropSearchEntryPortal(portal)) {
    let url = await browser.currentUrl();
    if (!url.includes("SearchEntry.aspx")) {
      const entryNav = await browser.goto(bastropSearchEntryUrl(portal));
      const entryFailure = recipeResultFromNavigation(
        entryNav,
        "Bastrop search entry unreachable",
      );
      if (entryFailure) {
        return { ok: false, result: entryFailure };
      }
    }
    stepsReached.push("open-search-entry");
  } else {
    const searchTermsUrl = searchTermsUrlForPortal(portal);
    const nav = await browser.goto(searchTermsUrl);
    const navFailure = recipeResultFromNavigation(
      nav,
      `Aumentum search terms unreachable (${searchTermsUrl})`,
    );
    if (navFailure) {
      return { ok: false, result: navFailure };
    }
    stepsReached.push("open-search-terms");
    if (await tryClickFirst(browser, TERMS_ACCEPT_SELECTORS)) {
      stepsReached.push("accept-search-terms");
    }
  }

  const url = await browser.currentUrl();
  if (
    url.toLowerCase().includes("login") ||
    (await browser.pageIncludes("sign in"))
  ) {
    return {
      ok: false,
      result: {
        status: "needs-human",
        errorCode: "login-required",
        errorMessage: "Aumentum portal requires login before index search",
        scopeSearched: {
          portalId: portal.portalId,
          countyFips: portal.countyFips,
          mode: "index-search",
          stepsReached,
          loginRequired: true,
        },
      },
    };
  }

  return { ok: true };
}

const BASTROP_SEPARATE_NAME_RADIO = "#cphNoMargin_f_rdoSep";
const BASTROP_GRANTOR_INPUT = "#cphNoMargin_f_txtGrantor";
const BASTROP_LEGAL_INPUT = "#cphNoMargin_f_txtLDFreeForm";
const BASTROP_LOT_INPUT = "#cphNoMargin_f_txtLDLot";
const BASTROP_SEARCH_BUTTON = "#cphNoMargin_SearchButtons1_btnSearch";

async function prepareBastropSearchForm(
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
): Promise<{ ok: true } | { ok: false; result: RecordsRecipeResult }> {
  const url = await browser.currentUrl();
  if (url.includes("SearchResults.aspx")) {
    if (await tryClickFirst(browser, ['a:has-text("New Search")'])) {
      return { ok: true };
    }
  }
  if (url.includes("SearchEntry.aspx")) {
    return { ok: true };
  }
  const nav = await browser.goto(bastropSearchEntryUrl(portal));
  const navFailure = recipeResultFromNavigation(
    nav,
    "Bastrop search entry unreachable",
  );
  if (navFailure) {
    return { ok: false, result: navFailure };
  }
  return { ok: true };
}

async function runBastropSearchEntryQuery(
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
  planned: PlannedSearchQuery,
): Promise<
  | {
      ok: true;
      queryRecord: Record<string, unknown>;
      capture: Record<string, unknown>;
      hits: IndexSearchHit[];
    }
  | { ok: false; result: RecordsRecipeResult }
> {
  await browser.beforePortalAction?.();
  const prepared = await prepareBastropSearchForm(portal, browser);
  if (!prepared.ok) {
    return prepared;
  }

  let filled = false;
  if (planned.kind === "owner-name") {
    if (!(await browser.click(BASTROP_SEPARATE_NAME_RADIO)).ok) {
      return {
        ok: false,
        result: {
          status: "needs-human",
          errorCode: "search-ui-not-found",
          errorMessage: `Could not select separate name search on ${portal.portalId}`,
        },
      };
    }
    filled = await tryFillFirst(browser, [BASTROP_GRANTOR_INPUT], planned.query);
  } else if (planned.kind === "legal-description") {
    filled = await tryFillFirst(browser, [BASTROP_LEGAL_INPUT], planned.query);
  } else {
    filled = await tryFillFirst(browser, [BASTROP_LOT_INPUT], planned.query);
  }

  if (!filled) {
    return {
      ok: false,
      result: {
        status: "needs-human",
        errorCode: "search-ui-not-found",
        errorMessage: `Could not fill ${planned.kind} search on ${portal.portalId}`,
      },
    };
  }

  if (!(await browser.click(BASTROP_SEARCH_BUTTON)).ok) {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCode: "search-submit-failed",
        errorMessage: `${planned.kind} search could not be submitted on ${portal.portalId}`,
      },
    };
  }

  const settled = await assertBastropSearchSettled(browser, planned.kind);
  if (!settled.ok) {
    return settled;
  }

  const pageCapture = await browser.captureFullPage(planned.captureLabel);
  if (!pageCapture.ok || !pageCapture.sha256) {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCode: "capture-failed",
        errorMessage:
          pageCapture.errorMessage ??
          `Failed to capture ${planned.kind} results on ${portal.portalId}`,
      },
    };
  }

  const extracted = await extractIndexHitsFromPage(browser, {
    vendorFamily: vendorFamilyFromPortalId(portal.portalId),
  });
  if (!extracted.ok) {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCode: extracted.errorCode,
        errorMessage: extracted.errorMessage,
      },
    };
  }
  const hits = extracted.hits;

  return {
    ok: true,
    queryRecord: {
      kind: planned.kind,
      query: planned.query,
      timestamp: new Date().toISOString(),
      resultCount: hits.length,
    },
    capture: {
      label: pageCapture.label,
      sha256: pageCapture.sha256,
      byteLength: pageCapture.byteLength,
      timestamp: new Date().toISOString(),
    },
    hits,
  };
}

async function runSingleQuery(
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
  planned: PlannedSearchQuery,
  searchTermsUrl: string,
): Promise<
  | {
      ok: true;
      queryRecord: Record<string, unknown>;
      capture: Record<string, unknown>;
      hits: IndexSearchHit[];
    }
  | { ok: false; result: RecordsRecipeResult }
> {
  if (isBastropSearchEntryPortal(portal)) {
    return runBastropSearchEntryQuery(portal, browser, planned);
  }

  const nav = await browser.goto(searchTermsUrl);
  const navFailure = recipeResultFromNavigation(
    nav,
    `Aumentum search terms unreachable (${searchTermsUrl})`,
  );
  if (navFailure) {
    return { ok: false, result: navFailure };
  }

  let entryOk = false;
  let fillSelectors: readonly string[] = NAME_INPUT_SELECTORS;

  if (planned.kind === "owner-name") {
    entryOk = await tryClickFirst(browser, GRANTOR_ENTRY_SELECTORS);
    fillSelectors = NAME_INPUT_SELECTORS;
  } else if (planned.kind === "legal-description") {
    entryOk = await tryClickFirst(browser, LEGAL_ENTRY_SELECTORS);
    fillSelectors = LEGAL_INPUT_SELECTORS;
  } else {
    entryOk = await tryClickFirst(browser, SUBDIVISION_ENTRY_SELECTORS);
    fillSelectors = SUBDIVISION_INPUT_SELECTORS;
  }

  if (!entryOk) {
    return {
      ok: false,
      result: {
        status: "needs-human",
        errorCode: "search-ui-not-found",
        errorMessage: `Could not open ${planned.kind} search on ${portal.portalId}`,
        scopeSearched: {
          portalId: portal.portalId,
          mode: "index-search",
          missingSearchKind: planned.kind,
        },
      },
    };
  }

  const filled = await tryFillFirst(browser, fillSelectors, planned.query);
  if (!filled) {
    return {
      ok: false,
      result: {
        status: "needs-human",
        errorCode: "search-ui-not-found",
        errorMessage: `Could not fill ${planned.kind} search on ${portal.portalId}`,
      },
    };
  }

  const submitted =
    (await tryClickFirst(browser, SEARCH_SUBMIT_SELECTORS)) ||
    (await browser.pressEnter()).ok;
  if (!submitted) {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCode: "search-submit-failed",
        errorMessage: `${planned.kind} search could not be submitted on ${portal.portalId}`,
      },
    };
  }

  const pageCapture = await browser.captureFullPage(planned.captureLabel);
  if (!pageCapture.ok || !pageCapture.sha256) {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCode: "capture-failed",
        errorMessage:
          pageCapture.errorMessage ??
          `Failed to capture ${planned.kind} results on ${portal.portalId}`,
      },
    };
  }

  const extracted = await extractIndexHitsFromPage(browser, {
    vendorFamily: vendorFamilyFromPortalId(portal.portalId),
  });
  if (!extracted.ok) {
    return {
      ok: false,
      result: {
        status: "failed",
        errorCode: extracted.errorCode,
        errorMessage: extracted.errorMessage,
      },
    };
  }
  const hits = extracted.hits;

  return {
    ok: true,
    queryRecord: {
      kind: planned.kind,
      query: planned.query,
      timestamp: new Date().toISOString(),
      resultCount: hits.length,
    },
    capture: {
      label: pageCapture.label,
      sha256: pageCapture.sha256,
      byteLength: pageCapture.byteLength,
      timestamp: new Date().toISOString(),
    },
    hits,
  };
}

export async function runAumentumIndexSearch(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const purchaseApproved = ctx.requestPayload.purchaseApproved === true;
  const resumeHits =
    purchaseApproved && ctx.scopeSearched
      ? parseIndexHitsFromScope(ctx.scopeSearched)
      : [];

  if (resumeHits.length > 0) {
    const priorScope =
      ctx.scopeSearched && typeof ctx.scopeSearched === "object"
        ? ctx.scopeSearched
        : {};
    const acquisition = await acquireIndexHits({
      jobId: ctx.jobId,
      portalId: portal.portalId,
      hits: resumeHits,
      browser,
      purchaseApproved: true,
    });
    const scopeBase = {
      ...priorScope,
      portalId: portal.portalId,
      countyFips: portal.countyFips,
      acquisitionResume: true,
    };
    if (acquisition.kind === "failed") {
      return {
        status: "failed",
        errorCode: acquisition.errorCode,
        errorMessage: acquisition.errorMessage,
      };
    }
    if (acquisition.kind === "awaiting-purchase") {
      return acquisitionAwaitingPurchaseResult(
        scopeBase,
        acquisition.summary,
        acquisition.reason,
      );
    }
    if (acquisition.kind === "needs-human") {
      return acquisitionNeedsHumanResult(
        scopeBase,
        acquisition.summary,
        acquisition.reason,
      );
    }
    return {
      status: "complete",
      scopeSearched: mergeAcquisitionIntoScope(scopeBase, acquisition.summary),
    };
  }

  const stepsReached: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const captures: Array<Record<string, unknown>> = [];
  let allHits: IndexSearchHit[] = [];

  const opened = await openSearchTermsSurface(portal, browser, stepsReached);
  if (!opened.ok) {
    return opened.result;
  }

  const plan = buildSearchQueryPlan(resolveSearchTerms(ctx));
  if (plan.length === 0) {
    const capture = await browser.captureFullPage("aumentum-no-search-terms");
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
      errorMessage:
        "Job payload lacks owner, legal, or subdivision search terms",
      scopeSearched: aumentumIndexSearchScope(ctx, portal, {
        stepsReached,
        queries,
        captures,
        indexHits: [],
      }),
    };
  }

  const searchTermsUrl = searchTermsUrlForPortal(portal);

  for (const planned of plan) {
    await browser.beforePortalAction?.();
    const result = await runSingleQuery(portal, browser, planned, searchTermsUrl);
    if (!result.ok) {
      if (
        allHits.length > 0 &&
        result.result.errorCode === UNRESOLVED_RESULT_ROW_HEADER
      ) {
        stepsReached.push(`search-${planned.kind}-header-unresolved-skipped`);
        queries.push({
          kind: planned.kind,
          query: planned.query,
          skipped: result.result.errorCode,
          errorMessage: result.result.errorMessage,
        });
        continue;
      }
      return result.result;
    }
    queries.push(result.queryRecord);
    captures.push(result.capture);
    allHits = dedupeIndexHits([...allHits, ...result.hits]);
    stepsReached.push(`search-${planned.kind}`);
  }

  const scope = aumentumIndexSearchScope(ctx, portal, {
    stepsReached,
    queries,
    captures,
    indexHits: allHits,
  });

  if (allHits.length === 0) {
    return { status: "complete", scopeSearched: scope };
  }

  const acquisition = await acquireIndexHits({
    jobId: ctx.jobId,
    portalId: portal.portalId,
    hits: allHits,
    browser,
  });

  if (acquisition.kind === "failed") {
    return {
      status: "failed",
      errorCode: acquisition.errorCode,
      errorMessage: acquisition.errorMessage,
    };
  }
  if (acquisition.kind === "awaiting-purchase") {
    return acquisitionAwaitingPurchaseResult(
      scope,
      acquisition.summary,
      acquisition.reason,
    );
  }
  if (acquisition.kind === "needs-human") {
    return acquisitionNeedsHumanResult(
      scope,
      acquisition.summary,
      acquisition.reason,
    );
  }

  return {
    status: "complete",
    scopeSearched: mergeAcquisitionIntoScope(scope, acquisition.summary),
  };
}
