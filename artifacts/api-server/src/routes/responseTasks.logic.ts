/**
 * Pure request-validation + state-machine logic for the L1
 * `response-task` routes (Cortex Lane C.4 / C.4.1).
 *
 * Kept free of `@workspace/db` and Express imports so it is unit-
 * testable without a database — the route handler in `responseTasks.ts`
 * is the thin DB/HTTP shell around these functions. The full route
 * integration coverage (404s, persistence, event emission) runs in CI
 * against a live Postgres.
 *
 * Endpoint contract: `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L1. Atom shape: `RESPONSE_TASK_SCHEMA` in `@workspace/atoms-l-surface`.
 */

import {
  RESPONSE_TASK_STATES,
  type ResponseTaskState,
} from "@workspace/atoms-l-surface";

/** Discriminated result of a request-body / query-param parse. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Legal `response-task` state transitions.
 *
 * The L1 contract says the `state` route "validate[s] the transition"
 * and 409s a forbidden one, but does not enumerate the transition
 * table — and (unlike L4's `LEGAL_PUSH_TRANSITIONS`) the engine atom
 * shape declares no response-task transition helper. This table is the
 * Lane C.4 definition; it is surfaced to the planner in the C.4.1 PR
 * as a contract-prose gap.
 *
 * Shape: `open` is the entry state; work flows forward to `done` or is
 * abandoned to `cancelled`; `in-progress` may drop back to `open`. The
 * two terminal-ish states stay reachable-from: a `done` task can be
 * reopened to `in-progress` and a `cancelled` task revived to `open`,
 * so a mistaken completion/cancellation is recoverable. A no-op
 * same-state "transition" is forbidden (it is not a transition).
 */
export const RESPONSE_TASK_LEGAL_TRANSITIONS: Record<
  ResponseTaskState,
  ReadonlyArray<ResponseTaskState>
> = {
  open: ["in-progress", "done", "cancelled"],
  "in-progress": ["open", "done", "cancelled"],
  done: ["in-progress"],
  cancelled: ["open"],
};

/** True when `to` is a legal next state from `from`. */
export function isLegalResponseTaskTransition(
  from: ResponseTaskState,
  to: ResponseTaskState,
): boolean {
  return RESPONSE_TASK_LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Audit event type recorded for a transition INTO `to`.
 *
 * Event names use the dot-separated form the engine atom shape
 * declares (`response-task.opened` / `.progressed` / `.completed` /
 * `.cancelled`) and the rest of this codebase uses
 * (`submission.classified`, `deliverable-letter.drafted`). The L1
 * contract prose writes them hyphenated (`response-task-opened`); that
 * inconsistency is resolved here toward the atom-shape convention and
 * flagged in the C.4.1 PR.
 */
export function responseTaskTransitionEvent(to: ResponseTaskState): string {
  switch (to) {
    case "done":
      return "response-task.completed";
    case "cancelled":
      return "response-task.cancelled";
    case "open":
    case "in-progress":
      return "response-task.progressed";
  }
}

/** Parsed `POST /api/engagements/:id/response-tasks` body. */
export interface ParsedCreateResponseTaskBody {
  title: string;
  description: string;
  sourceClientCommentId: string | null;
  findingId: string | null;
  dueAt: string | null;
  actorId: string | null;
  principalActorId: string | null;
}

/**
 * Coerce an optional nullable-string field. `undefined` / `null` /
 * empty / whitespace-only → `null`; a non-empty string → its trimmed
 * value; any non-string → a parse error keyed on `field`.
 */
function parseOptionalString(
  raw: unknown,
  field: string,
): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `invalid_${field}` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/** Validate `POST /api/engagements/:id/response-tasks` request body. */
export function parseCreateResponseTaskBody(
  raw: unknown,
): ParseResult<ParsedCreateResponseTaskBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, error: "invalid_title" };
  }
  // `description` is required by the contract but may be the empty
  // string. A missing key coerces to "" so callers can omit it.
  let description = "";
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") {
      return { ok: false, error: "invalid_description" };
    }
    description = body.description;
  }

  const sourceClientCommentId = parseOptionalString(
    body.sourceClientCommentId,
    "source_client_comment_id",
  );
  if (!sourceClientCommentId.ok) return sourceClientCommentId;

  const findingId = parseOptionalString(body.findingId, "finding_id");
  if (!findingId.ok) return findingId;

  const actorId = parseOptionalString(body.actorId, "actor_id");
  if (!actorId.ok) return actorId;

  const principalActorId = parseOptionalString(
    body.principalActorId,
    "principal_actor_id",
  );
  if (!principalActorId.ok) return principalActorId;

  let dueAt: string | null = null;
  if (body.dueAt !== undefined && body.dueAt !== null) {
    if (typeof body.dueAt !== "string") {
      return { ok: false, error: "invalid_due_at" };
    }
    const parsed = new Date(body.dueAt);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: "invalid_due_at" };
    }
    dueAt = parsed.toISOString();
  }

  return {
    ok: true,
    value: {
      title: body.title.trim(),
      description,
      sourceClientCommentId: sourceClientCommentId.value,
      findingId: findingId.value,
      dueAt,
      actorId: actorId.value,
      principalActorId: principalActorId.value,
    },
  };
}

/** True when `v` is one of the four `ResponseTaskState` values. */
export function isResponseTaskState(v: unknown): v is ResponseTaskState {
  return (
    typeof v === "string" &&
    (RESPONSE_TASK_STATES as readonly string[]).includes(v)
  );
}

/** Validate `POST /api/response-tasks/:id/state` request body. */
export function parseStateBody(raw: unknown): ParseResult<ResponseTaskState> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const state = (raw as Record<string, unknown>).state;
  if (!isResponseTaskState(state)) {
    return { ok: false, error: "invalid_state" };
  }
  return { ok: true, value: state };
}

/** Validate `POST /api/response-tasks/:id/link-finding` request body. */
export function parseLinkFindingBody(raw: unknown): ParseResult<string> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const findingId = (raw as Record<string, unknown>).findingId;
  if (typeof findingId !== "string" || findingId.trim().length === 0) {
    return { ok: false, error: "invalid_finding_id" };
  }
  return { ok: true, value: findingId.trim() };
}

/**
 * Validate the optional `?state=` filter on the list route. A missing
 * filter resolves to `null` (no filtering); an unknown value is a 400.
 */
export function parseStateFilter(
  raw: unknown,
): ParseResult<ResponseTaskState | null> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (!isResponseTaskState(raw)) {
    return { ok: false, error: "invalid_state" };
  }
  return { ok: true, value: raw };
}
