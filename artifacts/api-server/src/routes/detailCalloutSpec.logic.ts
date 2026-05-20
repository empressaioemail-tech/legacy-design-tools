/**
 * Pure validation + push-state logic for the L4 `detail-callout-spec`
 * routes (Cortex Lane C.4 / C.4.4). Free of `@workspace/db` and Express
 * imports so it is unit-testable without a database.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L4.
 */

import {
  DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA,
  DETAIL_CALLOUT_PUSH_STATES,
  LEGAL_PUSH_TRANSITIONS,
  isLegalPushTransition,
  type DetailCalloutSpec,
  type DetailCalloutPushState,
} from "@workspace/atoms-l-surface";

/** Discriminated result of a request-body / query-param parse. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export { LEGAL_PUSH_TRANSITIONS, isLegalPushTransition };

/** True when `v` is one of the four `DetailCalloutPushState` values. */
export function isDetailCalloutPushState(
  v: unknown,
): v is DetailCalloutPushState {
  return (
    typeof v === "string" &&
    (DETAIL_CALLOUT_PUSH_STATES as readonly string[]).includes(v)
  );
}

/** Parsed `POST /engagements/:id/detail-callout-specs` body. */
export interface ParsedCreateDetailCalloutSpecBody {
  spec: DetailCalloutSpec;
  findingId: string | null;
  responseTaskId: string | null;
  actorId: string | null;
  principalActorId: string | null;
}

function parseOptionalString(
  raw: unknown,
  field: string,
): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `invalid_${field}` };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/**
 * Validate the create body. The `spec` object is validated against the
 * engine `DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA` discriminated union — a
 * malformed per-type payload (or an unknown `detailType`) is a 400.
 */
export function parseCreateDetailCalloutSpecBody(
  raw: unknown,
): ParseResult<ParsedCreateDetailCalloutSpecBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;

  const specResult = DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA.safeParse(body.spec);
  if (!specResult.success) {
    return { ok: false, error: "invalid_spec" };
  }

  const findingId = parseOptionalString(body.findingId, "finding_id");
  if (!findingId.ok) return findingId;
  const responseTaskId = parseOptionalString(
    body.responseTaskId,
    "response_task_id",
  );
  if (!responseTaskId.ok) return responseTaskId;
  const actorId = parseOptionalString(body.actorId, "actor_id");
  if (!actorId.ok) return actorId;
  const principalActorId = parseOptionalString(
    body.principalActorId,
    "principal_actor_id",
  );
  if (!principalActorId.ok) return principalActorId;

  return {
    ok: true,
    value: {
      spec: specResult.data,
      findingId: findingId.value,
      responseTaskId: responseTaskId.value,
      actorId: actorId.value,
      principalActorId: principalActorId.value,
    },
  };
}

/** Validate `POST /detail-callout-specs/:id/push-state` body. */
export function parsePushStateBody(
  raw: unknown,
): ParseResult<DetailCalloutPushState> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const pushState = (raw as Record<string, unknown>).pushState;
  if (!isDetailCalloutPushState(pushState)) {
    return { ok: false, error: "invalid_push_state" };
  }
  return { ok: true, value: pushState };
}

/** Validate `POST /detail-callout-specs/:id/aps-ref` body. */
export function parseApsRefBody(raw: unknown): ParseResult<string> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const apsTaskRef = (raw as Record<string, unknown>).apsTaskRef;
  if (typeof apsTaskRef !== "string" || apsTaskRef.trim().length === 0) {
    return { ok: false, error: "invalid_aps_task_ref" };
  }
  return { ok: true, value: apsTaskRef.trim() };
}

/** Validate the optional `?pushState=` list filter. */
export function parsePushStateFilter(
  raw: unknown,
): ParseResult<DetailCalloutPushState | null> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (!isDetailCalloutPushState(raw)) {
    return { ok: false, error: "invalid_push_state" };
  }
  return { ok: true, value: raw };
}

/**
 * Audit event type recorded for a transition INTO `to`.
 *
 * The L4 contract names events only for `pushed` / `applied` /
 * `rejected-by-user`. A `rejected-by-user → pending` revise transition
 * has no contract-named event — `null` means "record no event"
 * (flagged in the C.4.4 PR).
 */
export function pushStateTransitionEvent(
  to: DetailCalloutPushState,
): string | null {
  switch (to) {
    case "pushed":
      return "detail-callout-spec.pushed";
    case "applied":
      return "detail-callout-spec.applied";
    case "rejected-by-user":
      return "detail-callout-spec.rejected";
    case "pending":
      return null;
  }
}
