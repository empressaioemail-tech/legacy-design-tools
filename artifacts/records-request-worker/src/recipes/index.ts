/**
 * P-85 item 5 — recipe registry and portal resolution.
 */

import {
  P85_DEFAULT_PORTAL_BY_COUNTY,
  P85_PORTALS,
  portalConfigById,
  type P85PortalConfig,
} from "./p85Portals.js";
import { runPortalReachabilityRecipe } from "./portalReachability.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeDefinition,
  RecordsRecipeResult,
} from "./types.js";

function recipeForPortalConfig(
  portal: P85PortalConfig,
): RecordsRecipeDefinition {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    recipeVersion: portal.recipeVersion,
    run: (ctx, browser) =>
      runPortalReachabilityRecipe(ctx, portal, browser),
  };
}

const REGISTRY: readonly RecordsRecipeDefinition[] = P85_PORTALS.map(
  recipeForPortalConfig,
);

export function listRegisteredRecipes(): readonly RecordsRecipeDefinition[] {
  return REGISTRY;
}

export function recipeForPortal(portalId: string): RecordsRecipeDefinition | undefined {
  return REGISTRY.find((r) => r.portalId === portalId);
}

/**
 * Resolve portal id from job payload or county default.
 * All six P-85 counties have a default portal; explicit portalId wins.
 */
export function resolvePortalIdForJob(
  countyFips: string,
  requestPayload: Record<string, unknown> | null,
): string | null {
  const fromPayload = requestPayload?.portalId;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload.trim();
  }
  return P85_DEFAULT_PORTAL_BY_COUNTY[countyFips] ?? null;
}

export async function runRecipeForJob(
  ctx: RecordsRecipeContext,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const portal = portalConfigById(ctx.portalId);
  const recipe = recipeForPortal(ctx.portalId);
  if (!portal || !recipe) {
    return {
      status: "failed",
      errorCode: "recipe-not-registered",
      errorMessage: `No records recipe registered for portalId=${ctx.portalId}`,
    };
  }
  if (recipe.countyFips !== ctx.countyFips) {
    return {
      status: "failed",
      errorCode: "recipe-county-mismatch",
      errorMessage: `Portal ${ctx.portalId} is not registered for countyFips=${ctx.countyFips}`,
    };
  }
  return recipe.run(ctx, browser);
}

export type { RecordsRecipeContext, RecordsRecipeResult, RecordsRecipeBrowser };
