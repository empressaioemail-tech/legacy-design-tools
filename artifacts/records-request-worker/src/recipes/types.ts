/**
 * P-85 item 5 — recipe contracts (browser injected for unit tests).
 */

export interface RecordsRecipeContext {
  jobId: string;
  countyFips: string;
  parcelKey: string;
  portalId: string;
  requestPayload: Record<string, unknown>;
  /** Prior run scope — used for acquisition-only resume after fee approve. */
  scopeSearched?: Record<string, unknown>;
}

export interface PortalNavigationResult {
  ok: boolean;
  status?: number;
  finalUrl?: string;
  errorCode?: string;
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
  /** Column names the portal published. Null when the grid header cannot be read. */
  headers: string[] | null;
}

/** Minimal browser seam — real Playwright adapter in run.ts; mocks in unit tests. */
export interface RecordsRecipeBrowser {
  /** Rate limit seam between search queries (no-op when omitted in mocks). */
  beforePortalAction?(): Promise<void>;
  /**
   * Settle seam — bounded wait for an async post-click effect (e.g. a
   * disclaimer-accept cookie write) to land before the next navigation.
   * Optional so existing mocks are unaffected; no-op when omitted.
   */
  wait?(ms: number): Promise<void>;
  /**
   * Vendor "N Total Results" declaration on the results surface, when the
   * page publishes one (e.g. Tyler self-service's "Showing page X of Y for
   * N Total Results"). Optional; null when absent or unrecognized. Used to
   * catch a silent-zero: the portal reports records exist but the row
   * extractor's markup shape does not recognize this vendor's grid — refuse
   * rather than report a fabricated-looking complete/zero (P-113 hardening,
   * found live on McLennan: 1,706 real results, 0 rows extracted, because
   * that vendor's results panel is a div/listview, not the RadGrid/table
   * shape extractResultRowsSource targets).
   */
  extractTotalResultsHint?(): Promise<number | null>;
  goto(url: string): Promise<PortalNavigationResult>;
  captureFullPage(label: string): Promise<PageCaptureResult>;
  click(selector: string): Promise<BrowserActionResult>;
  fill(selector: string, value: string): Promise<BrowserActionResult>;
  pressEnter(): Promise<BrowserActionResult>;
  pageIncludes(text: string): Promise<boolean>;
  currentUrl(): Promise<string>;
  extractResultRows(): Promise<ResultRowExtract[]>;
  /** Document-surface purchase signals. Never raw page HTML. */
  inspectDocumentPurchase(): Promise<
    import("./documentPurchase.js").DocumentPurchaseSignal
  >;
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
