/**
 * P-85 item 5 — recipe contracts (browser injected for unit tests).
 */

export interface RecordsRecipeContext {
  jobId: string;
  countyFips: string;
  parcelKey: string;
  portalId: string;
  requestPayload: Record<string, unknown>;
}

export interface PortalNavigationResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  errorMessage?: string;
}

/** Minimal browser seam — real Playwright adapter in run.ts; mocks in unit tests. */
export interface RecordsRecipeBrowser {
  goto(url: string): Promise<PortalNavigationResult>;
}

export interface RecordsRecipeResult {
  status: "complete" | "failed";
  scopeSearched?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export type RecordsRecipeRunner = (
  ctx: RecordsRecipeContext,
  browser: RecordsRecipeBrowser,
) => Promise<RecordsRecipeResult>;

export interface RecordsRecipeDefinition {
  portalId: string;
  countyFips: string;
  recipeVersion: string;
  run: RecordsRecipeRunner;
}
