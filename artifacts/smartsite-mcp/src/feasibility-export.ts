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
 *   2. If nothing has ever been requested, the prior job failed, or the
 *      prior job is `ready` but STALE (see below), POST refresh to start
 *      a new one.
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
 *
 * P-155 WAVE-5 ADDENDUM (F23, overseer 2026-09-13): "read status first,
 * skip refresh on ready" above was correct for the case it was built for
 * (a caller re-invoking to continue polling a job it JUST started) but had
 * no way to tell that apart from "this ready job is hours/days old and
 * unrelated" — the engine's own feasibility_export_jobs row has NO TTL
 * (one row per parcelNodeId, permanent once ready; see
 * hauska-engine/packages/storage/migrations/013_feasibility_export_jobs.sql).
 * The result, confirmed live in production for 48021:34049 (CP1,
 * _inbox/2026-09-13_p155-refresh_cp1.json): once a job first reaches
 * `ready`, export_instrument could NEVER produce a new document for that
 * parcel again, no matter how much time passed or how many engine deploys
 * landed — POST refresh was simply never called again. Fixed by treating a
 * `ready` job as needing a fresh refresh when its `completedAt` is older
 * than FEASIBILITY_READY_REUSE_WINDOW_MS (see below) — recent-enough-to-be-
 * a-continuation is still served straight from the job (unchanged, still
 * covered by this file's existing tests); genuinely stale triggers real
 * recomposition, same as `failed`. A `ready` job with NO completedAt at all
 * (the one legacy case: a pre-P-155 atom with an artifact on file but no
 * job row) is treated as not-stale — vanishingly rare in practice, and
 * consistent with this file's existing "no entitlement marker at all ->
 * backward compatible, never a crash" posture. `generatedAt` now rides
 * beside the bytes in the success envelope (sourced from the engine's
 * `X-Feasibility-Generated-At` download header when present, else the
 * status read's own completedAt) so a caller can see the served document's
 * actual age without guessing.
 */

import type { ToolResult } from "./tools-types.js";
import {
  buildEngineGateHeaders,
  loadEngineApiConfig,
  type EngineApiConfig,
} from "./engine-client.js";
import { refuseStudioReport, type SmartsiteEntitlementSnapshot } from "./entitlement.js";

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
/**
 * P-155 wave-5 (F23). A `ready` job whose `completedAt` is within this
 * window of "now" is treated as a live continuation of a job THIS caller
 * (or one moments before it) just triggered, and is served straight from
 * the job with no new refresh — the original, still-correct P-155 intent.
 * Older than this, it is treated as stale and a fresh refresh is issued
 * instead of silently re-serving old bytes.
 *
 * Set well above the slowest composition observed live (629.6s / ~10.5 min,
 * 48453:113408, wave-1 P-155 close profiling) so a caller genuinely still
 * polling a real in-flight-turned-ready job is never mistaken for asking
 * for a fresh one, while anything on the order of hours/days (the actual
 * F23 symptom: PDFs served identically 4+ hours and 7+ separate call pairs
 * after the one job that ever produced them) is unambiguously stale.
 */
const FEASIBILITY_READY_REUSE_WINDOW_MS = 15 * 60_000;

export type FeasibilityExportArgs = {
  parcelNodeId: string;
  /**
   * P152-ENTITLEMENT (OPS-23 wave 4, CP1 approved 2026-09-13). REQUIRED,
   * never defaulted inside this file: the caller (tools.ts) already ran
   * the local Studio/property-unlock gate before ever reaching this
   * function, so it always passes "public-paid" here today -- but the
   * value must be threaded explicitly rather than assumed, so a future
   * call site that skips that gate sends "public-free" and the engine's
   * own independent tier check refuses it (defense in depth).
   */
  callerTier: "public-free" | "public-paid";
  /**
   * The caller's local entitlement snapshot -- carried only so a refusal
   * from the ENGINE'S OWN gate (an outcome the local gate above did not
   * expect, since it already said yes) can be surfaced in the SAME
   * upgrade_required/EntitlementGateRefusal shape every other refusal in
   * this connector uses, per the mission's "surface the engine's typed
   * refusal as the MCP's own refused with upgrade_required" requirement.
   */
  entitlement: SmartsiteEntitlementSnapshot;
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

/** P152-ENTITLEMENT (OPS-23 wave 4): the engine's own typed marker (CP1 Q4)
 * -- present on the GET status response regardless of job state, reflecting
 * the CURRENT request's tier as the engine resolved it (not necessarily the
 * tier the artifact was originally composed under; see this lane's close
 * for the cache-hit caveat). */
interface EngineEntitlementMarker {
  tier?: string;
  granted: boolean;
  requiredTier?: string;
  gatedSections?: readonly string[];
}

interface StatusRead {
  state: JobState;
  jobRef?: string;
  pollAfterMs?: number;
  errorClass?: string;
  errorMessage?: string;
  result?: Record<string, unknown>;
  entitlement?: EngineEntitlementMarker;
  /** P-155 wave-5 (F23). When present on a `ready` job, this is when THAT
   * job's composition finished (the engine's job row completedAt) — used
   * both to decide staleness (see FEASIBILITY_READY_REUSE_WINDOW_MS) and,
   * on success, surfaced to the caller as `generatedAt`. Absent only for
   * the legacy no-job-row case. */
  completedAt?: string;
}

/** P-155 wave-5 (F23). True exactly when a `ready` job's own completedAt is
 * old enough that serving it without a fresh refresh would be presenting
 * stale bytes as current. A `ready` job with no completedAt at all (the
 * legacy no-job-row case) is NOT stale — see the module doc. */
function isStaleReadyJob(status: StatusRead, now: number = Date.now()): boolean {
  if (status.state !== "ready" || !status.completedAt) return false;
  const completedAtMs = Date.parse(status.completedAt);
  if (!Number.isFinite(completedAtMs)) return false;
  return now - completedAtMs > FEASIBILITY_READY_REUSE_WINDOW_MS;
}

/** Mirrors tools.ts's own `upgradeRequiredResult` exactly (duplicated
 * rather than imported, matching this codebase's established per-file
 * pattern for this same tiny helper -- see recordsExtraction.ts's own
 * copy). Used only for the ENGINE's OWN refusal, an outcome the local gate
 * in tools.ts did not expect since it already said yes; every OTHER
 * refusal in this file keeps its existing `declaredResult` shape. */
function engineUpgradeRequiredResult(entitlement: SmartsiteEntitlementSnapshot): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(refuseStudioReport(entitlement)) }],
    isError: true,
  };
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
  const rawEntitlement = asRecord(body.entitlement);
  const entitlement: EngineEntitlementMarker | undefined =
    typeof rawEntitlement.granted === "boolean"
      ? {
          tier: typeof rawEntitlement.tier === "string" ? rawEntitlement.tier : undefined,
          granted: rawEntitlement.granted,
          requiredTier: typeof rawEntitlement.requiredTier === "string" ? rawEntitlement.requiredTier : undefined,
          gatedSections: Array.isArray(rawEntitlement.gatedSections)
            ? (rawEntitlement.gatedSections as string[])
            : undefined,
        }
      : undefined;
  return {
    ok: true,
    status: {
      state,
      jobRef: typeof body.jobRef === "string" ? body.jobRef : undefined,
      pollAfterMs: typeof body.pollAfterMs === "number" ? body.pollAfterMs : undefined,
      errorClass: typeof body.errorClass === "string" ? body.errorClass : undefined,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
      result: typeof body.result === "object" && body.result ? asRecord(body.result) : undefined,
      entitlement,
      completedAt: typeof body.completedAt === "string" ? body.completedAt : undefined,
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
  /** P-155 wave-5 (F23). Fallback source for `generatedAt` when the
   * download response carries no X-Feasibility-Generated-At header (e.g.
   * an older engine deploy) — the last status read's own completedAt. */
  knownCompletedAt?: string,
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
  // P-155 wave-5 (F23): the download response itself is the freshest,
  // most authoritative source for the served document's age (read at the
  // exact moment the bytes were fetched, not from an earlier separate
  // status call that could theoretically race a concurrent refresh). Fall
  // back to the status leg's own completedAt only when the header is
  // absent (e.g. an older engine deploy that predates this header).
  const generatedAt = downloadRes.headers.get("x-feasibility-generated-at") ?? knownCompletedAt ?? undefined;

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
          ...(generatedAt ? { generatedAt } : {}),
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
    ...buildEngineGateHeaders({ packageId: FEASIBILITY_PACKAGE_ID, callerTier: args.callerTier }),
  };

  // 1) Check status FIRST — a job already `ready` from a prior call (this
  // is exactly the "second call" the customer-facing predicate depends on)
  // must be served from that job, never recomposed.
  const first = await readStatus(parcelPath, headers, config, fetchImpl);
  if (!first.ok) return first.result;
  let current = first.status;

  // 2) Nothing in flight and nothing to serve -> start a job. A `failed`
  // job is also re-tried here rather than reported stale forever. P-155
  // wave-5 (F23): a `ready` job past FEASIBILITY_READY_REUSE_WINDOW_MS is
  // ALSO re-tried here -- without this, once any job for a parcel first
  // reaches ready, refresh is never called again and the same bytes are
  // served forever, no matter how old (the exact production symptom this
  // fix addresses; see CP1 for the live log trail).
  if (current.state === "never-requested" || current.state === "failed" || isStaleReadyJob(current)) {
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
    // P152-ENTITLEMENT (OPS-23 wave 4, CP1 approved 2026-09-13): the
    // engine's own gate is the SOURCE OF TRUTH here, checked independently
    // of this connector's own local Studio/property-unlock gate in
    // tools.ts (which already passed by the time this function was ever
    // called -- reaching `granted: false` here means the two disagree,
    // which should not happen in normal operation and is exactly the
    // defense-in-depth case this lane exists for). Surfaced in the SAME
    // upgrade_required/EntitlementGateRefusal vocabulary every other
    // refusal in this connector already publishes, per the mission's own
    // "surface the engine's typed refusal as the MCP's own refused with
    // upgrade_required" requirement -- never the PDF, never a bare
    // upstream error, never a silent pass-through of an already-redacted
    // body as if it were an ordinary success.
    if (current.entitlement && current.entitlement.granted === false) {
      return engineUpgradeRequiredResult(args.entitlement);
    }
    return downloadReady(args.parcelNodeId, parcelPath, headers, config, fetchImpl, current.result, current.completedAt);
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
