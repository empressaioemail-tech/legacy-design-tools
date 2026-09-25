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
import {
  buildReadingLayoutText,
  injectCardPageLink,
} from "./reading-layout.js";
import { recordMapRenderEvent, type MapRenderOutcome } from "./render-metrics.js";

type ContentPart = { type: string; [key: string]: unknown };

export type TieredToolResult = {
  content: ContentPart[];
  structuredContent?: unknown;
  isError?: boolean;
  skipStandingVocab?: boolean;
};

function firstJsonText(content: ContentPart[]): string | null {
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

function outcomeForView(view: CardView, uiCapable: boolean): MapRenderOutcome {
  if (view === "none") return "fallback";
  if (!uiCapable) return "fallback";
  return "card";
}

export function applyHostTierToResult(
  tool: SmartsiteToolName,
  result: TieredToolResult,
  session: HostSessionSnapshot,
  userId: string,
): TieredToolResult {
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

  if (!uiCapable && link) {
    const reading = buildReadingLayoutText(data, link, {
      openInBrowser: isChromeSidePanel(session),
    });
    const withoutResourceLinks = result.content.filter((p) => p.type !== "resource_link");
    const nextContent: ContentPart[] = [{ type: "text", text: reading }];
    for (const part of withoutResourceLinks) {
      if (part.type === "text" && part.text === jsonText) continue;
      nextContent.push(part);
    }
    nextContent.push({ type: "text", text: JSON.stringify(data) });
    return {
      ...result,
      content: nextContent,
      structuredContent: result.structuredContent ?? data,
    };
  }

  if (link) {
    const replaced = result.content.map((part) => {
      if (part.type === "text" && part.text === jsonText) {
        return { type: "text", text: JSON.stringify(data) };
      }
      return part;
    });
    return { ...result, content: replaced, structuredContent: result.structuredContent ?? data };
  }

  return result;
}
