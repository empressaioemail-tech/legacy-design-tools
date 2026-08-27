/**
 * Playwright browser adapter for recipe runners.
 */

import { chromium, type Browser, type Page } from "playwright";
import { sha256Hex } from "./lib/captureHash.js";
import type {
  BrowserActionResult,
  PageCaptureResult,
  PortalNavigationResult,
  RecordsRecipeBrowser,
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
          finalUrl: response.url(),
          errorMessage: ok ? undefined : `HTTP ${status}`,
        };
      } catch (err) {
        return {
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
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
  };
}

export async function withPlaywrightBrowser<T>(
  fn: (browser: RecordsRecipeBrowser) => Promise<T>,
): Promise<T> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const adapter = createPlaywrightBrowser(page);
    return await fn(adapter);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
