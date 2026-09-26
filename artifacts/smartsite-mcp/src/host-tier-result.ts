/**
 * P-447. Apply host capability tiers to a tool result (link, reading layout, metrics).
 */

import type { SmartsiteToolName } from "./constants.js";
import type { CardView } from "./card-contract.js";
import { cardViewFromToolPayload } from "./card-contract.js";
import { cardPageScopeFromToolPayload } from "./card-page-scope.js";
import {
  mintMcpCardLink,
  mcpCardSigningSecret,
  type McpCardLink,
} from "./mcp-card-link.js";
import type { HostSessionSnapshot } from "./host-ui-capability.js";
import { hostKeyFromSession } from "./host-ui-capability.js";
import { attachInlineCard } from "./inline-card.js";
import {
  buildReadingLayoutText,
  injectCardPageLink,
} from "./reading-layout.js";
import { recordMapRenderEvent, type MapRenderOutcome } from "./render-metrics.js";
import type { ToolResult } from "./tools-types.js";

function firstJsonText(content: ToolResult["content"]): string | null {
  for (const part of content) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    try {
      JSON.parse(part.text);
      return part.text;
    } catch {
      continue;
    }
  }
  return null;
}

function isChromeSidePanel(session: HostSessionSnapshot): boolean {
  const name = session.clientName?.toLowerCase() ?? "";
  return name.includes("chrome") || name.includes("claude-in-chrome");
}

function mergeStructured(
  prior: ToolResult["structuredContent"],
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (prior && typeof prior === "object" && !Array.isArray(prior)) {
    return { ...prior, ...data };
  }
  return data;
}

function outcomeForView(view: CardView, uiCapable: boolean): MapRenderOutcome {
  if (view === "none") return "fallback";
  if (!uiCapable) return "fallback";
  return "card";
}

export function applyHostTierToResult(
  tool: SmartsiteToolName,
  result: ToolResult,
  session: HostSessionSnapshot,
  userId: string,
): ToolResult {
  const host = hostKeyFromSession(session, userId);
  const jsonText = firstJsonText(result.content);
  if (!jsonText) return result;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return result;
  }

  const view = cardViewFromToolPayload(tool, data);
  const uiCapable = session.uiCapable;
  recordMapRenderEvent(host, tool, outcomeForView(view, uiCapable), uiCapable ? "ui_capable" : "ui_absent", {
    uiCapable,
  });

  const secret = mcpCardSigningSecret();
  const scope = cardPageScopeFromToolPayload(tool, data);
  let link: McpCardLink | null = null;
  if (secret && scope) {
    link = mintMcpCardLink({
      secret,
      sharerUserId: userId,
      tool,
      scope,
    });
    data = JSON.parse(injectCardPageLink(JSON.stringify(data), link)) as Record<string, unknown>;
  }

  data = attachInlineCard(data, link?.url ?? null, (parcelNodeId) => {
    if (!secret) return null;
    return mintMcpCardLink({
      secret,
      sharerUserId: userId,
      tool,
      scope: { kind: "parcel", parcelNodeId },
    }).url;
  });

  if (!uiCapable && link) {
    const reading = buildReadingLayoutText(data, link, {
      openInBrowser: isChromeSidePanel(session),
    });
    const withoutResourceLinks = result.content.filter((p) => p.type !== "resource_link");
    const nextContent: ToolResult["content"] = [{ type: "text", text: reading }];
    for (const part of withoutResourceLinks) {
      if (part.type === "text" && part.text === jsonText) continue;
      nextContent.push(part);
    }
    nextContent.push({ type: "text", text: JSON.stringify(data) });
    return {
      ...result,
      content: nextContent,
      structuredContent: mergeStructured(result.structuredContent, data),
    };
  }

  const nextText = JSON.stringify(data);
  if (nextText !== jsonText) {
    const replaced: ToolResult["content"] = result.content.map((part) => {
      if (part.type === "text" && part.text === jsonText) {
        return { type: "text" as const, text: nextText };
      }
      return part;
    });
    return {
      ...result,
      content: replaced,
      structuredContent: mergeStructured(result.structuredContent, data),
    };
  }

  return result;
}
