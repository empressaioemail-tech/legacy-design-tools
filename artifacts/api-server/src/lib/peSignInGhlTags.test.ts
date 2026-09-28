import { describe, expect, it, afterEach } from "vitest";
import { resetGhlCatalogCache } from "./peGhlCatalog";
import { mockGhlFetch } from "./peGhlCatalog.test";
import {
  enqueueLifecycleEvent,
  e1IdempotencyKey,
  e3IdempotencyKey,
  e5IdempotencyKey,
  e6IdempotencyKey,
  processLifecycleOutbox,
  memoryOutboxStore,
} from "./peLifecycleOutbox";
import { applyLifecycleToGhl } from "./peGhlLifecycle";

afterEach(() => {
  resetGhlCatalogCache();
});

describe("GHL lifecycle tags are additive (never upsert tags)", () => {
  const ghlConfig = { apiKey: "test_ghl_key", locationId: "test_ghl_location" };

  it("E1 then E6 on sign-in keeps ss_src_direct", async () => {
    const store = memoryOutboxStore();
    const userId = "u-signin-1";
    const email = "nickdraft6@gmail.com";
    const day = "2026-09-28";

    await enqueueLifecycleEvent(
      {
        userId,
        email,
        event: "e1_account_created",
        idempotencyKey: e1IdempotencyKey(userId),
        apply: {
          email,
          displayName: "Nick Draft",
          event: "e1_account_created",
          plan: "free",
          billing: "none",
        },
      },
      store,
    );
    await enqueueLifecycleEvent(
      {
        userId,
        email,
        event: "e6_last_active",
        idempotencyKey: e6IdempotencyKey(userId, new Date(`${day}T12:00:00.000Z`)),
        apply: {
          email,
          event: "e6_last_active",
          lastActive: day,
        },
      },
      store,
    );

    const { fetchImpl, contactTags } = mockGhlFetch();
    const sendMeta = async () => ({ ok: true as const, eventName: "CompleteRegistration" });
    const applyGhl = (input: Parameters<typeof applyLifecycleToGhl>[0]) =>
      applyLifecycleToGhl(input, { fetchImpl, config: ghlConfig });

    const result = await processLifecycleOutbox({ store, applyGhl, sendMeta });
    expect(result.sent).toBe(2);
    expect(contactTags()).toContain("ss_explorer");
    expect(contactTags()).toContain("ss_src_direct");
  });

  it("E1 → E3 → E5 keeps ss_src_direct and a pre-existing foreign tag", async () => {
    const store = memoryOutboxStore();
    const userId = "u-lifecycle-1";
    const email = "lifecycle@example.com";
    const foreignTag = "ss_quiet";

    await enqueueLifecycleEvent(
      {
        userId,
        email,
        event: "e1_account_created",
        idempotencyKey: e1IdempotencyKey(userId),
        apply: {
          email,
          event: "e1_account_created",
          plan: "free",
          billing: "none",
        },
      },
      store,
    );
    await enqueueLifecycleEvent(
      {
        userId,
        email,
        event: "e3_share_sent",
        idempotencyKey: e3IdempotencyKey("grant-1"),
        apply: {
          email,
          event: "e3_share_sent",
          shares: 1,
        },
      },
      store,
    );
    await enqueueLifecycleEvent(
      {
        userId,
        email,
        event: "e5_plan_started",
        idempotencyKey: e5IdempotencyKey("stripe_evt_1"),
        apply: {
          email,
          event: "e5_plan_started",
          plan: "solo",
          billing: "annual",
          currentStage: "Sharer",
        },
      },
      store,
    );

    const { fetchImpl, contactTags } = mockGhlFetch({
      seedContactTags: [foreignTag],
    });
    const sendMeta = async () => ({ ok: true as const, eventName: "ShareSent" });
    const applyGhl = (input: Parameters<typeof applyLifecycleToGhl>[0]) =>
      applyLifecycleToGhl(input, { fetchImpl, config: ghlConfig });

    const result = await processLifecycleOutbox({ store, applyGhl, sendMeta });
    expect(result.sent).toBe(3);

    const tags = contactTags();
    expect(tags).toContain(foreignTag);
    expect(tags).toContain("ss_src_direct");
    expect(tags).toContain("ss_solo");
    expect(tags).toContain("ss_annual");
    expect(tags).not.toContain("ss_explorer");
    expect(tags).not.toContain("ss_sharer");
  });
});
