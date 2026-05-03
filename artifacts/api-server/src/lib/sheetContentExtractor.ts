/**
 * Sheet-content extraction pipeline (PLR-8 follow-up, Task #477).
 *
 * The Revit add-in MAY ship a per-sheet `contentBody` text inside the
 * multipart upload's `metadata` field (Revit-side text capture — the
 * preferred path because no vision call is required). When it doesn't,
 * we fall back to a vision/OCR pass against the sheet's full PNG so the
 * downstream cross-reference chip rendering in the plan-review UI lights
 * up regardless of how the sheet got into the system.
 *
 * Mode selection mirrors {@link import("./findingLlmClient").getFindingLlmClient}:
 *   - `mock` (default): no network call, returns null. The sheet row's
 *     `contentBody` stays whatever the metadata supplied (typically null).
 *   - `anthropic`: Claude Sonnet 4.5 vision call against the full PNG,
 *     prompted to return ONLY the in-sheet text body. Failures swallow
 *     to null so a transient outage never breaks the upload.
 *
 * The extraction never blocks the multipart upload response — the route
 * fires this in the background after the row commits and patches the
 * `content_body` column once the call returns.
 */

import { eq } from "drizzle-orm";
import { db, sheets } from "@workspace/db";
import { logger } from "./logger";
import { getSheetContentLlmClient } from "./sheetContentLlmClient";

/** Hard cap on extracted text so a runaway model can't blow up the row. */
export const SHEET_CONTENT_BODY_MAX_CHARS = 8000;

/**
 * Anthropic model used for the vision pass. Pinned to Sonnet 4.5 to
 * match the rest of the api-server's anthropic surface (briefing /
 * finding engines).
 */
export const SHEET_CONTENT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

/**
 * Token budget for the vision response. Sheet bodies are short by
 * design (notes / callouts), so a small ceiling keeps cost bounded
 * while still leaving room for a dense general-notes sheet.
 */
export const SHEET_CONTENT_ANTHROPIC_MAX_TOKENS = 1500;

/** Minimal subset of the Anthropic SDK shape we depend on. */
interface AnthropicLikeClient {
  messages: {
    create: (args: unknown) => Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

const SYSTEM_PROMPT = [
  "You are an OCR/transcription assistant for architectural drawing sheets.",
  "Extract every legible block of free-text on the sheet — general notes,",
  "keynotes, callouts, schedules, and any cross-references such as",
  "'SEE A-301' or '5/A-501'. Preserve cross-references VERBATIM so the",
  "downstream parser can link them. Do NOT invent text. Return ONLY the",
  "transcribed body — no preamble, no explanations, no markdown fences.",
  "If the sheet has no legible text, return an empty string.",
].join(" ");

/**
 * Outcome of a single-sheet extraction call. `null` is the "no work
 * happened" signal (mock mode or no usable text from the model);
 * `{ kind: "error" }` is reserved for client-throw paths so the caller
 * can bump a failure counter rather than merging both into one
 * skip-bucket.
 */
export type ExtractSheetContentOutcome =
  | { kind: "text"; body: string }
  | { kind: "empty" }
  | { kind: "error"; err: unknown };

/**
 * Run the vision pass against a single sheet's full PNG. Returns:
 *   - `{ kind: "text", body }` on a successful transcription (clipped
 *     to {@link SHEET_CONTENT_BODY_MAX_CHARS}).
 *   - `{ kind: "empty" }` when no client is wired (mock mode) or the
 *     model returned no usable text.
 *   - `{ kind: "error", err }` when the client call threw — distinct
 *     from `empty` so the caller can report a real failure metric.
 */
export async function extractSheetContentBody(
  fullPng: Buffer,
): Promise<ExtractSheetContentOutcome> {
  const client = (await getSheetContentLlmClient()) as AnthropicLikeClient | null;
  if (!client) return { kind: "empty" };
  try {
    const response = await client.messages.create({
      model: SHEET_CONTENT_ANTHROPIC_MODEL,
      max_tokens: SHEET_CONTENT_ANTHROPIC_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: fullPng.toString("base64"),
              },
            },
            {
              type: "text",
              text: "Transcribe the in-sheet text body for this drawing.",
            },
          ],
        },
      ],
    });
    const text = response.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (!text) return { kind: "empty" };
    const clipped =
      text.length > SHEET_CONTENT_BODY_MAX_CHARS
        ? text.slice(0, SHEET_CONTENT_BODY_MAX_CHARS)
        : text;
    return { kind: "text", body: clipped };
  } catch (err) {
    logger.warn(
      { err },
      "sheet-content vision extraction failed — leaving contentBody null",
    );
    return { kind: "error", err };
  }
}

/**
 * Back-compat shim for callers (and tests) that just want the body or
 * `null`. Treats both the empty-result and error branches as `null`.
 */
export async function extractSheetContentBodyFromPng(
  fullPng: Buffer,
): Promise<string | null> {
  const outcome = await extractSheetContentBody(fullPng);
  return outcome.kind === "text" ? outcome.body : null;
}

/** One sheet's worth of work for the background extractor pass. */
export interface SheetExtractionTarget {
  sheetId: string;
  fullPng: Buffer;
}

/**
 * Fire-and-forget post-ingest pass that calls
 * {@link extractSheetContentBodyFromPng} for every target with no
 * caller-supplied contentBody and patches the `content_body` column.
 * Never throws — every failure is logged with structured fields. Safe
 * to `void`-launch from the multipart upload route.
 *
 * `dbInstance` defaults to the prod drizzle singleton; tests inject a
 * test-schema instance.
 */
export async function runSheetContentExtraction(
  targets: ReadonlyArray<SheetExtractionTarget>,
  reqLog: typeof logger = logger,
  dbInstance: typeof db = db,
): Promise<{ extracted: number; skipped: number; failed: number }> {
  let extracted = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of targets) {
    const outcome = await extractSheetContentBody(t.fullPng);
    if (outcome.kind === "error") {
      failed++;
      reqLog.warn(
        { err: outcome.err, sheetId: t.sheetId },
        "sheet-content extraction client threw — leaving contentBody untouched",
      );
      continue;
    }
    if (outcome.kind === "empty") {
      skipped++;
      continue;
    }
    try {
      await dbInstance
        .update(sheets)
        .set({ contentBody: outcome.body })
        .where(eq(sheets.id, t.sheetId));
      extracted++;
      reqLog.info(
        { sheetId: t.sheetId, length: outcome.body.length },
        "sheet-content extracted and persisted",
      );
    } catch (err) {
      failed++;
      reqLog.error(
        { err, sheetId: t.sheetId },
        "sheet-content persist failed — extraction discarded",
      );
    }
  }
  return { extracted, skipped, failed };
}
