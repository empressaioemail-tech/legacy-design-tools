/**
 * Deliverable-letter PDF export (Puppeteer, mirrors briefingPdf adapter).
 */

import puppeteer, { type Browser } from "puppeteer";
import {
  renderDeliverableLetterHtml,
  type RenderDeliverableLetterHtmlInput,
} from "./deliverableLetterHtml";

export type RenderDeliverableLetterPdfInput = RenderDeliverableLetterHtmlInput;

let browserSingleton: Browser | null = null;
let browserStarting: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserSingleton && browserSingleton.connected) return browserSingleton;
  if (browserStarting) return browserStarting;
  browserStarting = puppeteer
    .launch({
      headless: true,
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
    });
  return browserStarting;
}

export async function closeDeliverableLetterBrowserForTests(): Promise<void> {
  if (browserSingleton) {
    await browserSingleton.close();
    browserSingleton = null;
  }
  browserStarting = null;
}

export async function renderDeliverableLetterPdf(
  input: RenderDeliverableLetterPdfInput,
): Promise<Buffer> {
  const html = renderDeliverableLetterHtml(input);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 30_000,
    });
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0.5in", right: "0.5in", bottom: "0.5in", left: "0.5in" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
