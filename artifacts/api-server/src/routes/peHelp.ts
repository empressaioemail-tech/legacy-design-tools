import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";
import { PE_HELP_WIDGET_SYSTEM_PROMPT } from "../lib/peHelpWidgetPrompt";

/**
 * POST /api/pe-help/chat — the Smart Site Help widget's backend (P-118 /
 * A-093). Reachable from hauska-map at /api/spine/cortex/api/pe-help/chat
 * (allowlisted there as a browse-safe path; see apps/property-explorer/
 * api/spine.ts isCortexBrowsePathAllowed).
 *
 * DELIBERATELY UNGATED. This is a SEPARATE surface from
 * routes/brokerageBrief.ts's "/research/chat" (the per-property, tier-gated
 * chat wired to ChatTool.tsx). This route:
 *   - requires no session, no install id, no API key, no entitlement check
 *     of any kind — an anonymous, never-signed-in visitor gets the exact
 *     same answer a Pro subscriber does;
 *   - carries no parcel/property scope of any kind — it never reads or
 *     accepts a parcelNodeId, address, or run selector;
 *   - is grounded ONLY in PE_HELP_WIDGET_SYSTEM_PROMPT (adapted from
 *     doc_repo's Smart Site FAQ master), never in structured atom records —
 *     there is no citation mechanism here and this route must never
 *     pretend there is one.
 *
 * Reuses the underlying "call Claude" plumbing (the `anthropic` singleton
 * from @workspace/integrations-anthropic-ai, same package routes/chat.ts and
 * routes/brokerageBrief.ts use) — nothing else from those routes. No
 * property-scoping, no tool-use loop, no gating.
 */

const router: IRouter = Router();

const HISTORY_TURN_MAX_CHARS = 4000;
const MESSAGE_MAX_CHARS = 4000;
/** Mirrors ChatTool.tsx's own "last-8-turn history window" convention. */
const MAX_HISTORY_TURNS = 8;

const HelpChatBody = z.object({
  message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(HISTORY_TURN_MAX_CHARS),
      }),
    )
    .max(MAX_HISTORY_TURNS)
    .optional(),
});

export type HelpChatTurn = { role: "user" | "assistant"; content: string };

/**
 * Pure: build the Anthropic Messages array from validated history + the new
 * message. Exported for direct unit testing without a network mock.
 *
 * No trimming here — HelpChatBody's `.max(MAX_HISTORY_TURNS)` already fails
 * closed (400) on an oversized history at the validation boundary, mirroring
 * ChatTool.tsx's own convention of windowing to the last 8 turns CLIENT-side
 * before it ever sends. One enforcement point, not two.
 */
export function buildHelpWidgetMessages(
  message: string,
  history: HelpChatTurn[] | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  return [...(history ?? []), { role: "user" as const, content: message }];
}

router.post("/pe-help/chat", async (req: Request, res: Response) => {
  const parse = HelpChatBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_request",
      message: "Body must be { message: string, history?: {role, content}[] }",
      details: parse.error.flatten(),
    });
    return;
  }
  const { message, history } = parse.data;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: PE_HELP_WIDGET_SYSTEM_PROMPT,
      messages: buildHelpWidgetMessages(message, history),
    });
    const textBlock = response.content.find(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    );
    if (!textBlock || !textBlock.text.trim()) {
      // Never fabricate an answer when the model returns nothing textual
      // (e.g. it only emitted a non-text block). Honest failure, not a
      // canned fake reply.
      logger.warn({ stopReason: response.stop_reason }, "pe-help: model returned no text content");
      res.status(502).json({
        error: "no_answer",
        message: "The assistant did not return an answer — try again.",
      });
      return;
    }
    res.status(200).json({ message: textBlock.text });
  } catch (err) {
    logger.error({ err }, "pe-help: chat call failed");
    res.status(502).json({
      error: "upstream_error",
      message: "Could not reach the assistant — try again.",
    });
  }
});

export default router;
