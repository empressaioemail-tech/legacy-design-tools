/**
 * Playwright browser adapter for recipe runners.
 */

import { chromium, type Browser } from "playwright";
import type { PortalNavigationResult, RecordsRecipeBrowser } from "./recipes/types.js";

const NAV_TIMEOUT_MS = 30_000;

export function createPlaywrightBrowser(page: {
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" | "networkidle" },
  ): Promise<{ ok(): boolean; status(): number; url(): string } | null>;
}): RecordsRecipeBrowser {
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
