/**
 * AI-vision annotation pipeline (Track F Phase 1).
 *
 * Three pure-ish helpers the plan-review BFF's async annotation-generation
 * job composes:
 *   - `getPdfPageCount`  — page count via pdf-lib (0 on non-PDF).
 *   - `rasterizePdfPage` — one PDF page -> base64 PNG via `pdftoppm`.
 *   - `extractAnnotationCoordinates` — one vision call locating the element
 *     a failing finding refers to, returning a 0..1 normalized bbox or null.
 *
 * Structural commitment: the coordinate this module produces is an
 * AI-vision *assertion*, never an earned/calibrated number. The confidence
 * stamping lives at the insert site (planReviewBff.runAnnotationGeneration),
 * fixed to `{ value, kind: 'asserted' }`.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

const execAsync = promisify(exec);

const VISION_MODEL = "claude-haiku-4-5-20251001";

/**
 * Page count via pdf-lib. Returns 0 for anything that does not load as a
 * PDF so callers can skip non-PDF attachments without a throw.
 */
export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

/**
 * Rasterize a single 1-indexed PDF page to a base64-encoded PNG at 150 DPI
 * via poppler's `pdftoppm`. Uses unique temp names (Date.now + random) so
 * concurrent jobs never collide, and cleans up both the temp input PDF and
 * the produced PNG in a finally block.
 *
 * `pdftoppm -f N -l N -png <in> <outPrefix>` writes
 * `<outPrefix>-000NNN.png` where NNN is the zero-padded (6-digit) page
 * number.
 */
export async function rasterizePdfPage(
  pdfBuffer: Buffer,
  page: number,
): Promise<string> {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = os.tmpdir();
  const inPath = path.join(dir, `annot-in-${uniq}.pdf`);
  const outPrefix = path.join(dir, `annot-out-${uniq}`);
  const pageStr = String(page).padStart(6, "0");
  const outPng = `${outPrefix}-${pageStr}.png`;

  try {
    await fs.writeFile(inPath, pdfBuffer);
    await execAsync(
      `pdftoppm -r 150 -f ${page} -l ${page} -png "${inPath}" "${outPrefix}"`,
    );
    const png = await fs.readFile(outPng);
    return png.toString("base64");
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outPng, { force: true }).catch(() => {});
  }
}

export interface VisionFinding {
  findingId: string;
  codeSection: string;
  description: string;
}

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isFiniteUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Ask the vision model to locate the plan element the finding refers to and
 * return a 0..1 normalized bounding box (top-left origin) as
 * `{ x, y, width, height }`, or null when the model cannot find it / returns
 * anything malformed. Never throws — a bad response is a `null`, not a job
 * failure.
 */
export async function extractAnnotationCoordinates(
  imageBase64: string,
  finding: VisionFinding,
): Promise<NormalizedBox | null> {
  try {
    const response = await anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text:
                "You are locating an element on a rasterized architectural / " +
                "site plan sheet. A compliance finding was raised against " +
                "this sheet:\n\n" +
                `Code section: ${finding.codeSection}\n` +
                `Finding: ${finding.description}\n\n` +
                "Identify the single region of the image the finding refers " +
                "to and return ONLY a JSON object with 0..1 normalized " +
                "coordinates (top-left origin): " +
                '{"x":<left>,"y":<top>,"width":<w>,"height":<h>}. ' +
                'If you cannot locate it, return {"notFound":true}. ' +
                "Return JSON only, no prose.",
            },
          ],
        },
      ],
    });

    const block = response.content[0];
    if (!block || block.type !== "text") return null;

    let raw = block.text.trim();
    // Strip markdown code fences if the model wrapped its JSON.
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    }

    const parsed = JSON.parse(raw) as {
      notFound?: unknown;
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
    };

    if (parsed.notFound === true) return null;

    if (
      isFiniteUnit(parsed.x) &&
      isFiniteUnit(parsed.y) &&
      isFiniteUnit(parsed.width) &&
      isFiniteUnit(parsed.height)
    ) {
      return {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height,
      };
    }
    return null;
  } catch (err) {
    logger.warn(
      { err, findingId: finding.findingId },
      "annotationPipeline: vision coordinate extraction failed",
    );
    return null;
  }
}
