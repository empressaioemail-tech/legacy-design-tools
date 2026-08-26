/**
 * P-85 item 5 — recipe registry and portal resolution.
 */

import {
  runTylerWilliamsonRecipe,
  TYLER_WILLIAMSON_RECIPE_VERSION,
  WILLIAMSON_TYLERHOST_PORTAL,
  WILLIAMSON_TYLERHOST_PORTAL_ID,
} from "./tylerWilliamson.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeDefinition,
  RecordsRecipeResult,
} from "./types.js";

const REGISTRY: readonly RecordsRecipeDefinition[] = [
  {
    portalId: WILLIAMSON_TYLERHOST_PORTAL_ID,
    countyFips: WILLIAMSON_TYLERHOST_PORTAL.countyFips,
    recipeVersion: TYLER_WILLIAMSON_RECIPE_VERSION,
    run: runTylerWilliamsonRecipe,
  },
];

export function listRegisteredRecipes(): readonly RecordsRecipeDefinition[] {
  return REGISTRY;
}

export function recipeForPortal(portalId: string): RecordsRecipeDefinition | undefined {
  return REGISTRY.find((r) => r.portalId === portalId);
}

/**
 * Resolve portal id from job payload or county default.
 * Williamson defaults to TylerHost; other P-85 counties refuse until recipes ship.
 */
export function resolvePortalIdForJob(
  countyFips: string,
  requestPayload: Record<string, unknown> | null,
): string | null {
  const fromPayload = requestPayload?.portalId;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload.trim();
  }
  if (countyFips === WILLIAMSON_TYLERHOST_PORTAL.countyFips) {
    return WILLIAMSON_TYLERHOST_PORTAL_ID;
  }
  return null;
}

export async function runRecipeForJob(
  ctx: RecordsRecipeContext,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  const recipe = recipeForPortal(ctx.portalId);
  if (!recipe) {
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
