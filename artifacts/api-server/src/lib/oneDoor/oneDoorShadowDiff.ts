/**
 * ONE DOOR shadow mode (§2 "shadow"): the surface serves its old answer AND
 * reads the reader, then posts one row per fact whose shown answer differs
 * from the reader's to the reader's shadow-diff sink (`one_door_shadow_diff`:
 * county, parcel, surface, fact, old shown, reader state/value).
 *
 * Guarantees, each pinned by a test:
 *   - never on the response path: `enqueueOneDoorShadowDiffs` returns
 *     synchronously and the POST happens on a later timer tick;
 *   - batched: rows are buffered and sent in one POST per flush;
 *   - tolerant: an absent endpoint (404/405/501) disables posting for a while,
 *     any other failure drops the batch; nothing ever throws to a caller.
 *
 * The sink path is WP-R's writer endpoint. `ONE_DOOR_SHADOW_DIFF_PATH`
 * overrides the default below if WP-R publishes a different path.
 */

import { logger } from "../logger";
import { oneDoorReaderEndpoint, type OneDoorState } from "./oneDoorReaderClient";

export type OneDoorSurface = "cortex-facets" | "cortex-brief";

/** What the old door showed, normalised onto the reader's vocabulary where it can be. */
export type OneDoorShownAnswer = {
  /** One of the seven states when the old door's state maps onto one; else the old token. */
  state: OneDoorState | `old:${string}`;
  value?: unknown;
  words?: string | null;
};

export type OneDoorShadowDiffRow = {
  countyFips: string | null;
  parcelNodeId: string;
  surface: OneDoorSurface;
  fact: string;
  oldShown: OneDoorShownAnswer;
  reader: { state: OneDoorState; value?: unknown; words: string };
  /** Which of state / value / words differed. */
  differs: Array<"state" | "value" | "words">;
  observedAt: string;
};

const DEFAULT_PATH = "/one-door/shadow-diff";
const FLUSH_DELAY_MS = 2000;
const MAX_BATCH = 200;
const MAX_BUFFER = 5000;
const ABSENT_BACKOFF_MS = 10 * 60 * 1000;

export type OneDoorShadowDiffPoster = (rows: OneDoorShadowDiffRow[]) => Promise<{ status: number } | null>;

const defaultPoster: OneDoorShadowDiffPoster = async (rows) => {
  const endpoint = oneDoorReaderEndpoint();
  if (!endpoint) return null;
  const path = process.env.ONE_DOOR_SHADOW_DIFF_PATH?.trim() || DEFAULT_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${endpoint.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ diffs: rows }),
      signal: controller.signal,
    });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
};

let poster: OneDoorShadowDiffPoster = defaultPoster;
let buffer: OneDoorShadowDiffRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let disabledUntil = 0;
let inFlight: Promise<void> = Promise.resolve();

async function flushNow(): Promise<void> {
  timer = null;
  while (buffer.length) {
    const batch = buffer.splice(0, MAX_BATCH);
    if (Date.now() < disabledUntil) {
      buffer = [];
      return;
    }
    try {
      const res = await poster(batch);
      if (res && (res.status === 404 || res.status === 405 || res.status === 501)) {
        disabledUntil = Date.now() + ABSENT_BACKOFF_MS;
        buffer = [];
        logger.info({ status: res.status }, "one_door_shadow_diff_sink_absent");
        return;
      }
      if (res && (res.status < 200 || res.status >= 300)) {
        logger.warn({ status: res.status, rows: batch.length }, "one_door_shadow_diff_post_failed");
      }
    } catch (err) {
      logger.warn({ err, rows: batch.length }, "one_door_shadow_diff_post_error");
    }
  }
}

/**
 * Queue diff rows. Returns immediately; never throws; never awaits I/O.
 * Rows past the buffer cap are dropped (shadow evidence is best-effort and
 * must never grow memory without bound).
 */
export function enqueueOneDoorShadowDiffs(rows: readonly OneDoorShadowDiffRow[]): void {
  try {
    if (!rows.length || Date.now() < disabledUntil) return;
    const room = MAX_BUFFER - buffer.length;
    if (room <= 0) return;
    buffer.push(...rows.slice(0, room));
    if (!timer) {
      timer = setTimeout(() => {
        inFlight = inFlight.then(flushNow, flushNow);
      }, FLUSH_DELAY_MS);
      // Never keep the process alive for shadow evidence.
      (timer as { unref?: () => void }).unref?.();
    }
  } catch {
    // Shadow mode must never affect the response.
  }
}

/** Test seams. */
export function setOneDoorShadowDiffPosterForTests(next: OneDoorShadowDiffPoster | null): void {
  poster = next ?? defaultPoster;
  buffer = [];
  disabledUntil = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}

export async function flushOneDoorShadowDiffsForTests(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  inFlight = inFlight.then(flushNow, flushNow);
  await inFlight;
}

export function pendingOneDoorShadowDiffCountForTests(): number {
  return buffer.length;
}
