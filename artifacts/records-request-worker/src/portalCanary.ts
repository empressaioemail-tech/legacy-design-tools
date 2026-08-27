/**
 * P-85 WDLL item 14 — daily portal canary runner (selector drift detection).
 */

import { checkRecipeCanarySelectors } from "./recipes/recipeCanarySelectors.js";
import {
  markPortalCanaryResult,
  type PortalCanaryRow,
} from "./portalCanaryStore.js";
import type { RecordsRecipeBrowser } from "./recipes/types.js";
import { P85_PORTALS } from "./recipes/p85Portals.js";

export type RunPortalCanaryOptions = {
  portalIds?: readonly string[];
  browserFactory: (
    fn: (browser: RecordsRecipeBrowser) => Promise<unknown>,
  ) => Promise<unknown>;
  /** Test seam — inject broken selectors for one portal. */
  brokenSelectorPortalId?: string;
  /** When false, skip DB writes (unit tests). */
  persist?: boolean;
};

export type PortalCanaryRunOutcome = {
  portalId: string;
  ok: boolean;
  recipeVersion: string;
  reason?: string;
};

export async function runPortalCanaryForPortal(
  portalId: string,
  browser: RecordsRecipeBrowser,
  options?: { driftSelectors?: readonly string[]; persist?: boolean },
): Promise<PortalCanaryRunOutcome> {
  const check = await checkRecipeCanarySelectors(portalId, browser, {
    driftSelectors: options?.driftSelectors,
  });

  const outcome: PortalCanaryRunOutcome = {
    portalId,
    ok: check.ok,
    recipeVersion: check.recipeVersion,
    reason: check.ok ? undefined : check.reason,
  };

  if (options?.persist !== false) {
    await markPortalCanaryResult({
      portalId,
      ok: check.ok,
      recipeVersion: check.recipeVersion,
      reason: check.ok ? undefined : check.reason,
    });
  }

  return outcome;
}

/**
 * Run canary selector checks for all (or selected) P-85 portals and persist status.
 * Intended for daily Cloud Scheduler / cron invocation via scripts/p85/run-records-portal-canary.mjs.
 */
export async function runDailyPortalCanary(
  options: RunPortalCanaryOptions,
): Promise<PortalCanaryRunOutcome[]> {
  const portalIds =
    options.portalIds ??
    P85_PORTALS.map((p) => p.portalId);

  const outcomes: PortalCanaryRunOutcome[] = [];

  for (const portalId of portalIds) {
    const outcome = (await options.browserFactory(async (browser) =>
      runPortalCanaryForPortal(portalId, browser, {
        persist: options.persist,
        driftSelectors:
          options.brokenSelectorPortalId === portalId
            ? ["#p85-canary-deliberately-broken-selector-never-exists"]
            : undefined,
      }),
    )) as PortalCanaryRunOutcome;
    outcomes.push(outcome);
  }

  return outcomes;
}

/** Human-readable block reason when canary marks portal lookup-failed. */
export function portalCanaryBlockMessage(row: PortalCanaryRow): string {
  const checked = row.canaryCheckedAt?.toISOString() ?? "unknown";
  const reason = row.canaryFailureReason ?? "canary selector drift";
  return `Portal ${row.portalId} canary lookup-failed (recipe=${row.canaryRecipeVersion ?? "unknown"}, checked=${checked}): ${reason}`;
}
