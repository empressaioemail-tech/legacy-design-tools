/**
 * Feasibility Study export (P-119 / OPS-16 A-103). Against hauska-engine-api
 * directly (see engine-client.ts for why there is no hauska-mcp-server tool
 * to proxy here instead).
 *
 * P-155 (OPS-23 FEASIBILITY, 2026-09-11): the engine's refresh route is now
 * ASYNCHRONOUS (hauska-engine PR #420) — it accepts a job (202) instead of
 * composing inline, because composition takes 85-154s for Travis parcels
 * (F7) while this connector's old REFRESH_TIMEOUT_MS=55_000 aborted first
 * and reported a bare, undeclared "aborted" text with no way for a caller
 * to tell a real failure from a report that was still cooking.
 *
 * The new shape, in one call:
 *   1. Read job STATUS first (never blindly re-refresh — a job already
 *      `ready` from a prior call must be served straight from that job,
 *      not recomposed from scratch on every poll).
 *   2. If nothing has ever been requested (or the prior job failed), POST
 *      refresh to start one.
 *   3. Poll status on the engine's own `pollAfterMs` inside THIS call's own
 *      budget (FEASIBILITY_POLL_BUDGET_MS) until `ready` or `failed`.
 *   4. Ready within budget -> download and return the PDF, exactly the old
 *      success shape. Not ready by budget's end -> a DECLARED in-progress
 *      result (`status: "in_progress"`, `isError: false` — this is a
 *      genuine answer, not a failure) carrying `{ tool, kind, state,
 *      jobRef, pollAfterMs }`, so a second call for the SAME parcel can
 *      check again and will find the job ready without starting another.
 *
 * EVERY outcome — not-configured, a thrown network error at any leg, a
 * non-OK HTTP response, a settled `failed` job — carries the same
 * `{ status, tool, kind, reason, message }` envelope now. The old bare
 * abort text (`engineThrewResult`) is retired: an agent caller could not
 * classify it as retryable, and there is nothing to retry manually now
 * that this function itself polls.
 */

import type { ToolResult } from "./tools-types.js";
import {
  buildEngineGateHeaders,
  loadEngineApiConfig,
  type EngineApiConfig,
} from "./engine-client.js";

const FEASIBILITY_PACKAGE_ID = "feasibility-export";
const FEASIBILITY_TOOL = "export_instrument";
const FEASIBILITY_KIND = "feasibility";

/** Budget for ACKNOWLEDGING a request (status read or refresh accept) — the
 * engine answers these in well under a second now that composition never
 * runs inline; generous headroom over that, never a budget for composition
 * itself. Kept well under FEASIBILITY_POLL_BUDGET_MS so the two ack calls
 * (status, then refresh when one is needed) plus the poll loop still land
 * comfortably inside a calling host's own tool-invocation timeout in the
 * worst case, not just the typical sub-second case. */
const ACK_TIMEOUT_MS = 10_000;
/** Budget for streaming the finished PDF once the job is ready. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * Total wall time THIS call spends polling before returning a declared
 * in-progress result instead of the PDF.
 *
 * MEASURED LIVE 2026-09-11 against the deployed async engine (P-155):
 * `export_instrument feasibility 48021:33223` through this exact
 * MCP tool returned "The operation timed out" — the CALLING HOST's own
 * tool-invocation timeout fired before this function's original 55s poll
 * budget (matching the old REFRESH_TIMEOUT_MS) had even elapsed, even
 * though the underlying engine job kept running and settled to `ready`
 * moments later (confirmed by a direct engine status read: started
 * 22:56:54Z, completed 22:57:48Z, 54s total). A host-side timeout shows
 * ITS OWN generic error, never this function's declared envelope — which
 * defeats the entire point of P-155 item 3 ("every error path on the MCP
 * side carries the same envelope; the bare abort text goes away"). No
 * budget value can guarantee catching every real job before it finishes
 * (jobs range 38-215s, also measured live 2026-09-11) -- the "call again"
 * pattern is unavoidable for most jobs regardless. The budget's real job
 * is staying safely under a calling host's own cap so THIS function's
 * response -- ready, failed, or the declared in-progress envelope -- is
 * what the host actually sees. Shortened from 55s to 20s accordingly.
 */
const FEASIBILITY_POLL_BUDGET_MS = 20_000;
const POLL_MIN_INTERVAL_MS = 3_000;
const POLL_MAX_INTERVAL_MS = 8_000;

export type FeasibilityExportArgs = {
  parcelNodeId: string;
};

export type FeasibilityExportDeps = {
  loadConfig?: () => EngineApiConfig | null;
  fetchImpl?: typeof fetch;
  /** Overrides FEASIBILITY_POLL_BUDGET_MS — test-only knob so a
   * still-running-at-budget-end test exercises the real branch in
   * milliseconds instead of the production 55s. */
  pollBudgetMs?: number;
};

