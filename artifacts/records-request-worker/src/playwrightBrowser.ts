/**
 * Playwright browser adapter for recipe runners.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
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

    async extractResultRows(): Promise<
      import("./recipes/types.js").ResultRowExtract[]
    > {
      return page.evaluate(() => {
        const headerTexts = (nodes: Iterable<Element>): string[] =>
          [...nodes].map((n) => n.textContent?.trim() ?? "");

        const headersForRow = (rowEl: Element): string[] | null => {
          const table = rowEl.closest("table");
          if (table) {
            const thead = table.querySelectorAll(
              "thead th, thead [role=columnheader]",
            );
            if (thead.length > 0) return headerTexts(thead);
            const firstRow = table.querySelector("tr");
            const firstThs = firstRow?.querySelectorAll("th");
            if (firstThs && firstThs.length > 0) return headerTexts(firstThs);
          }
          const grid = rowEl.closest(
            '[role="grid"], [role="table"], .search-results, .results-table',
          );
          if (grid) {
            const cols = grid.querySelectorAll('[role="columnheader"], th');
            if (cols.length > 0) return headerTexts(cols);
          }
          return null;
        };

        const rows: {
          cells: string[];
          link: string | null;
          headers: string[] | null;
        }[] = [];
        const selectors = [
          "table tbody tr",
          ".search-results tr",
          '[role="row"]',
          ".results-table tr",
        ];
        const seen = new Set<Element>();
        for (const sel of selectors) {
          for (const tr of document.querySelectorAll(sel)) {
            if (seen.has(tr)) continue;
            seen.add(tr);
            if (tr.querySelectorAll("th").length > 0 && tr.querySelectorAll("td").length === 0) {
              continue;
            }
            const cells = [...tr.querySelectorAll("td, [role=cell]")].map(
              (c) => c.textContent?.trim() ?? "",
            );
            if (cells.length < 2) continue;
            const anchor = tr.querySelector("a[href]");
            const link = anchor instanceof HTMLAnchorElement ? anchor.href : null;
            rows.push({ cells, link, headers: headersForRow(tr) });
          }
        }
        return rows;
      });
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
