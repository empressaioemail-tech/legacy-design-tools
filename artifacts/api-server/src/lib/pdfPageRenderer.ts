/**
 * Server-side PDF-page → PNG render for uploaded plan-set PDFs (P2).
 *
 * Primary path: poppler `pdftoppm` (native, reliable on Cloud Run slim).
 * Puppeteer/Chrome was structurally fragile on cortex-api Cloud Run
 * (30s WS-endpoint launch timeout on revision 00177 despite bundled libs).
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";

const execFileAsync = promisify(execFile);

/** Target long-edge pixels for Claude Opus 4.8 high-resolution vision. */
export const PDF_RENDER_TARGET_LONG_EDGE_PX = 2576;

/** Hard cap on pages rendered per attached-document PDF. */
export const PDF_RENDER_MAX_PAGES = 40;

/** Raised when rasterization of an attached plan-set PDF fails. */
export class PdfRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfRenderError";
  }
}

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

/** DPI to hit target long edge on US Letter (11" long side). */
function dpiForTargetLongEdge(targetLongEdgePx: number): number {
  return Math.max(72, Math.min(300, Math.round(targetLongEdgePx / 11)));
}

async function renderWithPoppler(
  pdfBytes: Buffer,
  totalPages: number,
  targetLongEdgePx: number,
): Promise<RenderedPdfPage[]> {
  const workDir = await mkdtemp(join(tmpdir(), "ldt-pdf-render-"));
  const pdfPath = join(workDir, `${randomUUID()}.pdf`);
  const outPrefix = join(workDir, "page");
  const dpi = dpiForTargetLongEdge(targetLongEdgePx);

  try {
    await writeFile(pdfPath, pdfBytes);
    await execFileAsync(
      "pdftoppm",
      [
        "-png",
        "-r",
        String(dpi),
        "-f",
        "1",
        "-l",
        String(totalPages),
        pdfPath,
        outPrefix,
      ],
      { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );

    const files = (await readdir(workDir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort((a, b) => {
        const na = Number(a.match(/page-(\d+)\.png/)?.[1] ?? 0);
        const nb = Number(b.match(/page-(\d+)\.png/)?.[1] ?? 0);
        return na - nb;
      });

    const pages: RenderedPdfPage[] = [];
    for (let i = 0; i < files.length; i++) {
      const png = await readFile(join(workDir, files[i]));
      pages.push({
        pageIndex: i,
        png,
        width: Math.round((8.5 * dpi) / 1),
        height: Math.round((11 * dpi) / 1),
      });
    }
    if (pages.length === 0) {
      throw new PdfRenderError(
        "plan-set vision unavailable: PDF render produced no pages",
      );
    }
    return pages;
  } catch (err) {
    if (err instanceof PdfRenderError) throw err;
    throw new PdfRenderError(
      "plan-set vision unavailable: PDF render failed (pdftoppm)",
      { cause: err },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Render PDF bytes to PNG buffers via poppler pdftoppm.
 */
export async function renderPdfPagesToPng(
  pdfBytes: Buffer,
  opts: RenderPdfPagesOptions = {},
): Promise<RenderedPdfPage[]> {
  const maxPages = opts.maxPages ?? PDF_RENDER_MAX_PAGES;
  const targetLongEdge = opts.targetLongEdgePx ?? PDF_RENDER_TARGET_LONG_EDGE_PX;
  const totalPages = Math.min(await countPdfPages(pdfBytes), maxPages);
  return renderWithPoppler(pdfBytes, totalPages, targetLongEdge);
}
