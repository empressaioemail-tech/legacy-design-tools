/**
 * P-492 outbox falsifiers (plan section 6), against the in-memory store.
 * The SKIP LOCKED half (two concurrent drains, scheduled retry on a real
 * table) is `__tests__/pe-lifecycle-drain.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  LEG_ATTEMPT_CAP,
  aggregateStatus,
  assertPaidEventFromWebhook,
  backoffMs,
  e3IdempotencyKey,
  e6IdempotencyKey,
  enqueueLifecycleEvent,
  memoryOutboxStore,
  processLifecycleOutbox,
  type LegDeps,
} from "./peLifecycleOutbox";

const T0 = new Date("2026-10-03T12:00:00Z");

function enqueueE2(store: ReturnType<typeof memoryOutboxStore>, key = "e2:u1:2", userId = "u1") {
  return enqueueLifecycleEvent(
    {
      userId,
      email: `${userId}@example.com`,
      event: "e2_lot_saved",
      idempotencyKey: key,
      apply: { email: `${userId}@example.com`, event: "e2_lot_saved", savedLots: 2 },
    },
    store,
    T0,
  );
}

function deps(over: Partial<LegDeps> = {}): LegDeps & { calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = { local: [], resend: [], meta: [] };
  return {
    calls,
    now: () => T0,
    project: async (row) => {
      calls.local!.push(row.id);
      return { ok: true };
    },
    sendResend: async (row) => {
      calls.resend!.push(row.id);
      return { ok: true };
    },
    sendMeta: async (row) => {
      calls.meta!.push(row.id);
      return { ok: true };
    },
    ...over,
  };
}

describe("leg independence (falsifier: a forced Resend failure leaves Meta sent)", () => {
  it("Resend fails, Meta and local still send on the same pass", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const d = deps({ sendResend: async () => ({ ok: false, error: "resend_down" }) });
    const r = await processLifecycleOutbox({ store, ...d });
    expect(r.claimed).toBe(1);
    const row = store.rows[0]!;
    expect(row.legs.meta.status).toBe("sent");
    expect(row.legs.local.status).toBe("sent");
    expect(row.legs.resend.status).toBe("failed");
    expect(row.legs.resend.error).toBe("resend_down");
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("resend:resend_down");
  });

  it("Meta fails, Resend still sends", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const d = deps({ sendMeta: async () => ({ ok: false, error: "meta_capi_http_500" }) });
    await processLifecycleOutbox({ store, ...d });
    const row = store.rows[0]!;
    expect(row.legs.resend.status).toBe("sent");
    expect(row.legs.meta.status).toBe("failed");
  });

  it("a thrown leg is recorded on that leg and the others still run", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const d = deps({
      sendMeta: async () => {
        throw new Error("boom");
      },
    });
    await processLifecycleOutbox({ store, ...d });
    const row = store.rows[0]!;
    expect(row.legs.meta).toMatchObject({ status: "failed", error: "boom" });
    expect(row.legs.resend.status).toBe("sent");
  });

  it("Resend waits (not skipped) while the local projection is still open, and Meta does not wait", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const d = deps({ project: async () => ({ ok: false, error: "db_down" }) });
    await processLifecycleOutbox({ store, ...d });
    const row = store.rows[0]!;
    expect(row.legs.local.status).toBe("failed");
    expect(row.legs.resend).toMatchObject({ status: "pending", attempts: 0 });
    expect(row.legs.meta.status).toBe("sent");
    expect(d.calls.resend).toEqual([]);
  });

  it("a Meta refusal by name is recorded as skipped, not retried", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const d = deps({
      sendMeta: async () => ({ ok: false, error: "meta_capi_token_absent", refusedByName: true }),
    });
    await processLifecycleOutbox({ store, ...d });
    const row = store.rows[0]!;
    expect(row.legs.meta).toMatchObject({ status: "skipped", error: "meta_capi_token_absent" });
    expect(row.status).toBe("sent");
  });
});

describe("retry, backoff and the attempt cap", () => {
  it("a failed leg is retried once due, and only the failed leg runs again", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    let resendAttempts = 0;
    const d = deps({
      sendResend: async () => {
        resendAttempts += 1;
        return resendAttempts === 1 ? { ok: false, error: "resend_down" } : { ok: true };
      },
    });
    await processLifecycleOutbox({ store, ...d });
    // Not due yet: the backoff holds it.
    const early = await processLifecycleOutbox({ store, ...d, now: () => T0 });
    expect(early.claimed).toBe(0);
    const later = new Date(T0.getTime() + backoffMs(1));
    const second = await processLifecycleOutbox({ store, ...d, now: () => later });
    expect(second).toMatchObject({ claimed: 1, sent: 1 });
    const row = store.rows[0]!;
    expect(row.status).toBe("sent");
    expect(row.legs.resend.attempts).toBe(2);
    expect(d.calls.meta).toHaveLength(1);
    expect(d.calls.local).toHaveLength(1);
  });

  it(`a leg that fails ${LEG_ATTEMPT_CAP} times is dead, counted, and never claimed again`, async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    let resendCalls = 0;
    const d = deps({
      sendResend: async () => {
        resendCalls += 1;
        return { ok: false, error: "resend_down" };
      },
    });
    let clock = T0.getTime();
    let dead = 0;
    for (let i = 0; i < LEG_ATTEMPT_CAP + 3; i += 1) {
      const r = await processLifecycleOutbox({ store, ...d, now: () => new Date(clock) });
      dead += r.dead;
      clock += 61 * 60 * 1000;
    }
    const row = store.rows[0]!;
    expect(row.legs.resend).toMatchObject({ status: "dead", attempts: LEG_ATTEMPT_CAP });
    expect(row.status).toBe("dead");
    expect(dead).toBe(1);
    expect(resendCalls).toBe(LEG_ATTEMPT_CAP);
  });

  it("a dead local leg kills the waiting Resend leg instead of leaving it pending forever", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const d = deps({ project: async () => ({ ok: false, error: "db_down" }) });
    let clock = T0.getTime();
    for (let i = 0; i < LEG_ATTEMPT_CAP; i += 1) {
      await processLifecycleOutbox({ store, ...d, now: () => new Date(clock) });
      clock += 61 * 60 * 1000;
    }
    const row = store.rows[0]!;
    expect(row.legs.local.status).toBe("dead");
    expect(row.legs.resend).toMatchObject({ status: "dead", error: "local_leg_dead" });
    expect(row.status).toBe("dead");
  });

  it("backoff is 1, 2, 4 ... minutes, capped at 60", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(4 * 60_000);
    expect(backoffMs(11)).toBe(60 * 60_000);
  });

  it("aggregate status reads the legs", () => {
    const leg = (status: "pending" | "sent" | "failed" | "dead" | "skipped") => ({
      status,
      attempts: 0,
      error: null,
    });
    expect(aggregateStatus({ local: leg("sent"), resend: leg("skipped"), meta: leg("sent") })).toBe("sent");
    expect(aggregateStatus({ local: leg("sent"), resend: leg("dead"), meta: leg("sent") })).toBe("dead");
    expect(aggregateStatus({ local: leg("failed"), resend: leg("pending"), meta: leg("dead") })).toBe("failed");
  });
});

describe("the request path never drains other users' rows", () => {
  it("processing with ids claims only that row", async () => {
    const store = memoryOutboxStore();
    const a = await enqueueE2(store, "e2:a:1", "a");
    await enqueueE2(store, "e2:b:1", "b");
    const d = deps();
    const r = await processLifecycleOutbox({ store, ids: [a.eventId], limit: 1, ...d });
    expect(r.claimed).toBe(1);
    expect(d.calls.local).toEqual([a.eventId]);
    expect(store.rows.find((x) => x.subject.kind === "user" && x.subject.userId === "b")?.status).toBe("pending");
  });

  it("a claimed (leased) row is not claimed a second time while the lease holds", async () => {
    const store = memoryOutboxStore();
    await enqueueE2(store);
    const first = await store.claimDue({ now: T0, limit: 10, leaseMs: 60_000 });
    const second = await store.claimDue({ now: T0, limit: 10, leaseMs: 60_000 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("enqueue", () => {
  it("duplicate idempotency keys do not enqueue a second row and return the stored id", async () => {
    const store = memoryOutboxStore();
    const first = await enqueueE2(store);
    const second = await enqueueE2(store);
    expect(first.enqueued).toBe(true);
    expect(second).toEqual({ eventId: first.eventId, enqueued: false });
    expect(store.rows).toHaveLength(1);
  });

  it("an affiliate row starts with local and meta skipped", async () => {
    const store = memoryOutboxStore();
    await enqueueLifecycleEvent(
      {
        affiliatePartnerId: "9b0f3f8e-0000-4000-8000-000000000001",
        email: "aff@example.com",
        event: "affiliate_applied",
        idempotencyKey: "affiliate_applied:x",
        apply: { event: "affiliate_applied" },
      },
      store,
      T0,
    );
    const row = store.rows[0]!;
    expect(row.subject.kind).toBe("affiliate");
    expect(row.legs.local.status).toBe("skipped");
    expect(row.legs.meta.status).toBe("skipped");
    expect(row.legs.resend.status).toBe("pending");
  });

  it("a user event cannot be filed against an affiliate and vice versa", async () => {
    const store = memoryOutboxStore();
    await expect(
      enqueueLifecycleEvent(
        { affiliatePartnerId: "x", email: "a@b.com", event: "e2_lot_saved", idempotencyKey: "k", apply: {} },
        store,
      ),
    ).rejects.toThrow(/lifecycle_subject_invalid/);
    expect(store.rows).toHaveLength(0);
  });
});

describe("sovereignty (falsifier: an APN-shaped payload is refused before insert)", () => {
  const base = {
    userId: "u1",
    email: "a@b.com",
    event: "e2_lot_saved" as const,
    idempotencyKey: "e2:u1:9",
  };

  for (const key of ["apn", "parcel_id", "parcelNodeId", "situs_address", "owner_name", "address"]) {
    it(`refuses a payload carrying "${key}" and writes no row`, async () => {
      const store = memoryOutboxStore();
      await expect(
        enqueueLifecycleEvent({ ...base, apply: { event: "e2_lot_saved", [key]: "48053-R12345" } }, store),
      ).rejects.toThrow(/lifecycle_payload_denied|lifecycle_payload_key_not_allowed/);
      expect(store.rows).toHaveLength(0);
    });
  }

  it("refuses an unknown key even when it is not on the denylist (allowlist)", async () => {
    const store = memoryOutboxStore();
    await expect(
      enqueueLifecycleEvent({ ...base, apply: { event: "e2_lot_saved", lotRef: "R12345" } }, store),
    ).rejects.toThrow(/lifecycle_payload_key_not_allowed: lotRef/);
    expect(store.rows).toHaveLength(0);
  });

  it("refuses a nested object under an allowed key", async () => {
    const store = memoryOutboxStore();
    await expect(
      enqueueLifecycleEvent(
        { ...base, apply: { event: "e2_lot_saved", campaign: { apn: "1" } as unknown as string } },
        store,
      ),
    ).rejects.toThrow(/lifecycle_payload_denied/);
    expect(store.rows).toHaveLength(0);
  });
});

describe("paid events only from the Stripe webhook", () => {
  for (const event of ["e4_unlock_bought", "e5_plan_started", "plan_cancelled"] as const) {
    it(`${event} from any non-webhook source throws`, () => {
      expect(() => assertPaidEventFromWebhook(event, "app")).toThrow(
        new RegExp(`paid_lifecycle_event_refused:${event}:source=app`),
      );
      expect(() => assertPaidEventFromWebhook(event, "stripe_webhook")).not.toThrow();
    });
  }

  it("non-paid events are unaffected", () => {
    expect(() => assertPaidEventFromWebhook("e2_lot_saved", "app")).not.toThrow();
  });
});

describe("idempotency keys", () => {
  it("E6 is once per user per UTC day; E3 is per share grant", () => {
    expect(e6IdempotencyKey("u1", new Date("2026-10-03T23:59:00Z"))).toBe("e6:u1:2026-10-03");
    expect(e3IdempotencyKey("g1")).toBe("e3:g1");
  });
});
