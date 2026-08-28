/**
 * P-85 items 5+6 — post-search hit extraction and instrument acquisition.
 */

import {
  extractIndexHitsFromPage,
  vendorFamilyFromPortalId,
} from "./indexHits.js";
import {
  acquireIndexHits,
  acquisitionAwaitingPurchaseResult,
  acquisitionNeedsHumanResult,
  mergeAcquisitionIntoScope,
} from "./instrumentAcquisition.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";

export async function finalizeIndexSearchWithAcquisition(input: {
  ctx: RecordsRecipeContext;
  portalId: string;
  browser: RecordsRecipeBrowser;
  scope: Record<string, unknown>;
  resultCount: number | null;
}): Promise<RecordsRecipeResult> {
  const extracted = await extractIndexHitsFromPage(input.browser, {
    vendorFamily: vendorFamilyFromPortalId(input.portalId),
  });
  if (!extracted.ok) {
    return {
      status: "failed",
      errorCode: extracted.errorCode,
      errorMessage: extracted.errorMessage,
    };
  }
  const hits = extracted.hits;

  const scopeWithHits = {
    ...input.scope,
    resultCount: hits.length > 0 ? hits.length : input.resultCount,
    indexHits: hits.map((h) => ({
      recordingRef: h.recordingRef,
      documentType: h.documentType,
      recordingDate: h.recordingDate,
    })),
  };

  if (hits.length === 0) {
    return {
      status: "complete",
      scopeSearched: scopeWithHits,
    };
  }

  const acquisition = await acquireIndexHits({
    jobId: input.ctx.jobId,
    portalId: input.portalId,
    hits,
    browser: input.browser,
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
      scopeWithHits,
      acquisition.summary,
      acquisition.reason,
    );
  }

  if (acquisition.kind === "needs-human") {
    return acquisitionNeedsHumanResult(
      scopeWithHits,
      acquisition.summary,
      acquisition.reason,
    );
  }

  return {
    status: "complete",
    scopeSearched: mergeAcquisitionIntoScope(scopeWithHits, acquisition.summary),
  };
}
