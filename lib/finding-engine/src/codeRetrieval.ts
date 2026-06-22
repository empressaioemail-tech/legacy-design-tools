/**
 * Code-retrieval seam for plan-review finding generation.
 *
 * The finding engine does not fetch ICC atoms itself — callers retrieve via
 * `lib/codes` and pass `codeSections` + `codeRetrieval` on the input bundle.
 * `BRIEF_CODE_RETRIEVAL=gate` (substrate) is the standard anti-hallucination
 * path; `neon` is the local-corpus fallback when the gate is unavailable.
 */

import type { RetrievalUsageEvent } from "./types";

export type CodeRetrievalMode = "gate" | "mcp" | "neon";

/** Resolve the effective retrieval mode from env (default `neon`). */
export function resolveCodeRetrievalMode(): CodeRetrievalMode {
  const raw = (process.env.BRIEF_CODE_RETRIEVAL ?? "neon").toLowerCase();
  if (raw === "gate") return "gate";
  if (raw === "mcp") return "mcp";
  return "neon";
}

/** Whether the env points at the gate substrate seam. */
export function isGateCodeRetrievalMode(): boolean {
  const mode = resolveCodeRetrievalMode();
  return mode === "gate" || mode === "mcp";
}

/** Build one per-query usage event from a retrieval pass. */
export function buildRetrievalUsageEvent(args: {
  query: string;
  retrievedAtomIds: ReadonlyArray<string>;
  retrievalMode: string;
  occurredAt?: Date;
  surfaceKey?: string;
}): RetrievalUsageEvent {
  return {
    query: args.query,
    retrievedAtomIds: [...args.retrievedAtomIds],
    retrievalMode: args.retrievalMode,
    occurredAt: (args.occurredAt ?? new Date()).toISOString(),
    ...(args.surfaceKey ? { surfaceKey: args.surfaceKey } : {}),
  };
}

/** Merge usage events from orchestrated specialist passes (dedupe by query). */
export function mergeRetrievalUsageEvents(
  batches: ReadonlyArray<ReadonlyArray<RetrievalUsageEvent>>,
): RetrievalUsageEvent[] {
  const byQuery = new Map<string, RetrievalUsageEvent>();
  for (const batch of batches) {
    for (const event of batch) {
      const existing = byQuery.get(event.query);
      if (!existing) {
        byQuery.set(event.query, event);
        continue;
      }
      const mergedIds = new Set([
        ...existing.retrievedAtomIds,
        ...event.retrievedAtomIds,
      ]);
      byQuery.set(event.query, {
        ...existing,
        retrievedAtomIds: [...mergedIds],
        retrievalMode: event.retrievalMode || existing.retrievalMode,
      });
    }
  }
  return [...byQuery.values()];
}
