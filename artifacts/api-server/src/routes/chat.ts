import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { db, engagements, snapshots, sheets } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MAX_REFERENCED_SHEETS = 4;

function relativeTime(from: Date): string {
  const diffMs = Date.now() - from.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `about ${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `about ${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `about ${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

interface AttachedSheet {
  id: string;
  sheetNumber: string;
  sheetName: string;
  pngBase64: string;
}

router.post("/chat", async (req: Request, res: Response) => {
  const parse = SendChatMessageBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid chat request" });
    return;
  }
  const { engagementId, question, history, referencedSheetIds } = parse.data;

  let engagement: typeof engagements.$inferSelect | undefined;
  let latestSnapshot: typeof snapshots.$inferSelect | undefined;

  try {
    const eRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    engagement = eRows[0];

    if (!engagement) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const sRows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.engagementId, engagement.id))
      .orderBy(desc(snapshots.receivedAt))
      .limit(1);
    latestSnapshot = sRows[0];
  } catch (err) {
    logger.error({ err, engagementId }, "chat lookup failed");
    res.status(500).json({ error: "Failed to load engagement" });
    return;
  }

  if (!latestSnapshot) {
    res.status(400).json({
      error: "no_snapshots",
      message:
        "No snapshots yet for this engagement. Send one from Revit first.",
    });
    return;
  }

  // Resolve attached sheets, scoped to this engagement so the user can't
  // hand-craft a request that exfiltrates someone else's images.
  const attachedSheets: AttachedSheet[] = [];
  if (referencedSheetIds && referencedSheetIds.length > 0) {
    const ids = referencedSheetIds.slice(0, MAX_REFERENCED_SHEETS);
    try {
      const rows = await db
        .select({
          id: sheets.id,
          sheetNumber: sheets.sheetNumber,
          sheetName: sheets.sheetName,
          fullPng: sheets.fullPng,
        })
        .from(sheets)
        .where(
          and(
            inArray(sheets.id, ids),
            eq(sheets.engagementId, engagement.id),
          ),
        );
      for (const r of rows) {
        const buf = Buffer.isBuffer(r.fullPng)
          ? r.fullPng
          : Buffer.from(r.fullPng as Uint8Array);
        attachedSheets.push({
          id: r.id,
          sheetNumber: r.sheetNumber,
          sheetName: r.sheetName,
          pngBase64: buf.toString("base64"),
        });
      }
    } catch (err) {
      logger.warn(
        { err, engagementId, count: ids.length },
        "failed to load attached sheets — proceeding without vision",
      );
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const addressSuffix = engagement.address ? ` at ${engagement.address}` : "";
  const jurisdictionSuffix = engagement.jurisdiction
    ? ` (${engagement.jurisdiction})`
    : "";
  const captured = relativeTime(latestSnapshot.receivedAt);
  const isoReceivedAt = latestSnapshot.receivedAt.toISOString();

  const systemPrompt =
    `You are helping an architect understand their Revit model for the engagement '${engagement.name}'${addressSuffix}${jurisdictionSuffix}. The most recent snapshot was captured ${captured}.\n\n` +
    "Answer grounded in the snapshot data below. If the data does not contain what's asked, say so plainly. Be terse and operational in tone — this is a professional tool, not a chatbot.\n\n" +
    `<snapshot received_at='${isoReceivedAt}'>\n${JSON.stringify(latestSnapshot.payload, null, 2)}\n</snapshot>`;

  type ContentBlock =
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: "image/png"; data: string };
      };

  const userBlocks: ContentBlock[] = [];
  if (attachedSheets.length > 0) {
    const sheetList = attachedSheets
      .map((s) => `${s.sheetNumber} ${s.sheetName}`)
      .join(", ");
    userBlocks.push({
      type: "text",
      text: `User question: ${question}\n\nThe following sheets are attached for visual reference: ${sheetList}`,
    });
    for (const s of attachedSheets) {
      userBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: s.pngBase64,
        },
      });
    }
  } else {
    userBlocks.push({ type: "text", text: question });
  }

  const messages = [
    ...(history ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: "user" as const,
      content:
        attachedSheets.length > 0
          ? userBlocks
          : (userBlocks[0] as { type: "text"; text: string }).text,
    },
  ];

  if (attachedSheets.length > 0) {
    logger.info(
      {
        engagementId,
        sheetCount: attachedSheets.length,
        approxAddedTokens: attachedSheets.reduce(
          (sum, s) => sum + Math.round(s.pngBase64.length / 4),
          0,
        ),
      },
      "chat with vision attachments",
    );
  }

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      // The SDK accepts string OR content-block arrays for user content; the
      // type union here is wider than the generated typings expose.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
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
    logger.error({ err, engagementId }, "chat stream failed");
    try {
      res.write(`data: ${JSON.stringify({ error: "stream_failed" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      // socket already closed
    }
  }
});

export default router;