/**
 * Declared "not configured" result — mirrors export-instrument.ts's
 * `exportHauskaDegradedResult` shape (status/tool/reason/message) so a
 * caller sees the same envelope family regardless of which upstream this
 * connector proxies. Honest about what IS built vs. what still needs an
 * operator to provision a secret (P-109's "starved" pattern).
 */
export function feasibilityNotConfiguredResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "degraded",
          tool: FEASIBILITY_TOOL,
          kind: FEASIBILITY_KIND,
          reason: "engine_api_not_configured",
          dependency: "hauska-engine-api",
          message:
            "Feasibility Study export is not configured on this server: engine-api gate credentials are missing (set HAUSKA_ENGINE_API_KEY and HAUSKA_ENGINE_API_URL). The upstream engine-api route already exists (hauska-engine PR #420, P-155 async refresh) — this is a deploy-configuration gap on smartsite-mcp, not a missing capability upstream.",
        }),
      },
    ],
    isError: true,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Every error/degraded/in-progress outcome from this file goes through
 * here — ONE envelope shape, per P-155 item 3 ("every error path on the
 * MCP side carries the same envelope"). */
function declaredResult(input: {
  status: "error" | "in_progress";
  isError: boolean;
  reason?: string;
  message?: string;
  extra?: Record<string, unknown>;
}): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: input.status,
          tool: FEASIBILITY_TOOL,
          kind: FEASIBILITY_KIND,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.message ? { message: input.message } : {}),
          ...input.extra,
        }),
      },
    ],
    isError: input.isError,
  };
}

function engineThrewDeclaredResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return declaredResult({ status: "error", isError: true, reason: "engine_unreachable", message });
}

