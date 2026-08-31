/**
 * P-91 v3 M-1. The one absolute coordinate a parcel draw hangs on.
 *
 * The panel renders a ring in a local foot frame whose origin is the parcel's
 * own centroid, so nothing can be placed under it on the earth. Cortex
 * already serves an absolute point: the anonymous node facets route carries
 * `cityLimitsFact.queryPoint` from the bake lat/lng index at five decimal
 * places, about 1.1 m. Shape read from deployed cortex 2026-08-30 for
 * 48021:31254, 48021:49295 and 48021:82112: `cityLimitsFact` sits at the top
 * level of the body and `queryPoint` is `{longitude, latitude}`.
 *
 * Fail closed. A coordinate this module did not read is never emitted: no
 * default, no 0,0, no centroid guess, no last known value. A miss or a
 * failure is declared under `anchorRead` and the brief travels unchanged.
 */

import { cortexFetch, type CortexClientConfig } from "./cortex-client.js";

/**
 * Anonymous cortex facets route. Exported so a consumer asserts against this
 * constant instead of copying the string.
 */
export const PARCEL_FACETS_PATH_TEMPLATE =
  "/api/brokerage/v1/place/node/{parcelNodeId}/facets";

/** The facets path for one parcel node id, id percent-encoded. */
export function parcelFacetsPath(parcelNodeId: string): string {
  return PARCEL_FACETS_PATH_TEMPLATE.replace(
    "{parcelNodeId}",
    encodeURIComponent(parcelNodeId),
  );
}

/**
 * Matches PROBE_TIMEOUT_MS in hauska-client.ts, the package's existing bound
 * for an optional side call whose latency must not roll into the primary
 * path. The anchor request is issued with the brief and joined after it, so
 * the panel waits max(brief, this), and this bound is the whole reason a hung
 * facets read cannot stall the panel.
 */
export const ANCHOR_TIMEOUT_MS = 2_000;

/**
 * How many parcels of one node-depth array get an anchor read.
 *
 * M-1 fanned out nothing, because nobody had bounded the fan. M-4 bounds it
 * here. Twelve, for two reasons that both bind before any other one does.
 *
 * The canvas. The set is drawn into a 320 by 220 viewBox with 28 units of pad,
 * so 264 units of width carry the whole set. Past about a dozen rings the
 * labels cannot be placed without collision and a thirteenth anchor buys a
 * declaration rather than a drawing. The cap is set by what the canvas can
 * honestly show, and everything past it is named rather than dropped.
 *
 * The fan. The published node array cap is 25 (SMARTSITE_NODE_BATCH_CAP), so
 * twelve holds one tool call's side reads under half the ceiling. The reads are
 * concurrent and each carries ANCHOR_TIMEOUT_MS, so the anchor phase is bounded
 * by that timeout and not by the count; the count bounds the burst, not the
 * latency.
 */
export const ANCHOR_BATCH_READ_CAP = 12;

/** Five decimal places on the bake lat/lng index, about 1.1 m. */
export const ANCHOR_PRECISION = "1e-5-deg";
export const ANCHOR_SOURCE = "bake-latlng-index";

export type ParcelAnchor = {
  lat: number;
  lon: number;
  precision: typeof ANCHOR_PRECISION;
  source: typeof ANCHOR_SOURCE;
};

export type AnchorReadStatus = "ok" | "absent" | "error" | "skipped";

export type AnchorRead = {
  status: AnchorReadStatus;
  reason?: string;
  upstreamStatus?: number;
  cap?: number;
  received?: number;
};

/**
 * `anchor` is present only when `anchorRead.status` is "ok". Every other
 * status carries a reason and no coordinate.
 */
