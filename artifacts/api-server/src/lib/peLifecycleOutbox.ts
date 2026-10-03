/**
 * Durable outbox + leg runner for Smart Site lifecycle events (P-413, P-492).
 *
 * Write the row in the same request as the user's action. A send failure
 * never delays, blocks or reverts that action, and never loses the event.
 *
 * THREE INDEPENDENT LEGS (P-492, `_inbox/2026-10-03_ghl_to_resend_PLAN_integration_end.md` 3b):
 *   local  — the projection into `ss_contact`, the system of record;
 *   resend — the contact upsert + contract v2 event;
 *   meta   — the Conversions API event.
 * Each leg carries its own status and attempts. A failure on one leg is
 * recorded on that leg only and never skips another. The one ordering rule is
 * the contract's: Resend runs after the local projection has committed (it
 * reads the contact the projection wrote), so a Resend leg waits — it is not
 * skipped — while local is still open.
 *
 * THE DEFECTS THIS REPLACES (P-413 worker, found 2026-10-03): a GoHighLevel
 * failure `continue`d before Meta ran; nothing drained the outbox on a
 * schedule, so a failed row waited for another user's event; and every
 * dispatch retried every failed row forever, in the user's request.
 */

import { randomUUID } from "node:crypto";
import { assertEnqueuePayloadAllowed } from "./peLifecycleDenylist";
import {
  AFFILIATE_LIFECYCLE_EVENTS,
  PAID_LIFECYCLE_EVENTS,
  type LifecycleEventType,
} from "./peLifecycleTypes";

export type LegName = "local" | "resend" | "meta";
export type LegStatus = "pending" | "sent" | "failed" | "dead" | "skipped";
export type LegState = { status: LegStatus; attempts: number; error: string | null };
export type Legs = Record<LegName, LegState>;
export type OutboxStatus = "pending" | "sent" | "failed" | "dead";

export type OutboxSubject =
  | { kind: "user"; userId: string }
  | { kind: "affiliate"; affiliatePartnerId: string };

export type OutboxRecord = {
  id: string;
  subject: OutboxSubject;
  eventType: LifecycleEventType;
  idempotencyKey: string;
  email: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  legs: Legs;
  /** Event data the local projection derived for Resend (e.g. previous_plan). */
  resendEvent: Record<string, unknown> | null;
  nextAttemptAt: Date;
  createdAt: Date;
};

export type OutboxOutcome = {
  legs: Legs;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  resendEvent: Record<string, unknown> | null;
  nextAttemptAt: Date;
  sentAt: Date | null;
};

export type ClaimOptions = {
  now: Date;
  limit: number;
  leaseMs: number;
  /** Restrict the claim to these ids (the request path claims only its own row). */
  ids?: string[];
};

export type OutboxStore = {
  insert(row: OutboxRecord): Promise<"inserted" | "duplicate">;
  findIdByIdempotencyKey(idempotencyKey: string): Promise<string | null>;
  /**
   * Claim rows that are due (status pending|failed, next_attempt_at <= now,
   * lease free) and lease them for `leaseMs`. The Postgres store does this
   * with FOR UPDATE SKIP LOCKED, so two drains never claim one row.
   */
  claimDue(opts: ClaimOptions): Promise<OutboxRecord[]>;
  /** Persist the leg outcomes and release the lease. */
  saveOutcome(id: string, outcome: OutboxOutcome): Promise<void>;
};

/** Attempts per leg before it is `dead`. */
export const LEG_ATTEMPT_CAP = 12;
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Wait before the next attempt after `attempts` failures: 1, 2, 4, 8, 16, 32
 * minutes, then 60. Twelve failures span about six hours.
 */
export function backoffMs(attempts: number): number {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  return minutes * 60 * 1000;
}

function isOpen(leg: LegState): boolean {
  return leg.status === "pending" || leg.status === "failed";
}

function isDone(leg: LegState): boolean {
  return leg.status === "sent" || leg.status === "skipped";
}

