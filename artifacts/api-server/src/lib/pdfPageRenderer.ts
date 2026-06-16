/**
 * Server-side PDF-page → PNG render for uploaded plan-set PDFs (P2).
 *
 * Uses puppeteer (already in api-server deps) + pdf-lib page count to
 * rasterize each page via Chrome's built-in PDF viewer at a viewport
 * sized for Claude Opus 4.8 high-resolution vision (~2576px long edge).
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import puppeteer from "puppeteer";
import { PDFDocument } from "pdf-lib";

/** Target long-edge pixels for Claude Opus 4.8 high-resolution vision. */
export const PDF_RENDER_TARGET_LONG_EDGE_PX = 2576;

/** Hard cap on pages rendered per attached-document PDF. */
export const PDF_RENDER_MAX_PAGES = 40;

/** Raised when headless Chrome cannot rasterize an attached plan-set PDF. */
export class PdfRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfRenderError";
  }
}

const CLOUD_RUN_CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--single-process",
  "--no-zygote",
  "--disable-gpu",
] as const;

export interface RenderedPdfPage {
  pageIndex: number;
  png: Buffer;
  width: number;
  height: number;
}

export interface RenderPdfPagesOptions {
  maxPages?: number;
  targetLongEdgePx?: number;
}

async function countPdfPages(pdfBytes: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 1;
  }
}

/**
 * Render PDF bytes to PNG buffers via headless Chromium PDF viewer.
 * Navigates with `#page=N` fragments for multi-page plan sets.
 */
export async function renderPdfPagesToPng(
  pdfBytes: Buffer,
  opts: RenderPdfPagesOptions = {},
): Promise<RenderedPdfPage[]> {
  const maxPages = opts.maxPages ?? PDF_RENDER_MAX_PAGES;
  const targetLongEdge = opts.targetLongEdgePx ?? PDF_RENDER_TARGET_LONG_EDGE_PX;
  const totalPages = Math.min(await countPdfPages(pdfBytes), maxPages);

  const workDir = await mkdtemp(join(tmpdir(), "ldt-pdf-render-"));
  const pdfPath = join(workDir, `${randomUUID()}.pdf`);
  await writeFile(pdfPath, pdfBytes);

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: puppeteer.executablePath(),
      args: [...CLOUD_RUN_CHROME_ARGS],
    });
  } catch (err) {
    throw new PdfRenderError(
      "plan-set vision unavailable: PDF render failed (Chrome launch)",
      { cause: err },
    );
  }

  const viewportW = targetLongEdge;
  const viewportH = Math.round(targetLongEdge * 0.77);
  const pages: RenderedPdfPage[] = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: viewportW,
      height: viewportH,
      deviceScaleFactor: 1,
    });
    const baseUrl = `file:///${pdfPath.replace(/\\/g, "/")}`;

    for (let i = 0; i < totalPages; i++) {
      const pageNum = i + 1;
      await page.goto(`${baseUrl}#page=${pageNum}`, {
        waitUntil: "networkidle0",
        timeout: 60_000,
      });
      await new Promise((r) => setTimeout(r, 500));
      const png = (await page.screenshot({ type: "png", fullPage: false })) as Buffer;
      pages.push({
        pageIndex: i,
        png,
        width: viewportW,
        height: viewportH,
      });
    }

    return pages;
  } catch (err) {
    throw new PdfRenderError(
      "plan-set vision unavailable: PDF render failed",
      { cause: err },
    );
  } finally {
    await browser.close();
    await rm(workDir, { recursive: true, force: true });
  }
}
