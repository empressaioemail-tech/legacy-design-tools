/**
 * After a Bastrop SearchEntry submit, the page must publish a search
 * outcome. Capture-then-extract on SearchEntry (34KB "Please enter
 * search criteria") completing as resultCount 0 is the defect this
 * refuses. Two independently derived signals: URL path and the portal's
 * own records-found label.
 */
import type { RecordsRecipeBrowser, RecordsRecipeResult } from "./types.js";

export const SEARCH_RESULTS_UNSETTLED = "search-results-unsettled";
export const SEARCH_FILL_DID_NOT_SUBMIT = "search-fill-did-not-submit";

export type SearchSettleOptions = {
  timeoutMs?: number;
  fillMissAfterMs?: number;
  pollMs?: number;
};

export type SearchSettleOk = { ok: true; outcome: "zero" | "hits" };
export type SearchSettleFail = { ok: false; result: RecordsRecipeResult };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function assertBastropSearchSettled(
  browser: RecordsRecipeBrowser,
  plannedKind: string,
  options: SearchSettleOptions = {},
): Promise<SearchSettleOk | SearchSettleFail> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fillMissAfterMs = options.fillMissAfterMs ?? 4_000;
  const pollMs = options.pollMs ?? 250;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const url = await browser.currentUrl();
    const onResults = /SearchResults\.aspx/i.test(url);
    const pleaseEnter = await browser.pageIncludes(
      "please enter search criteria",
    );
    const zero = await browser.pageIncludes("0 records found");
    const showing = await browser.pageIncludes("showing records");
    const recordsFound = await browser.pageIncludes("records found");

    if (onResults && (zero || showing || recordsFound)) {
      return { ok: true, outcome: zero ? "zero" : "hits" };
    }

    if (
      Date.now() - started >= fillMissAfterMs &&
      !onResults &&
      pleaseEnter &&
      !recordsFound
    ) {
      return {
        ok: false,
        result: {
          status: "failed",
          errorCode: SEARCH_FILL_DID_NOT_SUBMIT,
          errorMessage: `${plannedKind} search stayed on the entry form after submit (lastUrl=${url}). The query did not reach SearchResults. Do not treat this as 0 hits.`,
        },
      };
    }

    await sleep(pollMs);
  }

  const lastUrl = await browser.currentUrl();
  return {
    ok: false,
    result: {
      status: "failed",
      errorCode: SEARCH_RESULTS_UNSETTLED,
      errorMessage: `${plannedKind} search did not publish a records-found signal (lastUrl=${lastUrl}). Capture size is not a hit count.`,
    },
  };
}
