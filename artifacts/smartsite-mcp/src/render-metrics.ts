/**
 * P-446 / P-456b. Map render telemetry: server records *sent*; the MCP App
 * reports drawn / fallback / failed. Counts are in-process on this instance;
 * operators aggregate JSON log lines across replicas.
 */

import type { McpRenderHostKey } from "./mcp-host-key.js";

export type MapRenderServerOutcome = "sent" | "no_map";
export type MapRenderCardOutcome = "drawn" | "fallback" | "failed";

export type MapRenderReportPayload = {
  correlationId: string;
  outcome: MapRenderCardOutcome;
  reasonCode: string;
  tool?: string;
};

type HostBucket = {
  sent: number;
  unconfirmed: number;
  drawn: number;
  fallback: number;
  failed: number;
  no_map: number;
  byReason: Record<string, number>;
};

type PendingSent = {
  host: McpRenderHostKey;
  tool: string;
  reasonCode: string;
};

type Store = {
  buckets: Map<McpRenderHostKey, HostBucket>;
  pending: Map<string, PendingSent>;
};

declare global {
  // eslint-disable-next-line no-var
  var __smartsiteMapRenderStore: Store | undefined;
}

function store(): Store {
  if (!globalThis.__smartsiteMapRenderStore) {
    globalThis.__smartsiteMapRenderStore = {
      buckets: new Map(),
      pending: new Map(),
    };
  }
  return globalThis.__smartsiteMapRenderStore;
}

function bucketFor(host: McpRenderHostKey): HostBucket {
  const s = store();
  let b = s.buckets.get(host);
  if (!b) {
    b = {
      sent: 0,
      unconfirmed: 0,
      drawn: 0,
      fallback: 0,
      failed: 0,
      no_map: 0,
      byReason: {},
    };
    s.buckets.set(host, b);
  }
  return b;
}

function bumpReason(b: HostBucket, reason: string): void {
  const r = reason.trim() || "none";
  b.byReason[r] = (b.byReason[r] ?? 0) + 1;
}

function logEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "mcp_map_render", ...fields }));
}

/** Server-side: a map-capable tool result was sent to the host (not yet drawn). */
export function recordMapRenderSent(
  host: McpRenderHostKey,
  tool: string,
  reasonCode: string,
): string {
  const correlationId = crypto.randomUUID();
  const b = bucketFor(host);
  b.sent += 1;
  b.unconfirmed += 1;
  bumpReason(b, reasonCode);
  store().pending.set(correlationId, {
    host,
    tool,
    reasonCode: reasonCode.trim() || "none",
  });
  logEvent({
    host,
    tool,
    phase: "sent",
    outcome: "sent",
    reasonCode: reasonCode.trim() || "none",
    correlationId,
    at: new Date().toISOString(),
  });
  return correlationId;
}

/** Server-side: tool result will not show a map card. */
export function recordMapRenderNoMap(
  host: McpRenderHostKey,
  tool: string,
  reasonCode: string,
): void {
  const b = bucketFor(host);
  b.no_map += 1;
  bumpReason(b, reasonCode);
  logEvent({
    host,
    tool,
    phase: "server",
    outcome: "no_map",
    reasonCode: reasonCode.trim() || "none",
    at: new Date().toISOString(),
  });
}

/** MCP App beacon: card finished rendering (or failed). */
export function recordMapRenderCardReport(
  payload: MapRenderReportPayload,
): { ok: true } | { ok: false; error: string } {
  const id = payload.correlationId.trim();
  if (!id) return { ok: false, error: "correlation_id_required" };
  const pending = store().pending.get(id);
  if (!pending) return { ok: false, error: "unknown_correlation_id" };

  const outcome = payload.outcome;
  if (outcome !== "drawn" && outcome !== "fallback" && outcome !== "failed") {
    return { ok: false, error: "invalid_outcome" };
  }

  const b = bucketFor(pending.host);
  if (b.unconfirmed > 0) b.unconfirmed -= 1;
  if (outcome === "drawn") b.drawn += 1;
  if (outcome === "fallback") b.fallback += 1;
  if (outcome === "failed") b.failed += 1;

  const reason = payload.reasonCode.trim() || pending.reasonCode;
  bumpReason(b, `${outcome}:${reason}`);

  store().pending.delete(id);

  logEvent({
    host: pending.host,
    tool: payload.tool?.trim() || pending.tool,
    phase: "card",
    outcome,
    reasonCode: reason,
    correlationId: id,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

export function snapshotMapRenderMetrics(): Record<
  McpRenderHostKey,
  {
    sent: number;
    unconfirmed: number;
    drawn: number;
    fallback: number;
    failed: number;
    no_map: number;
    byReason: Record<string, number>;
  }
> {
  const out: Record<
    string,
    {
      sent: number;
      unconfirmed: number;
      drawn: number;
      fallback: number;
      failed: number;
      no_map: number;
      byReason: Record<string, number>;
    }
  > = {};
  for (const [host, b] of store().buckets) {
    out[host] = {
      sent: b.sent,
      unconfirmed: b.unconfirmed,
      drawn: b.drawn,
      fallback: b.fallback,
      failed: b.failed,
      no_map: b.no_map,
      byReason: { ...b.byReason },
    };
  }
  return out as Record<McpRenderHostKey, (typeof out)[string]>;
}

/** Test hook: reset counts between cases. */
export function resetMapRenderMetricsForTests(): void {
  store().buckets.clear();
  store().pending.clear();
}

/** @deprecated P-446 name; use recordMapRenderSent / recordMapRenderNoMap. */
export function recordMapRenderEvent(
  host: string,
  tool: string,
  outcome: "card" | "fallback" | "no_map",
  reasonCode: string,
): void {
  const key = (host.trim() || "other") as McpRenderHostKey;
  if (outcome === "no_map") {
    recordMapRenderNoMap(key, tool, reasonCode);
    return;
  }
  if (outcome === "fallback") {
    const id = recordMapRenderSent(key, tool, reasonCode);
    recordMapRenderCardReport({
      correlationId: id,
      outcome: "fallback",
      reasonCode,
      tool,
    });
    return;
  }
  recordMapRenderSent(key, tool, reasonCode);
}
