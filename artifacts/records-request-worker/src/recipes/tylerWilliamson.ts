/**
 * P-85 item 5 — TylerHost stub recipe for Williamson County (48491).
 *
 * Scaffold only: navigates to the public disclaimer/login surfaces with no
 * credentials. Real portal automation lands in a follow-on card.
 */

import type {
  PortalNavigationResult,
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeResult,
} from "./types.js";

export const WILLIAMSON_TYLERHOST_PORTAL_ID = "williamson-tylerhost";

export const WILLIAMSON_TYLERHOST_PORTAL = {
  portalId: WILLIAMSON_TYLERHOST_PORTAL_ID,
  countyFips: "48491",
  portalUrl: "https://williamsoncountytx-web.tylerhost.net/web/",
  disclaimerUrl:
    "https://williamsoncountytx-web.tylerhost.net/web/user/disclaimer",
  /** Placeholder — login flow is not implemented in this scaffold. */
  loginUrl: "https://williamsoncountytx-web.tylerhost.net/web/user/login",
} as const;

export const TYLER_WILLIAMSON_RECIPE_VERSION =
  "p85-tyler-williamson-scaffold-v0";

export interface TylerWilliamsonStep {
  id: string;
  label: string;
  url: string;
  kind: "disclaimer" | "login-placeholder" | "search-placeholder";
}

/** Ordered scaffold steps — login/search are placeholders only. */
export function tylerWilliamsonRecipeSteps(): readonly TylerWilliamsonStep[] {
  return [
    {
      id: "open-disclaimer",
      label: "Open TylerHost disclaimer",
      url: WILLIAMSON_TYLERHOST_PORTAL.disclaimerUrl,
      kind: "disclaimer",
    },
    {
      id: "login-placeholder",
      label: "Login (placeholder — no credentials in scaffold)",
      url: WILLIAMSON_TYLERHOST_PORTAL.loginUrl,
      kind: "login-placeholder",
    },
    {
      id: "search-placeholder",
      label: "Parcel search (placeholder — not implemented)",
      url: WILLIAMSON_TYLERHOST_PORTAL.portalUrl,
      kind: "search-placeholder",
    },
  ];
}

export function portalUnreachableResult(
  step: TylerWilliamsonStep,
  nav: PortalNavigationResult,
): RecordsRecipeResult {
  const detail =
    nav.errorMessage ??
    (nav.status != null ? `HTTP ${nav.status}` : "navigation failed");
  return {
    status: "failed",
    errorCode: "portal-unreachable",
    errorMessage: `Portal unreachable at step ${step.id} (${step.url}): ${detail}`,
  };
}

export function tylerWilliamsonScaffoldCompleteScope(
  ctx: RecordsRecipeContext,
  reachedStepIds: string[],
): Record<string, unknown> {
  return {
    portalId: WILLIAMSON_TYLERHOST_PORTAL.portalId,
    countyFips: WILLIAMSON_TYLERHOST_PORTAL.countyFips,
    parcelKey: ctx.parcelKey,
    recipeVersion: TYLER_WILLIAMSON_RECIPE_VERSION,
    mode: "scaffold",
    stepsReached: reachedStepIds,
    loginAttempted: false,
    note:
      "TylerHost automation scaffold only — disclaimer reachable; login/search not executed",
  };
}

/**
 * Run the Williamson TylerHost stub recipe.
 * Fails closed when the portal surface is unreachable.
 */
export async function runTylerWilliamsonRecipe(
  ctx: RecordsRecipeContext,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const steps = tylerWilliamsonRecipeSteps();
  const reached: string[] = [];

  for (const step of steps) {
    if (step.kind === "login-placeholder" || step.kind === "search-placeholder") {
      // Scaffold stops after disclaimer reachability; later steps are declared only.
      break;
    }

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
      errorMessage: "No TylerHost scaffold steps completed",
    };
  }

  return {
    status: "complete",
    scopeSearched: tylerWilliamsonScaffoldCompleteScope(ctx, reached),
  };
}
