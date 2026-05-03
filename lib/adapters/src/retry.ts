/**
 * Shared retry helper for adapter HTTP calls.
 *
 * Retries only transient upstream failures: HTTP 408/429/5xx and
 * network resets / unattributed AbortErrors. Hard 4xx responses are
 * returned on the first try. Caller-driven aborts propagate
 * immediately as `timeout`.
 */
import { AdapterRunError } from "./types";

/** HTTP statuses we treat as transient and retryable. */
export const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 502, 503, 504,
]);

export interface FetchWithRetryOptions {
  /** Hard cap on attempts (initial try + retries). Default: 3. */
  maxAttempts?: number;
  /** Base delay between retries in ms (jittered). Default: 250. */
  baseDelayMs?: number;
  /** Max delay between retries in ms. Default: 2_000. */
  maxDelayMs?: number;
  /** Caller's abort signal — if it fires we bail immediately. */
  signal?: AbortSignal;
  /** Injected fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Injected sleep (for tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Friendly upstream label used in failure messages. */
  upstreamLabel?: string;
}

/**
 * Returned by {@link fetchWithRetry} on success. Carries the final
 * `Response` plus the count of attempts taken so callers can include
 * it in their on-failure error message ("retried N times").
 */
export interface FetchWithRetryResult {
  response: Response;
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isCallerAbort(signal: AbortSignal | undefined): boolean {
  return Boolean(signal && signal.aborted);
}

/** Heuristic for "this fetch failure looks like a network reset / blip". */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg) return false;
  // node:undici surfaces resets as a TypeError with cause.code = "..."
  // and message "fetch failed" / "terminated"; the broader regex below
  // catches the codes that bubble up directly too.
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|terminated|fetch failed|socket hang up|network|ENETUNREACH/i.test(
    msg,
  );
}

/** Heuristic: the only safe time to treat an "aborted" throw as
 *  retryable is when the caller's own signal did NOT trigger it.
 *  Anything aborted by us must propagate immediately. */
function isUnattributedAbort(err: unknown, callerAborted: boolean): boolean {
  if (callerAborted) return false;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (err instanceof Error && /This operation was aborted/i.test(err.message))
    return true;
  return false;
}

function jitteredBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  // Exponential: base * 2^(attempt-1), capped at maxMs, with +/- 25%
  // jitter so a thundering herd of adapters do not all retry at the
  // same instant.
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const cap = Math.min(exp, maxMs);
  const jitter = cap * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cap + jitter));
}

/**
 * Drop-in `fetch` replacement that retries transient failures with
 * exponential backoff + jitter. Returns the `Response` for a successful
 * (or terminally-failed) attempt; the caller is responsible for
 * checking `response.ok` for non-transient HTTP errors (e.g. 400, 404).
 *
 * On final give-up after exhausting retries, throws an
 * {@link AdapterRunError} whose message names the upstream + retry
 * count so the on-screen failure pill is actionable. The error code is
 * one of `network-error`, `timeout`, or `upstream-error` so existing
 * FE branching keeps working.
 */
export async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  opts: FetchWithRetryOptions = {},
): Promise<FetchWithRetryResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.baseDelayMs ?? 250;
  const maxMs = opts.maxDelayMs ?? 2_000;
  const label = opts.upstreamLabel ?? "Upstream";

  // Forward the caller's signal into every attempt so the per-adapter
  // timeout in the runner wins — we never retry past a caller abort.
  const reqInit: RequestInit = { ...init, signal: opts.signal ?? init?.signal };

  let lastTransientStatus: number | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCallerAbort(opts.signal)) {
      throw new AdapterRunError(
        "timeout",
        `${label} request was cancelled by the caller before attempt ${attempt}.`,
      );
    }
    let res: Response;
    try {
      res = await fetchFn(input, reqInit);
    } catch (err) {
      // Caller aborted mid-flight: surface as timeout, no retry.
      if (isCallerAbort(opts.signal)) {
        throw new AdapterRunError(
          "timeout",
          `${label} request was cancelled by the caller during attempt ${attempt}.`,
        );
      }
      const transient =
        isTransientNetworkError(err) || isUnattributedAbort(err, false);
      if (!transient || attempt === maxAttempts) {
        throw new AdapterRunError(
          "network-error",
          `${label} request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${err instanceof Error ? err.message : String(err)}. Use Force refresh to retry.`,
        );
      }
      lastNetworkError = err;
      await sleep(jitteredBackoff(attempt, baseMs, maxMs));
      continue;
    }
    // Retryable HTTP statuses → backoff + try again.
    if (TRANSIENT_STATUS_CODES.has(res.status)) {
      lastTransientStatus = res.status;
      if (attempt === maxAttempts) {
        return { response: res, attempts: attempt };
      }
      // Drain the body so the connection can be reused.
      try {
        await res.text();
      } catch {
        // ignore — we're just freeing the socket.
      }
      await sleep(jitteredBackoff(attempt, baseMs, maxMs));
      continue;
    }
    return { response: res, attempts: attempt };
  }
  // Unreachable — the loop returns or throws on every iteration. The
  // explicit throw keeps TypeScript happy and gives a sane crash if
  // the loop logic is ever broken.
  throw new AdapterRunError(
    "upstream-error",
    `${label} retry loop exited unexpectedly (last status ${lastTransientStatus ?? "n/a"}, lastErr ${lastNetworkError ? String(lastNetworkError) : "n/a"}). Use Force refresh to retry.`,
  );
}
