/**
 * P-98 next-action rail — the activation event VALIDATOR.
 *
 * Pure. Imports no database, so every refusal below is testable without
 * Postgres. Mirrors the peAiConnectionsClassify / peAiConnections split
 * already used in this codebase: the logic lives here, the query lives in
 * `peActivationEvents.ts`.
 *
 * WHY BOTH SETS ARE CLOSED AND REFUSE RATHER THAN DEFAULT.
 *
 * This table is the ONLY measurement of the activation funnel that will
 * exist. A defaulted `event_type` turns an unreadable event into a countable
 * one, and a defaulted or invented `action_id` attributes it to a rung that
 * did not fire. Both corruptions are invisible afterwards: the row looks
 * exactly like a real one, and it enters every ratio the ladder is judged by.
 * There is no way to subtract it later, because nothing distinguishes it.
 * So an unknown value is refused at the door.
 *
 * The 400 body NAMES the allowed set. A silent refusal on a best-effort
 * telemetry route (the client drops failures on purpose) would be
 * undiagnosable from the outside; naming the vocabulary makes a client/server
 * vocabulary drift self-explaining the first time someone reads a response.
 *
 * THE ACTION IDS ARE THE SERVER'S. Nothing in legacy-design-tools defined an
 * action-id vocabulary before this file (verified by grep, 2026-08-31), and
 * neither the P-98 dispatches nor the decision record names any id string.
 * The five below are one per ladder-v1 rung as ruled in
 * `_decisions/2026-08-31_next_action_rail_activation_engine.md` and OPS-16
 * amendment A-063. The client half must emit exactly these strings; anything
 * else is a 400, which is the correct direction but is a coordination item.
 */

/** The event grammar. Also frozen as a DDL check on `pe_activation_events`. */
export const PE_ACTIVATION_EVENT_TYPES = ["shown", "acted"] as const;

export type PeActivationEventTypeValue =
  (typeof PE_ACTIVATION_EVENT_TYPES)[number];

/**
 * Ladder v1 rungs. Deliberately NOT a DDL value list: this vocabulary grows
 * once per rung added, and a schema constraint would silently drop a new
 * rung's events until a migration landed. See the 0091 migration header.
 *
 *  - `connect_claude`   Account / Connections: `pe_ai_connections` shows none.
 *  - `unlock_expiring`  Plan: an active unlock is close to lapsing. The
 *                       highest-intent rung, and the reason the account-wide
 *                       unlock read was in scope rather than deferred.
 *  - `property_unlock`  Plan: free tier with the free chat allowance nearly
 *                       exhausted.
 *  - `annual_upgrade`   Plan: paid MONTHLY on solo or studio.
 *  - `team_invite`      Team: `team` tier with unused seats. Never offered on
 *                       any other tier.
 */
export const PE_ACTIVATION_ACTION_IDS = [
  "connect_claude",
  "unlock_expiring",
  "property_unlock",
  "annual_upgrade",
  "team_invite",
] as const;

export type PeActivationActionId = (typeof PE_ACTIVATION_ACTION_IDS)[number];

export type PeActivationEventInput = {
  eventType: PeActivationEventTypeValue;
  actionId: PeActivationActionId;
  /** `null` = the caller sent no surface. NEVER a default. */
  surface: string | null;
};

export type PeActivationEventRefusal = {
  error: "invalid_event_type" | "invalid_action_id" | "invalid_surface";
  allowed?: readonly string[];
};

export type PeActivationEventParse =
  | { ok: true; value: PeActivationEventInput }
  | { ok: false; refusal: PeActivationEventRefusal };

function isEventType(v: unknown): v is PeActivationEventTypeValue {
  return (
    typeof v === "string" &&
    (PE_ACTIVATION_EVENT_TYPES as readonly string[]).includes(v)
  );
}

function isActionId(v: unknown): v is PeActivationActionId {
  return (
    typeof v === "string" &&
    (PE_ACTIVATION_ACTION_IDS as readonly string[]).includes(v)
  );
}

/**
 * Parse one activation-event body. Snake_case field names, matching the
 * contract both P-98 dispatches state: `{event_type, action_id, surface}`.
 * camelCase is NOT also accepted — one contract, and a camelCase caller gets
 * a 400 naming the vocabulary rather than a row that silently lost a field.
 *
 * `surface` is the only optional field. Absent or explicitly null writes
 * NULL, which reads as unmeasured. A present-but-blank or non-string surface
 * is REFUSED rather than coerced to null: coercing would turn a client bug
 * into an honest-looking absence, and absence is a claim here.
 */
export function parseActivationEvent(body: unknown): PeActivationEventParse {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isEventType(b.event_type)) {
    return {
      ok: false,
      refusal: {
        error: "invalid_event_type",
        allowed: PE_ACTIVATION_EVENT_TYPES,
      },
    };
  }

  if (!isActionId(b.action_id)) {
    return {
      ok: false,
      refusal: {
        error: "invalid_action_id",
        allowed: PE_ACTIVATION_ACTION_IDS,
      },
    };
  }

  let surface: string | null = null;
  if (b.surface !== undefined && b.surface !== null) {
    if (typeof b.surface !== "string" || b.surface.trim() === "") {
      return { ok: false, refusal: { error: "invalid_surface" } };
    }
    surface = b.surface.trim();
  }

  return {
    ok: true,
    value: { eventType: b.event_type, actionId: b.action_id, surface },
  };
}
