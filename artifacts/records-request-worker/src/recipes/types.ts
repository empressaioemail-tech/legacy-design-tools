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

export interface PageCaptureResult {
  ok: boolean;
  sha256?: string;
  byteLength?: number;
  label?: string;
  pngBase64?: string;
  errorMessage?: string;
}

export interface BrowserActionResult {
  ok: boolean;
  errorMessage?: string;
}

export interface ResultRowExtract {
  cells: string[];
  link: string | null;
}

/** Minimal browser seam — real Playwright adapter in run.ts; mocks in unit tests. */
export interface RecordsRecipeBrowser {
  goto(url: string): Promise<PortalNavigationResult>;
  captureFullPage(label: string): Promise<PageCaptureResult>;
  click(selector: string): Promise<BrowserActionResult>;
  fill(selector: string, value: string): Promise<BrowserActionResult>;
  pressEnter(): Promise<BrowserActionResult>;
  pageIncludes(text: string): Promise<boolean>;
  currentUrl(): Promise<string>;
  extractResultRows(): Promise<ResultRowExtract[]>;
}

export interface RecordsRecipeResult {
  status: "complete" | "failed" | "needs-human";
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
