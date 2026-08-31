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

/** One anchor read per get_smart_site call. Arrays are never fanned out. */
export const ANCHOR_READ_CAP = 1;

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

/** An array is never fanned out into N facets reads. */
export function skippedAnchorForBatch(received: number): AnchorOutcome {
  return {
    anchorRead: {
      status: "skipped",
      reason: "anchor_read_batch_cap",
      cap: ANCHOR_READ_CAP,
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
