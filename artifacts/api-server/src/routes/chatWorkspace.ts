/**
 * QA-45 — workspace-scoped dashboard chat (no engagement / no Revit snapshot).
 */
import type { Request, Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  engagements,
  snapshots,
  architectNotificationReads,
  atomEvents,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import type { Scope } from "@hauska/atom-contract";
import { logger } from "../lib/logger";
import {
  WORKSPACE_CHAT_TOOLS,
  executeWorkspaceAgentTool,
  buildWorkspaceAgentToolGuidance,
} from "./chatWorkspaceTools";

const MAX_AGENT_ITERATIONS = 6;

export async function handleWorkspaceChat(
  req: Request,
  res: Response,
  input: {
    question: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    activeTab: string | null;
    scope: Scope;
  },
): Promise<void> {
  const { question, history, activeTab, scope } = input;
  const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;

  let portfolioSummary = "";
  try {
    const rows = await db
      .select()
      .from(engagements)
      .orderBy(desc(engagements.updatedAt))
      .limit(40);
    const lines: string[] = [];
    for (const e of rows) {
      const [{ count }] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(snapshots)
        .where(eq(snapshots.engagementId, e.id));
      const snapCount = Number(count) || 0;
      const needsAttention =
        e.status === "active" &&
        (!e.address?.trim() || snapCount === 0 || !e.geocodedAt);
      lines.push(
        `- ${e.name} (id=${e.id}, status=${e.status}, snapshots=${snapCount}, jurisdiction=${e.jurisdiction ?? "—"}, address=${e.address ?? "—"}${needsAttention ? ", needs_attention=true" : ""})`,
      );
    }
    portfolioSummary = lines.join("\n") || "(no engagements yet)";
  } catch (err) {
    reqLog.error({ err }, "workspace chat: portfolio load failed");
    portfolioSummary = "(portfolio summary unavailable)";
  }

  let unreadNotifications = 0;
  try {
    const userId = req.session?.requestor?.id ?? "anonymous";
    const [readRow] = await db
      .select()
      .from(architectNotificationReads)
      .where(eq(architectNotificationReads.userId, userId))
      .limit(1);
    const lastReadAt = readRow?.lastReadAt ?? new Date(0);
    const [{ count }] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(atomEvents)
      .where(sql`${atomEvents.occurredAt} > ${lastReadAt}`);
    unreadNotifications = Number(count) || 0;
  } catch {
    unreadNotifications = 0;
  }

  const systemPrompt =
    "You are the Cortex architect assistant on the global dashboard. " +
    "The operator has NOT opened a specific engagement — answer portfolio-level questions " +
    "(which projects need attention, inbox summary, where to start). " +
    "Do NOT ask them to send a Revit snapshot. Use list_engagements and " +
    "summarize_inbox tools for grounded answers. " +
    "When suggesting next steps, name engagement ids from the portfolio list.\n\n" +
    `<portfolio>\n${portfolioSummary}\n</portfolio>\n` +
    `<inbox_unread_estimate>${unreadNotifications}</inbox_unread_estimate>\n` +
    buildWorkspaceAgentToolGuidance({ activeTab });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convo: any[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];

  let iterations = 0;
  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: convo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: WORKSPACE_CHAT_TOOLS as any,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason !== "tool_use") break;

    convo.push({ role: "assistant", content: finalMessage.content });
    const toolUseBlocks = finalMessage.content.filter(
      (b): b is Extract<typeof b, { type: "tool_use" }> =>
        b.type === "tool_use",
    );

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const block of toolUseBlocks) {
      res.write(
        `data: ${JSON.stringify({ type: "tool_use", tool: block.name })}\n\n`,
      );
      try {
        const run = await executeWorkspaceAgentTool(block.name, block.input, {
          scope,
          req,
          reqLog,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: run.resultText,
          ...(run.isError ? { is_error: true } : {}),
        });
      } catch (toolErr) {
        reqLog.error({ err: toolErr, tool: block.name }, "workspace tool failed");
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "Tool execution failed.",
          is_error: true,
        });
      }
    }

    convo.push({ role: "user", content: toolResults });
  }

  res.write(`data: [DONE]\n\n`);
  res.end();
}
