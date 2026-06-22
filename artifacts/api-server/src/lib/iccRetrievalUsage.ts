/**
 * Best-effort emission of per-query retrieval usage to the gate seam so
 * cc-agent-M's `content_usage` / `pay_per_query` views record ICC activity.
 *
 * Primary metering happens on substrate `GET /search` via gate-front headers
 * (`x-hauska-access-tier`, `x-hauska-product`, `x-hauska-jurisdiction-tenant`).
 * This helper mirrors the event batch for observability when a dedicated
 * usage ingest endpoint is configured.
 */

import type { RetrievalUsageEvent } from "@workspace/finding-engine";
import { logger } from "./logger";

function resolveUsageIngestUrl(): string | null {
  for (const envName of [
    "BRIEF_RETRIEVAL_USAGE_URL",
    "HAUSKA_GATE_USAGE_URL",
  ]) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw.replace(/\/$/, "");
  }
  const base = process.env.BRIEF_RETRIEVAL_API_URL?.trim();
  if (base) return `${base.replace(/\/$/, "")}/usage`;
  return null;
}

function resolveUsageApiKey(): string | null {
  for (const envName of [
    "BRIEF_RETRIEVAL_API_KEY",
    "RETRIEVAL_API_KEY",
    "HAUSKA_ENGINE_API_KEY",
    "SERVICE_API_KEY",
  ]) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw;
  }
  return null;
}

/** Post retrieval usage events to the gate usage ingest (best-effort). */
export async function emitRetrievalUsageToGate(
  events: ReadonlyArray<RetrievalUsageEvent>,
  log: typeof logger = logger,
): Promise<void> {
  if (events.length === 0) return;

  const url = resolveUsageIngestUrl();
  if (!url) {
    log.debug(
      { eventCount: events.length, surfaceKeys: events.map((e) => e.surfaceKey) },
      "icc retrieval usage: no usage ingest URL — gate /search headers only",
    );
    return;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const apiKey = resolveUsageApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn(
        { status: res.status, eventCount: events.length },
        "icc retrieval usage: gate usage ingest HTTP error",
      );
      return;
    }
    log.info(
      { eventCount: events.length },
      "icc retrieval usage: gate usage ingest accepted",
    );
  } catch (err) {
    log.warn(
      { err, eventCount: events.length },
      "icc retrieval usage: gate usage ingest failed",
    );
  }
}
