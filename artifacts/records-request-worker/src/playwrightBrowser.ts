/**
 * Playwright browser adapter for recipe runners.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { EXTRACT_RESULT_ROWS_SOURCE } from "./extractResultRowsSource.js";
import { INSPECT_DOCUMENT_PURCHASE_SOURCE } from "./inspectDocumentPurchaseSource.js";
import { sha256Hex } from "./lib/captureHash.js";
import type { DocumentPurchaseSignal } from "./recipes/documentPurchase.js";
import type {
  BrowserActionResult,
  PageCaptureResult,
  PortalNavigationResult,
  RecordsRecipeBrowser,
  ResultRowExtract,
} from "./recipes/types.js";

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

function actionError(err: unknown): BrowserActionResult {
  return {
    ok: false,
    errorMessage: err instanceof Error ? err.message : String(err),
  };
}

export function createPlaywrightBrowser(page: Page): RecordsRecipeBrowser {
  return {
    async goto(url: string): Promise<PortalNavigationResult> {
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
        const ok = response.ok() || (status >= 300 && status < 400);
        return {
          ok,
          status,
          finalUrl: page.url(),
          errorMessage: ok ? undefined : `HTTP ${status}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("ERR_ABORTED") && page.url() && page.url() !== "about:blank") {
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

/** Major version aligned with Playwright's bundled Chromium (see playwrightBrowser.test.ts). */
const CHROME_MAJOR = "147";

export const CHROME_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

/** Client hint headers that match CHROME_USER_AGENT for WAF-sensitive portals (e.g. Travis tccsearch). */
export const CHROME_CLIENT_HINTS_HEADERS: Readonly<Record<string, string>> = {
  "sec-ch-ua": `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
};

export async function createChromeBrowserContext(
  browser: Browser,
): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: CHROME_USER_AGENT,
    extraHTTPHeaders: { ...CHROME_CLIENT_HINTS_HEADERS },
    locale: "en-US",
    viewport: { width: 1920, height: 1080 },
  });
}

export async function withPlaywrightBrowser<T>(
  fn: (browser: RecordsRecipeBrowser) => Promise<T>,
): Promise<T> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await createChromeBrowserContext(browser);
    const page = await context.newPage();
    const adapter = createPlaywrightBrowser(page);
    return await fn(adapter);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
