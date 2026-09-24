import { describe, expect, it } from "vitest";
import {
  assertPaidEventFromWebhook,
  e6IdempotencyKey,
  enqueueLifecycleEvent,
  memoryOutboxStore,
  processLifecycleOutbox,
} from "./peLifecycleOutbox";

const APPLY = {
  email: "a@b.com",
  event: "e2_lot_saved" as const,
  savedLots: 2,
};

describe("outbox retry", () => {
  it("a failed send is retried to success", async () => {
    const store = memoryOutboxStore();
    await enqueueLifecycleEvent(
      {
        userId: "u1",
        email: "a@b.com",
        event: "e2_lot_saved",
        idempotencyKey: "e2:u1:2",
        apply: APPLY,
      },
      store,
    );

    let ghlAttempts = 0;
    const applyGhl = async () => {
      ghlAttempts += 1;
      if (ghlAttempts === 1) return { ok: false as const, error: "ghl_down" };
      return {
        ok: true as const,
        contactId: "c1",
        stage: "Explorer" as const,
        tags: ["ss_explorer"],
        sourceTag: null,
      };
    };
    const sendMeta = async () => ({ ok: true as const, eventName: "LotSaved" });

    const first = await processLifecycleOutbox({ store, applyGhl, sendMeta });
    expect(first.failed).toBe(1);
    expect(first.sent).toBe(0);
    const afterFail = await store.listSendable();
    expect(afterFail[0]?.status).toBe("failed");
    expect(afterFail[0]?.lastError).toBe("ghl:ghl_down");

    const second = await processLifecycleOutbox({ store, applyGhl, sendMeta });
    expect(second.sent).toBe(1);
    expect(second.failed).toBe(0);
    expect(await store.listSendable()).toEqual([]);
    expect(ghlAttempts).toBe(2);
  });

  it("duplicate idempotency keys do not enqueue a second send", async () => {
    const store = memoryOutboxStore();
    const first = await enqueueLifecycleEvent(
      {
        userId: "u1",
        email: "a@b.com",
        event: "e2_lot_saved",
        idempotencyKey: "e2:u1:2",
        apply: APPLY,
        eventId: "evt-1",
      },
      store,
    );
    const second = await enqueueLifecycleEvent(
      {
        userId: "u1",
        email: "a@b.com",
        event: "e2_lot_saved",
        idempotencyKey: "e2:u1:2",
        apply: APPLY,
        eventId: "evt-2",
      },
      store,
    );
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect((await store.listSendable()).map((r) => r.id)).toEqual(["evt-1"]);
  });
});

describe("E6 once-a-day throttle on a fixed clock", () => {
  it("the same user on the same UTC day shares one idempotency key", () => {
    const morning = new Date("2026-09-24T08:15:00.000Z");
    const evening = new Date("2026-09-24T23:59:00.000Z");
    const next = new Date("2026-09-25T00:00:00.000Z");
    expect(e6IdempotencyKey("u1", morning)).toBe("e6:u1:2026-09-24");
    expect(e6IdempotencyKey("u1", evening)).toBe("e6:u1:2026-09-24");
    expect(e6IdempotencyKey("u1", next)).toBe("e6:u1:2026-09-25");
    expect(e6IdempotencyKey("u2", morning)).toBe("e6:u2:2026-09-24");
  });

  it("a second enqueue the same day is a duplicate and is not sent again", async () => {
    const store = memoryOutboxStore();
    const clock = new Date("2026-09-24T12:00:00.000Z");
    const key = e6IdempotencyKey("u1", clock);
    await enqueueLifecycleEvent(
      {
        userId: "u1",
        email: "a@b.com",
        event: "e6_last_active",
        idempotencyKey: key,
        apply: { email: "a@b.com", event: "e6_last_active", lastActive: "2026-09-24" },
      },
      store,
    );
    let sent = 0;
    const applyGhl = async () => {
      sent += 1;
      return {
        ok: true as const,
        contactId: "c1",
        stage: "Explorer" as const,
        tags: ["ss_explorer"],
        sourceTag: null,
      };
    };
    await processLifecycleOutbox({
      store,
      applyGhl,
      sendMeta: async () => ({ ok: false as const, error: "meta_event_not_applicable" }),
      now: () => clock,
    });
    expect(sent).toBe(1);

    const again = await enqueueLifecycleEvent(
      {
        userId: "u1",
        email: "a@b.com",
        event: "e6_last_active",
        idempotencyKey: e6IdempotencyKey("u1", new Date("2026-09-24T18:00:00.000Z")),
        apply: { email: "a@b.com", event: "e6_last_active", lastActive: "2026-09-24" },
      },
      store,
    );
    expect(again.enqueued).toBe(false);
    await processLifecycleOutbox({
      store,
      applyGhl,
      sendMeta: async () => ({ ok: false as const, error: "meta_event_not_applicable" }),
    });
    expect(sent).toBe(1);
  });
});

describe("E4/E5 unreachable except from the webhook", () => {
  it("refuses a paid event from any non-webhook source", () => {
    expect(() =>
      assertPaidEventFromWebhook("e4_unlock_bought", "checkout_return"),
    ).toThrow(/paid_lifecycle_event_refused/);
    expect(() =>
      assertPaidEventFromWebhook("e5_plan_started", "client"),
    ).toThrow(/paid_lifecycle_event_refused/);
    expect(() =>
      assertPaidEventFromWebhook("e4_unlock_bought", "stripe_webhook"),
    ).not.toThrow();
    expect(() =>
      assertPaidEventFromWebhook("e1_account_created", "app"),
    ).not.toThrow();
  });
});