function sent(leg: LegState): LegState {
  return { status: "sent", attempts: leg.attempts + 1, error: null };
}

function failed(leg: LegState, error: string): LegState {
  const attempts = leg.attempts + 1;
  return {
    status: attempts >= LEG_ATTEMPT_CAP ? "dead" : "failed",
    attempts,
    error,
  };
}

function skipped(leg: LegState, reason: string, countAttempt = false): LegState {
  return {
    status: "skipped",
    attempts: leg.attempts + (countAttempt ? 1 : 0),
    error: reason,
  };
}

export function aggregateStatus(legs: Legs): OutboxStatus {
  const all = Object.values(legs);
  if (all.every(isDone)) return "sent";
  if (all.some((l) => l.status === "failed")) return "failed";
  if (all.some((l) => l.status === "pending")) return "pending";
  return "dead";
}

export function initialLegs(subject: OutboxSubject): Legs {
  if (subject.kind === "affiliate") {
    return {
      local: { status: "skipped", attempts: 0, error: "affiliate_row" },
      resend: { status: "pending", attempts: 0, error: null },
      meta: { status: "skipped", attempts: 0, error: "affiliate_row" },
    };
  }
  return {
    local: { status: "pending", attempts: 0, error: null },
    resend: { status: "pending", attempts: 0, error: null },
    meta: { status: "pending", attempts: 0, error: null },
  };
}

export function memoryOutboxStore(seed: OutboxRecord[] = []): OutboxStore & {
  rows: OutboxRecord[];
} {
  const rows: OutboxRecord[] = seed.map((r) => structuredClone(r));
  const leases = new Map<string, number>();
  return {
    rows,
    async insert(row) {
      if (rows.some((r) => r.idempotencyKey === row.idempotencyKey)) {
        return "duplicate";
      }
      rows.push(structuredClone(row));
      return "inserted";
    },
    async findIdByIdempotencyKey(idempotencyKey) {
      return rows.find((r) => r.idempotencyKey === idempotencyKey)?.id ?? null;
    },
    async claimDue({ now, limit, leaseMs, ids }) {
      const due = rows
        .filter(
          (r) =>
            (r.status === "pending" || r.status === "failed") &&
            r.nextAttemptAt.getTime() <= now.getTime() &&
            (leases.get(r.id) ?? 0) <= now.getTime() &&
            (!ids || ids.includes(r.id)),
        )
        .slice(0, limit);
      for (const r of due) leases.set(r.id, now.getTime() + leaseMs);
      return due.map((r) => structuredClone(r));
    },
    async saveOutcome(id, outcome) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.legs = structuredClone(outcome.legs);
      row.status = outcome.status;
      row.attempts = outcome.attempts;
      row.lastError = outcome.lastError;
      row.resendEvent = outcome.resendEvent;
      row.nextAttemptAt = outcome.nextAttemptAt;
      leases.delete(id);
    },
  };
}

export type EnqueueInput = {
  /** Exactly one of userId / affiliatePartnerId. */
  userId?: string;
  affiliatePartnerId?: string;
  email: string;
  event: LifecycleEventType;
  idempotencyKey: string;
  apply: Record<string, unknown>;
  eventId?: string;
};

export function subjectFor(input: Pick<EnqueueInput, "userId" | "affiliatePartnerId" | "event">): OutboxSubject {
  const isAffiliateEvent = AFFILIATE_LIFECYCLE_EVENTS.includes(input.event);
  if (input.affiliatePartnerId && !input.userId && isAffiliateEvent) {
    return { kind: "affiliate", affiliatePartnerId: input.affiliatePartnerId };
  }
  if (input.userId && !input.affiliatePartnerId && !isAffiliateEvent) {
    return { kind: "user", userId: input.userId };
  }
  throw new Error(`lifecycle_subject_invalid:${input.event}`);
}

