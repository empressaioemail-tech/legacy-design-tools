/**
 * P-446. Per-host map render outcomes for MCP App tool results.
 * Counts are in-process (one connector instance); operators aggregate via the
 * JSON log line `mcp_map_render` or GET /internal/map-render-metrics.
 */

export type MapRenderOutcome = "card" | "fallback" | "no_map";

export type MapRenderEvent = {
  host: string;
  tool: string;
  outcome: MapRenderOutcome;
  reasonCode: string;
  at: string;
};

type HostBucket = {
  total: number;
  byOutcome: Record<MapRenderOutcome, number>;
  byReason: Record<string, number>;
};

const buckets = new Map<string, HostBucket>();

function bucketFor(host: string): HostBucket {
  let b = buckets.get(host);
  if (!b) {
    b = {
      total: 0,
      byOutcome: { card: 0, fallback: 0, no_map: 0 },
      byReason: {},
    };
    buckets.set(host, b);
  }
  return b;
}

/** Record one render classification for a tool call (server-side intent). */
export function recordMapRenderEvent(
  host: string,
  tool: string,
  outcome: MapRenderOutcome,
  reasonCode: string,
): void {
  const key = host.trim() || "unknown-host";
  const b = bucketFor(key);
  b.total += 1;
  b.byOutcome[outcome] += 1;
  const reason = reasonCode.trim() || "none";
  b.byReason[reason] = (b.byReason[reason] ?? 0) + 1;
  const event: MapRenderEvent = {
    host: key,
    tool,
    outcome,
    reasonCode: reason,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify({ event: "mcp_map_render", ...event }));
}

/** Seat-readable snapshot for probes and GET /internal/map-render-metrics. */
export function snapshotMapRenderMetrics(): Record<
  string,
  {
    total: number;
    byOutcome: Record<MapRenderOutcome, number>;
    byReason: Record<string, number>;
  }
> {
  const out: Record<
    string,
    {
      total: number;
      byOutcome: Record<MapRenderOutcome, number>;
      byReason: Record<string, number>;
    }
  > = {};
  for (const [host, b] of buckets) {
    out[host] = {
      total: b.total,
      byOutcome: { ...b.byOutcome },
      byReason: { ...b.byReason },
    };
  }
  return out;
}

/** Test hook: reset counts between cases. */
export function resetMapRenderMetricsForTests(): void {
  buckets.clear();
}