/**
 * AbortController + setTimeout, matching hauska-client.ts's own
 * `probeHauskaMcpHealth` pattern exactly — this package's tsconfig carries
 * no DOM lib, so `AbortSignal.timeout` (a lib.dom.d.ts-only static in some
 * TS/Node type combinations) is avoided in favor of the already-proven
 * pattern already shipping in this same package.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPollInterval(pollAfterMs: unknown): number {
  const ms = typeof pollAfterMs === "number" && Number.isFinite(pollAfterMs) ? pollAfterMs : POLL_MIN_INTERVAL_MS;
  return Math.min(POLL_MAX_INTERVAL_MS, Math.max(POLL_MIN_INTERVAL_MS, ms));
}

type JobState = "never-requested" | "queued" | "running" | "ready" | "failed";

interface StatusRead {
  state: JobState;
  jobRef?: string;
  pollAfterMs?: number;
  errorClass?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
}

async function readStatus(
  parcelPath: string,
  headers: Record<string, string>,
  config: EngineApiConfig,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; status: StatusRead } | { ok: false; result: ToolResult }> {
  let res: Response;
  const t = timeoutSignal(ACK_TIMEOUT_MS);
  try {
    res = await fetchImpl(`${config.baseUrl}${parcelPath}`, { headers, signal: t.signal });
  } catch (err) {
    return { ok: false, result: engineThrewDeclaredResult(err) };
  } finally {
    t.clear();
  }
  const body = asRecord(await res.json().catch(() => ({})));
  if (!res.ok) {
    return {
      ok: false,
      result: declaredResult({
        status: "error",
        isError: true,
        reason: typeof body.error === "string" ? body.error : "upstream_error",
        message: typeof body.message === "string" ? body.message : `engine ${res.status}`,
      }),
    };
  }
  const state = typeof body.state === "string" ? (body.state as JobState) : "never-requested";
  return {
    ok: true,
    status: {
      state,
      jobRef: typeof body.jobRef === "string" ? body.jobRef : undefined,
      pollAfterMs: typeof body.pollAfterMs === "number" ? body.pollAfterMs : undefined,
      errorClass: typeof body.errorClass === "string" ? body.errorClass : undefined,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
      result: typeof body.result === "object" && body.result ? asRecord(body.result) : undefined,
    },
  };
}

async function downloadReady(
  parcelNodeId: string,
  parcelPath: string,
  headers: Record<string, string>,
  config: EngineApiConfig,
  fetchImpl: typeof fetch,
  result: Record<string, unknown> | undefined,
): Promise<ToolResult> {
  let downloadRes: Response;
  const t = timeoutSignal(DOWNLOAD_TIMEOUT_MS);
  try {
    downloadRes = await fetchImpl(`${config.baseUrl}${parcelPath}/download`, {
      headers,
      signal: t.signal,
    });
  } catch (err) {
    return engineThrewDeclaredResult(err);
  } finally {
    t.clear();
  }

  if (downloadRes.status === 404 || downloadRes.status === 410 || downloadRes.status === 422) {
    const body = asRecord(await downloadRes.json().catch(() => ({})));
    return declaredResult({
      status: "error",
      isError: true,
      reason:
        typeof body.error === "string"
          ? body.error
          : downloadRes.status === 410
            ? "artifact_evicted"
            : "artifact_unavailable",
      message: typeof body.message === "string" ? body.message : undefined,
    });
  }
  if (!downloadRes.ok) {
    const text = await downloadRes.text().catch(() => "");
    return declaredResult({
      status: "error",
      isError: true,
      reason: "upstream_error",
      message: text || `engine ${downloadRes.status}`,
    });
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          tool: FEASIBILITY_TOOL,
          kind: FEASIBILITY_KIND,
          parcelNodeId,
          format: "pdf-feasibility",
          download: {
            format: "pdf-feasibility",
            contentType: "application/pdf",
            base64,
            byteCount: arrayBuffer.byteLength,
          },
          pageCount: result?.pageCount,
          feasibilityPageCount: result?.feasibilityPageCount,
          sitePlanAppended: result?.sitePlanAppended,
          sitePlanUnavailableReason: result?.sitePlanUnavailableReason,
          sectionCount: result?.sectionCount,
          openItemCount: result?.openItemCount,
          narrativeIsDeterministicSkeleton: result?.narrativeIsDeterministicSkeleton,
        }),
      },
    ],
    isError: false,
  };
}

export async function executeFeasibilityExport(
  args: FeasibilityExportArgs,
  deps: FeasibilityExportDeps = {},
): Promise<ToolResult> {
  const loadConfig = deps.loadConfig ?? loadEngineApiConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const config = loadConfig();
  if (!config) return feasibilityNotConfiguredResult();

  const parcelPath = `/v1/property-nodes/${encodeURIComponent(args.parcelNodeId)}/feasibility-export`;
  const headers = {
    Authorization: `Bearer ${config.gateToken}`,
    ...buildEngineGateHeaders({ packageId: FEASIBILITY_PACKAGE_ID }),
  };

  // 1) Check status FIRST — a job already `ready` from a prior call (this
  // is exactly the "second call" the customer-facing predicate depends on)
  // must be served from that job, never recomposed.
  const first = await readStatus(parcelPath, headers, config, fetchImpl);
  if (!first.ok) return first.result;
  let current = first.status;

  // 2) Nothing in flight and nothing to serve -> start a job. A `failed`
  // job is also re-tried here rather than reported stale forever.
  if (current.state === "never-requested" || current.state === "failed") {
    let refreshRes: Response;
    const t = timeoutSignal(ACK_TIMEOUT_MS);
    try {
      refreshRes = await fetchImpl(`${config.baseUrl}${parcelPath}/refresh`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
        signal: t.signal,
      });
    } catch (err) {
      return engineThrewDeclaredResult(err);
    } finally {
      t.clear();
    }
    if (refreshRes.status === 422) {
      // The engine's own honest, SYNCHRONOUS refusal (e.g. no resolvable
      // site plan for this parcel at all) — never mapped onto a generic
      // error, never a fabricated report.
      const body = asRecord(await refreshRes.json().catch(() => ({})));
      return declaredResult({
        status: "error",
        isError: true,
        reason: "feasibility_export_failed",
        message:
          typeof body.message === "string"
            ? body.message
            : "Feasibility study could not be produced for this parcel.",
      });
    }
    if (!refreshRes.ok) {
      const text = await refreshRes.text().catch(() => "");
      return declaredResult({
        status: "error",
        isError: true,
        reason: "upstream_error",
        message: text || `engine ${refreshRes.status}`,
      });
    }
    const body = asRecord(await refreshRes.json().catch(() => ({})));
    current = {
      state: body.state === "queued" || body.state === "running" ? (body.state as JobState) : "queued",
      jobRef: typeof body.jobRef === "string" ? body.jobRef : undefined,
      pollAfterMs: typeof body.pollAfterMs === "number" ? body.pollAfterMs : undefined,
    };
  }

  // 3) Poll inside this call's own budget.
  const deadline = Date.now() + (deps.pollBudgetMs ?? FEASIBILITY_POLL_BUDGET_MS);
  while (current.state !== "ready" && current.state !== "failed" && Date.now() < deadline) {
    await sleep(clampPollInterval(current.pollAfterMs));
    const next = await readStatus(parcelPath, headers, config, fetchImpl);
    if (!next.ok) return next.result;
    current = next.status;
  }

  if (current.state === "ready") {
    return downloadReady(args.parcelNodeId, parcelPath, headers, config, fetchImpl, current.result);
  }
  if (current.state === "failed") {
    return declaredResult({
      status: "error",
      isError: true,
      reason: current.errorClass ?? "compose_failed",
      message: current.errorMessage ?? "Feasibility study could not be produced for this parcel.",
    });
  }

  // 4) Still queued/running at the budget's end — a DECLARED in-progress
  // answer (isError: false: the call itself succeeded at learning the
  // state), never a bare abort. Call again with the same parcelNodeId to
  // pick it up once ready.
  return declaredResult({
    status: "in_progress",
    isError: false,
    extra: {
      state: current.state,
      jobRef: current.jobRef,
      pollAfterMs: current.pollAfterMs ?? POLL_MIN_INTERVAL_MS,
      message:
        "Feasibility Study is still being generated. Call export_instrument again with the same parcelNodeId to check.",
    },
  });
}
