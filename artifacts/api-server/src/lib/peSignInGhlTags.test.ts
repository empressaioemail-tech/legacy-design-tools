import { describe, expect, it, afterEach } from "vitest";
import { resetGhlCatalogCache } from "./peGhlCatalog";
import { completeGhlCatalogBodies } from "./peGhlCatalog.test";
import {
  enqueueLifecycleEvent,
  e1IdempotencyKey,
  e6IdempotencyKey,
  processLifecycleOutbox,
  memoryOutboxStore,
} from "./peLifecycleOutbox";
import { applyLifecycleToGhl } from "./peGhlLifecycle";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GHL upsert replaces the contact tag list with the request body. Tracks
 * what a contact would still have after E1 then E6 in one sign-in request.
 */
function mockGhlFetchReplacingTags(): {
  fetchImpl: typeof fetch;
  contactTags: () => string[];
} {
  const catalog = completeGhlCatalogBodies();
  let tags: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.includes("/opportunities/pipelines")) {
      return jsonResponse({ pipelines: catalog.pipelines });
    }
    if (url.includes("/tags")) {
      return jsonResponse({ tags: catalog.tags });
    }
    if (url.includes("/customFields")) {
      return jsonResponse({ customFields: catalog.customFields });
    }
    if (url.includes("/contacts/upsert") && method === "POST") {
      const next = body?.tags;
      if (Array.isArray(next)) {
        tags = next.filter((t): t is string => typeof t === "string");
      }
      return jsonResponse({ contact: { id: "ghl_c1" } }, 201);
    }
    if (url.includes("/opportunities")) {
      return jsonResponse({ opportunity: { id: "opp_1" } }, 201);
    }
    return jsonResponse({ message: "unexpected" }, 500);
  };
  return { fetchImpl, contactTags: () => [...tags] };
}

afterEach(() => {
  resetGhlCatalogCache();
});

describe("sign-in E1 then E6 must not strip ss_src_* from GHL", () => {
  it("leaves ss_src_direct on the contact after the E6 upsert", async () => {
    process.env["GOHIGHLEVEL_API_KEY"] = "test_ghl_key";
    process.env["GOHIGHLEVEL_LOCATION_ID"] = "test_ghl_location";

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

    const { fetchImpl, contactTags } = mockGhlFetchReplacingTags();
    const sendMeta = async () => ({ ok: true as const, eventName: "CompleteRegistration" });
    const ghlConfig = { apiKey: "test_ghl_key", locationId: "test_ghl_location" };
    const applyGhl = (input: Parameters<typeof applyLifecycleToGhl>[0]) =>
      applyLifecycleToGhl(input, { fetchImpl, config: ghlConfig });

    const result = await processLifecycleOutbox({ store, applyGhl, sendMeta });
    expect(result.sent).toBe(2);

    expect(contactTags()).toContain("ss_explorer");
    expect(contactTags()).toContain("ss_src_direct");

    delete process.env["GOHIGHLEVEL_API_KEY"];
    delete process.env["GOHIGHLEVEL_LOCATION_ID"];
  });
});
