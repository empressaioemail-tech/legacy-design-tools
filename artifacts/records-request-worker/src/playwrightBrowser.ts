/**
 * Playwright browser adapter for recipe runners.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { applyInfragisticsValueSource } from "./applyInfragisticsValueSource.js";
import { EXTRACT_RESULT_ROWS_SOURCE } from "./extractResultRowsSource.js";
import { INSPECT_DOCUMENT_PURCHASE_SOURCE } from "./inspectDocumentPurchaseSource.js";
import { sha256Hex } from "./lib/captureHash.js";
import {
  isPortalAccessBlockedStatus,
  isWafOrRateLimitPageContent,
  PORTAL_ACCESS_BLOCKED_CODE,
} from "./portalAccessBlocked.js";
import type { DocumentPurchaseSignal } from "./recipes/documentPurchase.js";
import type {
  BrowserActionResult,
  PageCaptureResult,
  PortalNavigationResult,
  RecordsRecipeBrowser,
  ResultRowExtract,
} from "./recipes/types.js";
import {
  createPortalActionThrottle,
  type PortalActionThrottle,
} from "./throttle.js";

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

export const RECORDS_REQUEST_WORKER_USER_AGENT =
  "RecordsRequestWorker/1.0 (Smart Site; +https://smartsite.cloud/records-request)";

function actionError(err: unknown): BrowserActionResult {
  return {
    ok: false,
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}

async function detectPortalAccessBlock(
  page: Page,
  status: number | undefined,
): Promise<PortalNavigationResult | null> {
  if (status !== undefined && isPortalAccessBlockedStatus(status)) {
    return {
      ok: false,
      status,
      finalUrl: page.url(),
      errorCode: PORTAL_ACCESS_BLOCKED_CODE,
      errorMessage: `HTTP ${status}`,
    };
  }
  try {
    const content = await page.content();
    if (isWafOrRateLimitPageContent(content)) {
      return {
        ok: false,
        status,
        finalUrl: page.url(),
        errorCode: PORTAL_ACCESS_BLOCKED_CODE,
        errorMessage: "portal presented WAF or rate-limit challenge",
      };
    }
  } catch {
    // Content read failure is not a block signal.
  }
  return null;
}

export function createPlaywrightBrowser(
  page: Page,
  options?: { throttle?: PortalActionThrottle },
): RecordsRecipeBrowser {
  const throttle = options?.throttle ?? createPortalActionThrottle();

  return {
    async beforePortalAction(): Promise<void> {
      await throttle.beforeAction();
    },

    async wait(ms: number): Promise<void> {
      await page.waitForTimeout(ms);
    },

    async extractTotalResultsHint(): Promise<number | null> {
      try {
        const text = await page.evaluate(() => document.body?.innerText ?? "");
        const match = text.match(/([\d,]+)\s+Total\s+Results/i);
        if (!match) return null;
        const n = Number(match[1].replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },

    async goto(url: string): Promise<PortalNavigationResult> {
      await throttle.beforeAction();
      try {
        const response = await page.goto(url, {
          timeout: NAV_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        if (!response) {
          return {
            ok: false,
            errorMessage: "navigation returned no response",
          };
        }
        const status = response.status();
        const blocked = await detectPortalAccessBlock(page, status);
        if (blocked) {
          return blocked;
        }
        const ok = response.ok() || (status >= 300 && status < 400);
        return {
          ok,
          status,
          finalUrl: page.url(),
          errorMessage: ok ? undefined : `HTTP ${status}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("ERR_ABORTED") &&
          page.url() &&
          page.url() !== "about:blank"
        ) {
          const blocked = await detectPortalAccessBlock(page, undefined);
          if (blocked) {
            return blocked;
          }
          return { ok: true, finalUrl: page.url() };
        }
        return {
          ok: false,
          errorMessage: message,
        };
      }
    },

    async captureFullPage(label: string): Promise<PageCaptureResult> {
      try {
        const buffer = await page.screenshot({ fullPage: true, type: "png" });
        return {
          ok: true,
          sha256: sha256Hex(buffer),
          byteLength: buffer.byteLength,
          label,
          pngBase64: buffer.toString("base64"),
        };
      } catch (err) {
        return {
          ok: false,
          label,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async click(selector: string): Promise<BrowserActionResult> {
      try {
        await page.click(selector, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true };
      } catch (err) {
        return actionError(err);
      }
    },

    async fill(selector: string, value: string): Promise<BrowserActionResult> {
      try {
        await page.fill(selector, value, { timeout: ACTION_TIMEOUT_MS });
        const applied = (await page.evaluate(
          applyInfragisticsValueSource(selector, value),
        )) as { ok?: boolean; read?: string | null };
        if (!applied?.ok) {
          return {
            ok: false,
            errorMessage: `fill did not stick on ${selector}: read=${applied?.read ?? "null"}`,
          };
        }
        return { ok: true };
      } catch (err) {
        return actionError(err);
      }
    },

    async pressEnter(): Promise<BrowserActionResult> {
      try {
        await page.keyboard.press("Enter");
        return { ok: true };
      } catch (err) {
        return actionError(err);
      }
    },

    /**
     * Raw HTML substring. Must not be used to decide document purchase.
     * Use inspectDocumentPurchase for that.
     */
    async pageIncludes(text: string): Promise<boolean> {
      try {
        const content = await page.content();
        return content.toLowerCase().includes(text.toLowerCase());
      } catch {
        return false;
      }
    },

    async currentUrl(): Promise<string> {
      return page.url();
    },

    async extractResultRows(): Promise<ResultRowExtract[]> {
      return page.evaluate(EXTRACT_RESULT_ROWS_SOURCE) as Promise<
        ResultRowExtract[]
      >;
    },

    async inspectDocumentPurchase(): Promise<DocumentPurchaseSignal> {
      return page.evaluate(INSPECT_DOCUMENT_PURCHASE_SOURCE) as Promise<
        DocumentPurchaseSignal
      >;
    },
  };
}

export async function createChromeBrowserContext(
  browser: Browser,
): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: RECORDS_REQUEST_WORKER_USER_AGENT,
    locale: "en-US",
    viewport: { width: 1920, height: 1080 },
  });
}

export async function withPlaywrightBrowser<T>(
  fn: (browser: RecordsRecipeBrowser) => Promise<T>,
  options?: { throttle?: PortalActionThrottle },
): Promise<T> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await createChromeBrowserContext(browser);
    const page = await context.newPage();
    const adapter = createPlaywrightBrowser(page, options);
    return await fn(adapter);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
