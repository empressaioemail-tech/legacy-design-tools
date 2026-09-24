import { and, eq, inArray, sql } from "drizzle-orm";
import { db, peLifecycleOutbox } from "@workspace/db";
import type { LifecycleEventType } from "./peLifecycleTypes";
import type { OutboxRecord, OutboxStore } from "./peLifecycleOutbox";

export function drizzleOutboxStore(): OutboxStore {
  return {
    async insert(row) {
      try {
        await db.insert(peLifecycleOutbox).values({
          id: row.id,
          ownerUserId: row.ownerUserId,
          eventType: row.eventType,
          idempotencyKey: row.idempotencyKey,
          email: row.email,
          payloadJson: row.payload,
          status: "pending",
          attempts: 0,
        });
        return "inserted";
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (/unique|duplicate/i.test(message)) return "duplicate";
        throw err;
      }
    },
    async listSendable() {
      const found = await db
        .select()
        .from(peLifecycleOutbox)
        .where(inArray(peLifecycleOutbox.status, ["pending", "failed"]))
        .limit(50);
      return found.map((r) => ({
        id: r.id,
        ownerUserId: r.ownerUserId,
        eventType: r.eventType as LifecycleEventType,
        idempotencyKey: r.idempotencyKey,
        email: r.email,
        payload: (r.payloadJson ?? {}) as Record<string, unknown>,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
      }));
    },
    async markSent(id) {
      await db
        .update(peLifecycleOutbox)
        .set({
          status: "sent",
          sentAt: new Date(),
          lastError: null,
          attempts: sql`${peLifecycleOutbox.attempts} + 1`,
        })
        .where(eq(peLifecycleOutbox.id, id));
    },
    async markFailed(id, error) {
      await db
        .update(peLifecycleOutbox)
        .set({
          status: "failed",
          lastError: error,
          attempts: sql`${peLifecycleOutbox.attempts} + 1`,
        })
        .where(and(eq(peLifecycleOutbox.id, id)));
    },
  };
}
