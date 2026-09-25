/**
 * P-447. Map a tool JSON body to the card-page scope minted on the link.
 */

import type { McpCardScope } from "./mcp-card-link.js";
import type { SmartsiteToolName } from "./constants.js";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parcelIdsFromData(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (id: unknown) => {
    if (typeof id === "string" && id.trim()) out.push(id.trim());
  };
  push(data.parcelNodeId);
  const parcels = data.parcels;
  if (Array.isArray(parcels)) {
    for (const raw of parcels) push(asRecord(raw)?.parcelNodeId);
  }
  const hits = data.hits;
  if (Array.isArray(hits)) {
    for (const raw of hits) push(asRecord(raw)?.parcelNodeId);
  }
  const matched = data.matched;
  if (Array.isArray(matched)) {
    for (const raw of matched) push(asRecord(raw)?.parcelNodeId);
  }
  return [...new Set(out)];
}

export function cardPageScopeFromToolPayload(
  tool: SmartsiteToolName,
  data: Record<string, unknown>,
): McpCardScope | null {
  const screen = asRecord(data.screen);
  const screenId =
    (typeof data.screenId === "string" && data.screenId) ||
    (typeof screen?.id === "string" && screen.id) ||
    null;
  if (screenId && (tool === "create_screen" || tool === "list_screens" || tool === "get_smart_site")) {
    const ids = parcelIdsFromData(data);
    return {
      kind: "screen",
      screenId,
      parcelNodeId: ids[0] ?? null,
    };
  }
  const ids = parcelIdsFromData(data);
  if (ids.length === 0) return null;
  if (ids.length === 1) return { kind: "parcel", parcelNodeId: ids[0]! };
  return { kind: "parcels", parcelNodeIds: ids };
}
