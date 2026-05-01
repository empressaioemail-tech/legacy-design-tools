/**
 * DA-PI-6 — Stakeholder Briefing PDF generator (Puppeteer-backed).
 *
 * Thin adapter that takes the typed renderer input, materialises it to
 * HTML via {@link ./briefingHtml}, and prints the result to PDF using
 * a singleton headless Chromium instance. Synchronous-by-contract from
 * the caller's perspective: the route awaits the returned Promise and
 * streams the buffer back in one response.
 *
 * Why Puppeteer here:
 *   The brief locks browser-based rendering for parity with the
 *   in-app viewer (CSS layout, web fonts, embedded `<img>` tags for
 *   the static OSM map and architect-uploaded source previews). The
 *   pure-Node alternative we briefly shipped (pdfkit) could not embed
 *   raster captures or honour CSS `@page` margin boxes, so the
 *   site-map and thumbnail pages had to be placeholders. With
 *   Puppeteer they are real captures.
 *
 * Browser lifecycle:
 *   `puppeteer.launch()` is expensive (~1-2 s cold start). We
 *   memoise a single `Browser` for the process lifetime; subsequent
 *   exports reuse it and only pay the cost of opening / closing one
 *   `Page`. The instance is torn down via {@link closeBrowserForTests}
 *   from the test harness so vitest can exit cleanly.
 */

import puppeteer, { type Browser } from "puppeteer";
import {
  renderBriefingHtml,
  DEFAULT_BRIEFING_PDF_HEADER,
  type RenderBriefingHtmlInput,
  type PdfBriefingNarrative,
  type PdfBriefingSource,
  type PdfEngagement,
} from "./briefingHtml";

export {
  DEFAULT_BRIEFING_PDF_HEADER,
  renderBriefingHtml,
  plainTextCitations,
  classifyAppendixTier,
  freshnessVerdict,
  FOOTER_WATERMARK,
} from "./briefingHtml";
export type {
  RenderBriefingHtmlInput,
  PdfEngagement,
  PdfBriefingNarrative,
  PdfBriefingSource,
} from "./briefingHtml";

export type RenderBriefingPdfInput = RenderBriefingHtmlInput;

/**
 * Singleton headless browser. Lazy-initialised on the first export so
 * processes that never serve `/export.pdf` (e.g. one-shot scripts that
 * import other route handlers) never spawn Chromium.
 */
let browserSingleton: Browser | null = null;
let browserStarting: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserSingleton && browserSingleton.connected) {
    return browserSingleton;
  }
  if (browserStarting) return browserStarting;
  browserStarting = puppeteer
    .launch({
      headless: true,
      // `--no-sandbox` is required inside Replit's Linux container;
      // the platform already isolates each Repl, so the in-process
      // sandbox is redundant and would refuse to start.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    })
    .then((b) => {
      browserSingleton = b;
      browserStarting = null;
      return b;
    })
    .catch((err) => {
      browserStarting = null;
      throw err;
    });
  return browserStarting;
}

/**
 * Tear the singleton browser down. Exposed so the test harness's
 * top-level `afterAll` can hand control back to vitest cleanly without
 * leaving a Chromium child hanging around.
 */
export async function closeBrowserForTests(): Promise<void> {
  if (browserSingleton) {
    const b = browserSingleton;
    browserSingleton = null;
    try {
      await b.close();
    } catch {
      // The browser may have already crashed / been killed; that's
      // fine for a teardown helper, swallow rather than fail the
      // test run.
    }
  }
}

/**
 * Render the briefing to a PDF Buffer. Builds the HTML synchronously
 * (pure string concatenation), then prints it to PDF via a
 * single-page lifetime in the singleton browser.
 *
 * `printBackground: true` is required so the `@page` margin boxes
 * render the header, footer, and page-number chrome.
 */
export async function renderBriefingPdf(
  input: RenderBriefingPdfInput,
): Promise<Buffer> {
  const html = renderBriefingHtml(input);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // `setContent` with `waitUntil: networkidle0` blocks until the
    // OSM static-map fetch and any source-thumbnail `<img>` requests
    // have settled, so the printed PDF always carries the rendered
    // raster captures rather than broken-image icons.
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      timeout: 30_000,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {
      // ignore — we're already returning, a stale page handle is harmless.
    });
  }
}