export type AnchorOutcome = {
  anchor?: ParcelAnchor;
  anchorRead: AnchorRead;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function absent(reason: string): AnchorOutcome {
  return { anchorRead: { status: "absent", reason } };
}

function failed(reason: string, upstreamStatus?: number): AnchorOutcome {
  return {
    anchorRead: {
      status: "error",
      reason,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    },
  };
}

/** The reason a parcel past the cap carries, and the reason the batch declares. */
export const ANCHOR_BATCH_CAP_REASON = "anchor_read_batch_cap";

/**
 * A parcel the array carried past the cap. It is DECLARED absent with the cap
 * named, never left looking like a parcel with no coordinate on the earth.
 */
export function skippedAnchorOverBatchCap(received: number): AnchorOutcome {
  return {
    anchorRead: {
      status: "skipped",
      reason: ANCHOR_BATCH_CAP_REASON,
      cap: ANCHOR_BATCH_READ_CAP,
      received,
    },
  };
}

/** A stub row carries no draw, so there is no frame for an anchor to hold. */
export function skippedAnchorForStub(): AnchorOutcome {
  return { anchorRead: { status: "skipped", reason: "anchor_read_stub_depth" } };
}

/**
 * Parse one facets body into an outcome. Every path that is not a read
 * coordinate returns no `anchor` key at all.
 */
export function anchorFromFacetsBody(bodyText: string): AnchorOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return failed("anchor_body_not_json");
  }
  const body = asRecord(parsed);
  if (!body) return failed("anchor_body_not_json");

  const fact = asRecord(body.cityLimitsFact);
  if (!fact) return absent("city_limits_fact_absent");

  const point = asRecord(fact.queryPoint);
  if (!point) return absent("query_point_absent");

  const lon = point.longitude;
  const lat = point.latitude;
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) {
    return absent("query_point_not_numeric");
  }
  // Either component exactly zero is the 0,0 sentinel, not a location.
  if (lon === 0 || lat === 0) return absent("query_point_zero_sentinel");

  return {
    anchor: {
      lat,
      lon,
      precision: ANCHOR_PRECISION,
      source: ANCHOR_SOURCE,
    },
    anchorRead: { status: "ok" },
  };
}

function abortShaped(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Read one parcel's anchor. Never throws: an upstream failure is a declared
 * outcome, because a failed anchor read must not fail the panel.
 */
export async function readParcelAnchor(
  config: CortexClientConfig,
  parcelNodeId: string,
  fetchImpl: typeof cortexFetch = cortexFetch,
): Promise<AnchorOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(config, parcelFacetsPath(parcelNodeId), {
      timeoutMs: ANCHOR_TIMEOUT_MS,
    });
  } catch (error) {
    return failed(abortShaped(error) ? "anchor_read_timeout" : "anchor_fetch_failed");
  }
  if (!res || typeof res.ok !== "boolean") {
    return failed("anchor_fetch_failed");
  }
  if (!res.ok) {
    return failed("anchor_upstream_non_ok", res.status);
  }
  let text: string;
  try {
    // Clone: this read is optional and must never disturb a body that
    // another reader owns.
    text = await res.clone().text();
  } catch {
    return failed("anchor_body_unreadable");
  }
  return anchorFromFacetsBody(text);
}

/**
 * Put the outcome on the wire as top-level siblings of `draw`. Any `anchor`
 * or `anchorRead` the upstream body carried is dropped first, so the only
 * coordinate that can leave here is one this module read.
 */
export function attachAnchorToResponseText(
  responseText: string,
  outcome: AnchorOutcome,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return responseText;
  }
  const body = asRecord(parsed);
  if (!body) return responseText;

  const out: Record<string, unknown> = { ...body };
  delete out.anchor;
  delete out.anchorRead;
  if (outcome.anchor) out.anchor = outcome.anchor;
  out.anchorRead = outcome.anchorRead;
  return JSON.stringify(out);
}

/**
 * M-4. What one node-depth array's anchor phase did, stated on the wire.
 *
 * `attempted` counts reads ISSUED, never reads that succeeded: whether a given
 * parcel got a coordinate is on that parcel's own `anchorRead` and nowhere
 * else. `notAttempted` is the truncation, and it carries a reason whenever it
 * is above zero, so a caller reading only this object still learns that the
 * set it is holding is not the set it asked for.
 */
