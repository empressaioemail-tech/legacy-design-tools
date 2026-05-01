/**
 * Adapter runner — fans out a set of adapters against an engagement's
 * parcel context, isolates per-adapter failures (Spec 51 §4 / locked
 * decision #6), and returns one outcome per adapter.
 *
 * The runner does NOT touch the database. Persistence happens in the
 * `routes/generateLayers` route which translates the runner's outcomes
 * into `briefing_sources` rows. Keeping IO out of the runner keeps it
 * trivially testable and lets the same code path drive a future "dry
 * run" preview UI without writing rows.
 */

import {
  type Adapter,
  type AdapterContext,
  type AdapterError,
  type AdapterRunOutcome,
  AdapterRunError,
} from "./types";

/** Default per-adapter network timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface RunAdaptersInput {
  adapters: ReadonlyArray<Adapter>;
  context: AdapterContext;
}

export async function runAdapters(
  input: RunAdaptersInput,
): Promise<AdapterRunOutcome[]> {
  const { adapters, context } = input;
  // Filter first so the per-adapter timeout doesn't fire on adapters
  // that are gated out before they ever touch the network.
  const applicable = adapters.filter((a) => a.appliesTo(context));
  // Adapters that aren't applicable still appear in the outcome list as
  // `no-coverage` so the UI can render a complete tier table — Empressa
  // wants to see "we tried this layer but it doesn't cover this parcel"
  // rather than silently dropping the row.
  const skipped: AdapterRunOutcome[] = adapters
    .filter((a) => !a.appliesTo(context))
    .map((a) => ({
      adapterKey: a.adapterKey,
      tier: a.tier,
      layerKind: a.layerKind,
      status: "no-coverage" as const,
      error: {
        code: "no-coverage",
        message: `${a.adapterKey} not applicable for this jurisdiction.`,
      },
    }));
  // Run applicable adapters in parallel — they hit different upstream
  // services so there's no rate-limit concern, and the user-facing
  // "Generate Layers" call should be as snappy as the slowest adapter.
  const ran = await Promise.all(
    applicable.map((adapter) => runOne(adapter, context)),
  );
  return [...ran, ...skipped];
}

async function runOne(
  adapter: Adapter,
  context: AdapterContext,
): Promise<AdapterRunOutcome> {
  const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // Plumb the caller's signal through too — if the request handler
  // aborts (client disconnect / route timeout), every in-flight adapter
  // sees it.
  const externalSignal = context.signal;
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener("abort", () => ac.abort());
  }

  try {
    const result = await adapter.run({ ...context, signal: ac.signal });
    return {
      adapterKey: adapter.adapterKey,
      tier: adapter.tier,
      layerKind: adapter.layerKind,
      status: "ok",
      result,
    };
  } catch (err) {
    const error = toAdapterError(err, ac.signal.aborted, timeoutMs);
    // Normalize: an adapter that ran but determined the parcel is not
    // covered by the upstream feed (throws AdapterRunError with
    // code="no-coverage") is semantically the same outcome as an
    // adapter the runner skipped because `appliesTo` returned false —
    // both translate to a `no-coverage` status on the wire so the UI
    // can render a single neutral pill instead of a misleading
    // "failed" badge.
    const status: "no-coverage" | "failed" =
      error.code === "no-coverage" ? "no-coverage" : "failed";
    return {
      adapterKey: adapter.adapterKey,
      tier: adapter.tier,
      layerKind: adapter.layerKind,
      status,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

function toAdapterError(
  err: unknown,
  aborted: boolean,
  timeoutMs: number,
): AdapterError {
  if (err instanceof AdapterRunError) {
    return { code: err.code, message: err.message };
  }
  // AbortError shows up as a DOMException with name="AbortError" when
  // we cancel via the controller. Translate to a stable `timeout` code
  // so the UI can render "this layer timed out — retry".
  if (
    aborted ||
    (err instanceof Error && err.name === "AbortError") ||
    (err instanceof Error && /aborted/i.test(err.message))
  ) {
    return {
      code: "timeout",
      message: `Adapter exceeded ${timeoutMs}ms and was cancelled.`,
    };
  }
  if (err instanceof Error) {
    // Best-effort categorization — anything that looks like a fetch
    // failure becomes `network-error`, everything else is `unknown`.
    const looksLikeFetch =
      err.name === "TypeError" || /fetch|network|ENOTFOUND|ECONN/i.test(err.message);
    return {
      code: looksLikeFetch ? "network-error" : "unknown",
      message: err.message || "Adapter run failed",
    };
  }
  return { code: "unknown", message: "Adapter run failed (non-Error throw)" };
}