/**
 * Validate and insert. The sovereignty checks (denylist + allowlist) run
 * BEFORE the insert, so a refused payload never reaches the table.
 */
export async function enqueueLifecycleEvent(
  input: EnqueueInput,
  store: OutboxStore,
  now: Date = new Date(),
): Promise<{ eventId: string; enqueued: boolean }> {
  const eventId = input.eventId ?? randomUUID();
  const subject = subjectFor(input);
  const payload = { ...input.apply };
  assertEnqueuePayloadAllowed(payload);
  const email = input.email.trim();
  if (!email) throw new Error("lifecycle_email_missing");
  const legs = initialLegs(subject);
  const result = await store.insert({
    id: eventId,
    subject,
    eventType: input.event,
    idempotencyKey: input.idempotencyKey,
    email,
    payload,
    status: aggregateStatus(legs),
    attempts: 0,
    lastError: null,
    legs,
    resendEvent: null,
    nextAttemptAt: now,
    createdAt: now,
  });
  if (result === "duplicate") {
    const existingId = await store.findIdByIdempotencyKey(input.idempotencyKey);
    if (!existingId) {
      throw new Error("outbox_duplicate_without_row");
    }
    return { eventId: existingId, enqueued: false };
  }
  return { eventId, enqueued: true };
}

export type ProjectionResult =
  | {
      ok: true;
      /** Event data for the Resend event (e.g. previous_plan). */
      resendEvent?: Record<string, unknown> | null;
      /** The projection found the event no longer true; send nothing to Resend. */
      suppressResend?: string;
    }
  | { ok: false; error: string };

export type LegResult = { ok: true } | { ok: false; error: string };

export type MetaLegResult =
  | { ok: true }
  | { ok: false; error: string; refusedByName?: boolean };

