import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { getSnapshot } from "./snapshots";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/chat", async (req: Request, res: Response) => {
  const parse = SendChatMessageBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid chat request" });
    return;
  }
  const { snapshotId, question, history } = parse.data;

  const snapshot = getSnapshot(snapshotId);
  if (!snapshot) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const systemPrompt =
    "You are helping an architect understand their current Revit model. The model snapshot JSON is below. Answer grounded in this data; if the data doesn't contain what's asked, say so plainly. Be terse and operational in tone — this is a professional tool, not a chatbot.\n\n<snapshot>\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n</snapshot>";

  const messages = [
    ...(history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: question },
  ];

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    logger.error({ err }, "chat stream failed");
    try {
      res.write(
        `data: ${JSON.stringify({ error: "stream_failed" })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      // socket already closed
    }
  }
});

export default router;
