import type {
  PortalNavigationResult,
  RecordsRecipeResult,
} from "./recipes/types.js";

/**
 * Map a failed portal navigation to a terminal recipe result.
 * Preserves portal-access-blocked from the browser adapter.
 */
export function recipeResultFromNavigation(
  nav: PortalNavigationResult,
  context: string,
  scopeSearched?: Record<string, unknown>,
): RecordsRecipeResult | null {
  if (nav.ok) {
    return null;
  }
  return {
    status: "failed",
    errorCode: nav.errorCode ?? "portal-unreachable",
    errorMessage: `${context}: ${nav.errorMessage ?? "navigation failed"}`,
    scopeSearched,
  };
}
