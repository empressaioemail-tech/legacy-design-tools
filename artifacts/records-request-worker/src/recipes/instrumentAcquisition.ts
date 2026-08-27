/**
 * P-85 WDLL item 6 — acquire indexed instruments (capture-first scaffold).
 *
 * Purchase path pauses at awaiting-purchase-approval when projected cost exceeds
 * threshold; human-required routes to needs-human with the instrument list.
 */

import {
  insertRecordsRequestArtifact,
  type NewArtifactRow,
} from "../artifactStore.js";
import type { IndexSearchHit } from "./indexHits.js";
import type { RecordsRecipeBrowser, RecordsRecipeResult } from "./types.js";

/** Product constant — runs pause and ask before buying above this (cents). */
export const PURCHASE_THRESHOLD_CENTS = 5_000;

export type AcquisitionSummary = {
  acquired: number;
  methods: Record<string, number>;
  purchaseCostCents: number;
  pendingHuman: IndexSearchHit[];
  pendingPurchase: IndexSearchHit[];
};

export async function acquireIndexHits(
  input: {
    jobId: string;
    portalId: string;
    hits: IndexSearchHit[];
    browser: RecordsRecipeBrowser;
    purchaseApproved?: boolean;
  },
): Promise<
  | { kind: "acquired"; summary: AcquisitionSummary }
  | { kind: "needs-human"; summary: AcquisitionSummary; reason: string }
  | { kind: "awaiting-purchase"; summary: AcquisitionSummary; reason: string }
  | { kind: "failed"; errorCode: string; errorMessage: string }
> {
  const summary: AcquisitionSummary = {
    acquired: 0,
    methods: {},
    purchaseCostCents: 0,
    pendingHuman: [],
    pendingPurchase: [],
  };

  for (const hit of input.hits) {
    if (!hit.detailUrl) {
      summary.pendingHuman.push(hit);
      continue;
    }

    const nav = await input.browser.goto(hit.detailUrl);
    if (!nav.ok) {
      summary.pendingHuman.push(hit);
      continue;
    }

    const purchaseRequired =
      (await input.browser.pageIncludes("purchase")) ||
      (await input.browser.pageIncludes("add to cart")) ||
      (await input.browser.pageIncludes("pay"));

    if (purchaseRequired) {
      if (input.purchaseApproved) {
        summary.pendingHuman.push(hit);
        continue;
      }
      summary.pendingPurchase.push(hit);
      summary.purchaseCostCents += 350; // per-page placeholder until portal price parse lands
      continue;
    }

    const capture = await input.browser.captureFullPage(
      `instrument-${hit.recordingRef ?? summary.acquired}`,
    );
    if (!capture.ok || !capture.sha256) {
      summary.pendingHuman.push(hit);
      continue;
    }

    const row: NewArtifactRow = {
      jobId: input.jobId,
      portalId: input.portalId,
      recordingRef: hit.recordingRef,
      documentType: hit.documentType,
      recordingDate: hit.recordingDate,
      parties: hit.parties,
      acquisitionMethod: "capture",
      contentSha256: capture.sha256,
      byteSize: capture.byteLength ?? null,
      detailUrl: hit.detailUrl,
      metadata: {
        captureLabel: capture.label,
        captureMimeType: "image/png",
        ...(capture.pngBase64 ? { capturePngBase64: capture.pngBase64 } : {}),
      },
    };
    await insertRecordsRequestArtifact(row);

    summary.acquired += 1;
    summary.methods.capture = (summary.methods.capture ?? 0) + 1;
  }

  if (summary.pendingPurchase.length > 0) {
    if (summary.purchaseCostCents > PURCHASE_THRESHOLD_CENTS) {
      return {
        kind: "awaiting-purchase",
        summary,
        reason: `Projected purchase cost ${summary.purchaseCostCents}c exceeds threshold ${PURCHASE_THRESHOLD_CENTS}c`,
      };
    }
    return {
      kind: "needs-human",
      summary,
      reason:
        "Portal purchase path detected; bot does not drive checkout on this card",
    };
  }

  if (
    input.purchaseApproved &&
    summary.pendingHuman.length > 0 &&
    summary.acquired === 0
  ) {
    return {
      kind: "needs-human",
      summary,
      reason: `User approved county fees; human clerk purchase required for ${summary.pendingHuman.length} instrument(s)`,
    };
  }

  if (summary.acquired === 0 && summary.pendingHuman.length > 0) {
    return {
      kind: "needs-human",
      summary,
      reason: "No instruments captured; human clerk required for remainder",
    };
  }

  return { kind: "acquired", summary };
}

export function mergeAcquisitionIntoScope(
  scope: Record<string, unknown>,
  summary: AcquisitionSummary,
): Record<string, unknown> {
  return {
    ...scope,
    instrumentCount: summary.acquired,
    acquisition: {
      acquired: summary.acquired,
      methods: summary.methods,
      purchaseCostCents: summary.purchaseCostCents,
      pendingHumanCount: summary.pendingHuman.length,
      pendingPurchaseCount: summary.pendingPurchase.length,
    },
  };
}

export function acquisitionNeedsHumanResult(
  scope: Record<string, unknown>,
  summary: AcquisitionSummary,
  reason: string,
): RecordsRecipeResult {
  return {
    status: "needs-human",
    scopeSearched: mergeAcquisitionIntoScope(scope, summary),
    errorCode: "acquisition-needs-human",
    errorMessage: reason,
  };
}

export function acquisitionAwaitingPurchaseResult(
  scope: Record<string, unknown>,
  summary: AcquisitionSummary,
  reason: string,
): RecordsRecipeResult {
  return {
    status: "needs-human",
    scopeSearched: {
      ...mergeAcquisitionIntoScope(scope, summary),
      awaitingPurchaseApproval: true,
      projectedPurchaseCostCents: summary.purchaseCostCents,
    },
    errorCode: "awaiting-purchase-approval",
    errorMessage: reason,
  };
}