export type LegDeps = {
  project: (row: OutboxRecord) => Promise<ProjectionResult>;
  sendResend: (row: OutboxRecord, resendEvent: Record<string, unknown> | null) => Promise<LegResult>;
  sendMeta: (row: OutboxRecord) => Promise<MetaLegResult>;
  now?: () => Date;
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Run every open leg of one row once. Pure over its deps; never throws. */
export async function runLegs(row: OutboxRecord, deps: LegDeps): Promise<OutboxOutcome> {
  const now = deps.now?.() ?? new Date();
  const legs: Legs = structuredClone(row.legs);
  let resendEvent = row.resendEvent;

  if (isOpen(legs.local)) {
    try {
      const r = await deps.project(row);
      if (r.ok) {
        legs.local = sent(legs.local);
        resendEvent = r.resendEvent ?? null;
        if (r.suppressResend && isOpen(legs.resend)) {
          legs.resend = skipped(legs.resend, r.suppressResend);
        }
      } else {
        legs.local = failed(legs.local, r.error);
      }
    } catch (err) {
      legs.local = failed(legs.local, errorMessage(err, "local_projection_threw"));
    }
  }

  if (isOpen(legs.meta)) {
    try {
      const m = await deps.sendMeta(row);
      if (m.ok) legs.meta = sent(legs.meta);
      else if (m.refusedByName) legs.meta = skipped(legs.meta, m.error, true);
      else legs.meta = failed(legs.meta, m.error);
    } catch (err) {
      legs.meta = failed(legs.meta, errorMessage(err, "meta_leg_threw"));
    }
  }

  if (isOpen(legs.resend)) {
    if (isDone(legs.local)) {
      try {
        const r = await deps.sendResend(row, resendEvent);
        legs.resend = r.ok ? sent(legs.resend) : failed(legs.resend, r.error);
      } catch (err) {
        legs.resend = failed(legs.resend, errorMessage(err, "resend_leg_threw"));
      }
    } else if (legs.local.status === "dead") {
      legs.resend = { status: "dead", attempts: legs.resend.attempts, error: "local_leg_dead" };
    }
    // else: local still open; Resend waits for the projection.
  }

  const status = aggregateStatus(legs);
  const openFailures = Object.values(legs).filter((l) => l.status === "failed");
  const maxAttempts = openFailures.reduce((m, l) => Math.max(m, l.attempts), 0);
  const nextAttemptAt =
    status === "failed" ? new Date(now.getTime() + backoffMs(maxAttempts)) : now;
  const errors = (Object.entries(legs) as [LegName, LegState][])
    .filter(([, l]) => l.status === "failed" || l.status === "dead")
    .map(([name, l]) => `${name}:${l.error ?? "unknown"}`);
  return {
    legs,
    status,
    attempts: row.attempts + 1,
    lastError: errors.length > 0 ? errors.join("; ") : null,
    resendEvent,
    nextAttemptAt,
    sentAt: status === "sent" ? now : null,
  };
}

export type ProcessResult = {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
};

/**
 * Claim due rows and run their legs. The scheduled drain calls this with no
 * `ids`; the request path calls it with exactly its own row id, so a user's
 * request never drains other users' rows.
 */
export async function processLifecycleOutbox(
  deps: LegDeps & { store: OutboxStore; limit?: number; ids?: string[] },
): Promise<ProcessResult> {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.store.claimDue({
    now,
    limit: deps.limit ?? 25,
    leaseMs: CLAIM_LEASE_MS,
    ...(deps.ids ? { ids: deps.ids } : {}),
  });
  const result: ProcessResult = { claimed: rows.length, sent: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    const outcome = await runLegs(row, deps);
    await deps.store.saveOutcome(row.id, outcome);
    if (outcome.status === "sent") result.sent += 1;
    else if (outcome.status === "dead") result.dead += 1;
    else if (outcome.status === "failed") result.failed += 1;
  }
  return result;
}

export function e6IdempotencyKey(userId: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `e6:${userId}:${day}`;
}

export function e1IdempotencyKey(userId: string): string {
  return `e1:${userId}`;
}

export function e2IdempotencyKey(userId: string, savedLots: number): string {
  return `e2:${userId}:${savedLots}`;
}

export function e3IdempotencyKey(shareGrantId: string): string {
  return `e3:${shareGrantId}`;
}

export function e4IdempotencyKey(stripeEventId: string): string {
  return `e4:${stripeEventId}`;
}

export function e5IdempotencyKey(stripeEventId: string): string {
  return `e5:${stripeEventId}`;
}

export function planCancelledIdempotencyKey(stripeEventId: string): string {
  return `cancel:${stripeEventId}`;
}

/** Once per contact, ever. */
export function becameSharerIdempotencyKey(userId: string): string {
  return `became_sharer:${userId}`;
}

/** Once per contact, ever. */
export function claudeConnectedIdempotencyKey(userId: string): string {
  return `claude:${userId}`;
}

/** Once per quiet transition: keyed on the last-active date that went stale. */
export function wentQuietIdempotencyKey(userId: string, lastActive: string): string {
  return `went_quiet:${userId}:${lastActive}`;
}

/** Once per quiet transition: keyed on when the contact went quiet. */
export function cameBackIdempotencyKey(userId: string, quietSince: Date): string {
  return `came_back:${userId}:${quietSince.toISOString()}`;
}

export function affiliateAppliedIdempotencyKey(affiliatePartnerId: string): string {
  return `affiliate_applied:${affiliatePartnerId}`;
}

export function affiliateApprovedIdempotencyKey(affiliatePartnerId: string): string {
  return `affiliate_approved:${affiliatePartnerId}`;
}

/**
 * Paid events (unlock, plan started, plan cancelled) may only be enqueued
 * from the Stripe webhook. Any other source is a contract violation.
 */
export function assertPaidEventFromWebhook(
  event: LifecycleEventType,
  source: string,
): void {
  if (!PAID_LIFECYCLE_EVENTS.includes(event)) return;
  if (source !== "stripe_webhook") {
    throw new Error(`paid_lifecycle_event_refused:${event}:source=${source}`);
  }
}
