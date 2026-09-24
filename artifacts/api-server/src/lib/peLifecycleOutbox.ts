/**
 * Durable outbox + worker for E1–E6.
 *
 * Write the row in the same request as the user's action. A GHL or Meta
 * failure never delays, blocks or reverts that action, and never loses the
 * event: the worker retries until both legs succeed (or Meta refuses by
 * name because the token is absent — that refusal is recorded, not retried
 * as a send).
 */

import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { applyLifecycleToGhl, type LifecycleApplyInput } from "./peGhlLifecycle";
import { sendMetaCapiEvent } from "./peMetaCapi";
import { assertLifecyclePayloadSafe } from "./peLifecycleDenylist";
import type { LifecycleEventType } from "./peLifecycleTypes";

export type OutboxRecord = {
  id: string;
  ownerUserId: string;
  eventType: LifecycleEventType;
  idempotencyKey: string;
  email: string;
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
};

export type OutboxStore = {
  insert(row: OutboxRecord): Promise<"inserted" | "duplicate">;
  listSendable(): Promise<OutboxRecord[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
};

export function memoryOutboxStore(seed: OutboxRecord[] = []): OutboxStore {
  const rows = [...seed];
  return {
    async insert(row) {
      if (rows.some((r) => r.idempotencyKey === row.idempotencyKey)) {
        return "duplicate";
      }
      rows.push({ ...row });
      return "inserted";
    },
    async listSendable() {
      return rows.filter((r) => r.status === "pending" || r.status === "failed");
    },
    async markSent(id) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = "sent";
        row.attempts += 1;
        row.lastError = null;
      }
    },
    async markFailed(id, error) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = "failed";
        row.attempts += 1;
        row.lastError = error;
      }
    },
  };
}

export type EnqueueInput = {
  userId: string;
  email: string;
  event: LifecycleEventType;
  idempotencyKey: string;
  apply: LifecycleApplyInput;
  eventId?: string;
};

export async function enqueueLifecycleEvent(
  input: EnqueueInput,
  store: OutboxStore,
): Promise<{ eventId: string; enqueued: boolean }> {
  const eventId = input.eventId ?? randomUUID();
  const payload = { ...input.apply };
  assertLifecyclePayloadSafe(payload);
  const result = await store.insert({
    id: eventId,
    ownerUserId: input.userId,
    eventType: input.event,
    idempotencyKey: input.idempotencyKey,
    email: input.email,
    payload,
    status: "pending",
    attempts: 0,
    lastError: null,
  });
  return { eventId, enqueued: result === "inserted" };
}

export type ProcessDeps = {
  store: OutboxStore;
  applyGhl?: typeof applyLifecycleToGhl;
  sendMeta?: typeof sendMetaCapiEvent;
  now?: () => Date;
};

export async function processLifecycleOutbox(
  deps: ProcessDeps,
): Promise<{ processed: number; sent: number; failed: number }> {
  const applyGhl = deps.applyGhl ?? applyLifecycleToGhl;
  const sendMeta = deps.sendMeta ?? sendMetaCapiEvent;
  const rows = await deps.store.listSendable();
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const apply = row.payload as unknown as LifecycleApplyInput;
    const ghl = await applyGhl({
      ...apply,
      email: row.email,
      event: row.eventType,
    });
    if (!ghl.ok) {
      await deps.store.markFailed(row.id, `ghl:${ghl.error}`);
      failed += 1;
      continue;
    }
    const meta = await sendMeta({
      event: row.eventType,
      eventId: row.id,
      email: row.email,
      eventTime: Math.floor((deps.now?.().getTime() ?? Date.now()) / 1000),
      value: typeof apply.value === "number" ? apply.value : undefined,
      currency: apply.currency,
    });
    if (
      !meta.ok &&
      meta.error !== "meta_event_not_applicable" &&
      meta.error !== "meta_capi_token_absent" &&
      meta.error !== "meta_pixel_id_absent" &&
      meta.error !== "meta_capi_token_placeholder"
    ) {
      await deps.store.markFailed(row.id, `meta:${meta.error}`);
      failed += 1;
      continue;
    }
    if (!meta.ok) {
      logger.info(
        { eventId: row.id, error: meta.error },
        "pe lifecycle: Meta leg refused by name — GHL sent, event recorded",
      );
    }
    await deps.store.markSent(row.id);
    sent += 1;
  }
  return { processed: rows.length, sent, failed };
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

/**
 * Paid events (E4, E5) may only be enqueued from the Stripe webhook.
 * Any other source is a contract violation.
 */
export function assertPaidEventFromWebhook(
  event: LifecycleEventType,
  source: string,
): void {
  if (event !== "e4_unlock_bought" && event !== "e5_plan_started") return;
  if (source !== "stripe_webhook") {
    throw new Error(`paid_lifecycle_event_refused:${event}:source=${source}`);
  }
}
