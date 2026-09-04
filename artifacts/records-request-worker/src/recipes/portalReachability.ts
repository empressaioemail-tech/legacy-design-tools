/**
 * Generic P-85 reachability recipe — opens the portal entry surface only.
 * Login, search, and document purchase are follow-on cards.
 */

import type { P85PortalConfig } from "./p85Portals.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";

export interface PortalReachabilityStep {
  id: string;
  label: string;
  url: string;
}

export function portalReachabilitySteps(
  portal: P85PortalConfig,
): readonly PortalReachabilityStep[] {
  return [
    {
      id: "open-entry",
      label: `Open ${portal.portalId} entry surface`,
      url: portal.entryUrl,
    },
  ];
}

export function portalReachabilityCompleteScope(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  reachedStepIds: string[],
): Record<string, unknown> {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    parcelKey: ctx.parcelKey,
    recipeVersion: portal.recipeVersion,
    mode: "scaffold",
    stepsReached: reachedStepIds,
    loginAttempted: false,
    note:
      "Portal reachability scaffold only — entry surface opened; index search not executed",
  };
}

export function portalUnreachableResult(
  step: PortalReachabilityStep,
  nav: {
    ok: boolean;
    status?: number;
    errorCode?: string;
    errorMessage?: string;
  },
): RecordsRecipeResult {
  const detail =
    nav.errorMessage ??
    (nav.status != null ? `HTTP ${nav.status}` : "navigation failed");
  return {
    status: "failed",
    errorCode: nav.errorCode ?? "portal-unreachable",
    errorMessage: `Portal unreachable at step ${step.id} (${step.url}): ${detail}`,
  };
}

export async function runPortalReachabilityRecipe(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const steps = portalReachabilitySteps(portal);
  const reached: string[] = [];

  for (const step of steps) {
    const nav = await browser.goto(step.url);
    if (!nav.ok) {
      return portalUnreachableResult(step, nav);
    }
    reached.push(step.id);
  }

  if (reached.length === 0) {
    return {
      status: "failed",
      errorCode: "portal-unreachable",
      errorMessage: `No reachability steps completed for portalId=${portal.portalId}`,
    };
  }

  return {
    status: "complete",
    scopeSearched: portalReachabilityCompleteScope(ctx, portal, reached),
  };
}