export type BatchAnchorDeclaration = {
  cap: number;
  received: number;
  attempted: number;
  notAttempted: number;
  reason?: string;
};

export type BatchAnchorOutcome = {
  /** In request order, one entry per read ISSUED. Never one per parcel returned. */
  reads: ReadonlyArray<{ parcelNodeId: string; outcome: AnchorOutcome }>;
  declaration: BatchAnchorDeclaration;
};

/**
 * Read anchors for the first ANCHOR_BATCH_READ_CAP ids of an array, concurrently.
 *
 * Never throws and never rejects: readParcelAnchor turns every upstream failure
 * into a declared outcome, so one parcel's failure is that parcel's declared
 * absence and cannot fail its neighbours or the panel. The order is the request
 * order, so which parcels were read is deterministic and reproducible rather
 * than whichever twelve answered first.
 */
export async function readParcelAnchorsForBatch(
  config: CortexClientConfig,
  parcelNodeIds: ReadonlyArray<string>,
  fetchImpl: typeof cortexFetch = cortexFetch,
): Promise<BatchAnchorOutcome> {
  const received = parcelNodeIds.length;
  const take = parcelNodeIds.slice(0, ANCHOR_BATCH_READ_CAP);
  const outcomes = await Promise.all(
    take.map((id) => readParcelAnchor(config, id, fetchImpl)),
  );
  const reads = take.map((id, i) => ({
    parcelNodeId: id,
    outcome: outcomes[i] ?? failed("anchor_fetch_failed"),
  }));
  const notAttempted = received - take.length;
  const declaration: BatchAnchorDeclaration = {
    cap: ANCHOR_BATCH_READ_CAP,
    received,
    attempted: take.length,
    notAttempted,
  };
  if (notAttempted > 0) declaration.reason = ANCHOR_BATCH_CAP_REASON;
  return { reads, declaration };
}

/** The outcome this batch read for one id, or undefined when it read none. */
function outcomeFor(
  batch: BatchAnchorOutcome,
  parcelNodeId: string,
): AnchorOutcome | undefined {
  for (const entry of batch.reads) {
    if (entry.parcelNodeId === parcelNodeId) return entry.outcome;
  }
  return undefined;
}

/**
 * Put per-parcel outcomes on each row of a batch body, and the batch's own
 * declaration at the top level.
 *
 * Every row gets an `anchorRead`, including the rows past the cap, which get an
 * explicit skip naming the cap. A row is never left with neither a coordinate
 * nor a declaration, because that row reads as a parcel with no location rather
 * than a parcel nobody looked up. Any `anchor` or `anchorRead` the upstream body
 * carried is dropped first, so the only coordinate that can leave here is one
 * this module read.
 */
export function attachBatchAnchorsToResponseText(
  responseText: string,
  batch: BatchAnchorOutcome,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return responseText;
  }
  const body = asRecord(parsed);
  if (!body) return responseText;

  const out: Record<string, unknown> = { ...body };
  delete out.anchor;
  delete out.anchorRead;
  out.anchorBatch = batch.declaration;
  if (!Array.isArray(body.parcels)) return JSON.stringify(out);

  out.parcels = body.parcels.map((raw) => {
    const row = asRecord(raw);
    if (!row) return raw;
    const next: Record<string, unknown> = { ...row };
    delete next.anchor;
    delete next.anchorRead;
    const id = typeof row.parcelNodeId === "string" ? row.parcelNodeId : null;
    const outcome =
      (id === null ? undefined : outcomeFor(batch, id)) ??
      skippedAnchorOverBatchCap(batch.declaration.received);
    if (outcome.anchor) next.anchor = outcome.anchor;
    next.anchorRead = outcome.anchorRead;
    return next;
  });
  return JSON.stringify(out);
}
