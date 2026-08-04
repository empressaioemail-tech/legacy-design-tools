/**
 * Onboarding ledger events read, OPS-9 S1 follow-on.
 *
 * Asserts the pinned contract:
 *   - GET /api/onboarding-ledger/events is Bearer-gated (anonymous / wrong
 *     key -> 401, no session fallback), same idiom as the ingest route.
 *   - rowId is required (422 without it).
 *   - Filters by rowId (only that row's events, other rows excluded).
 *   - Filters by status when present ("open" | "resolved"; invalid -> 422).
 *   - Paginates via limit/offset, echoing total/limit/offset; newest-first
 *     ordering (lastSeenAt DESC, id DESC).
 *   - limit is capped at 500.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL, CI-authoritative when unset.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, onboardingLedgerEvent } from "@workspace/db";

import { vi } from "vitest";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("onboardingLedgerEvents.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

const TEST_SERVICE_TOKEN = "test-onboarding-ledger-events-service-token-xyz";
const EVENTS_PATH = "/api/onboarding-ledger/events";
const serviceAuth = { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` };

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  process.env.SERVICE_API_KEY = TEST_SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

/** Seeds N onboarding_ledger_event rows directly (bypassing the ingest
 * route) so this suite's fixtures are independent of ingest behavior. */
async function seedEvents(
  rows: Array<{
    rowId: string;
    fips: string;
    defectClass: string;
    status?: "open" | "resolved";
    lastSeenAt: Date;
    parcelNodeId?: string | null;
  }>,
) {
  for (const r of rows) {
    await db.insert(onboardingLedgerEvent).values({
      ts: r.lastSeenAt,
      fips: r.fips,
      rowId: r.rowId,
      parcelNodeId: r.parcelNodeId ?? "",
      sourceKind: "preflight",
      railOrCheck: "railASourceReachable",
      checkId: "",
      defectClass: r.defectClass,
      status: r.status ?? "open",
      lastSeenAt: r.lastSeenAt,
    });
  }
}

describe("GET /api/onboarding-ledger/events, auth gate", () => {
  it("rejects an anonymous request with 401 (no session fallback)", async () => {
    const res = await request(getApp()).get(EVENTS_PATH).query({ rowId: "Elgin" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set("Authorization", "Bearer wrong-token")
      .query({ rowId: "Elgin" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/onboarding-ledger/events, query validation", () => {
  it("422s when rowId is missing", async () => {
    const res = await request(getApp()).get(EVENTS_PATH).set(serviceAuth);
    expect(res.status).toBe(422);
  });

  it("422s an invalid status value", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Elgin", status: "not-a-real-status" });
    expect(res.status).toBe(422);
  });
});

describe("GET /api/onboarding-ledger/events, rowId + status filtering", () => {
  beforeEach(async () => {
    await seedEvents([
      {
        rowId: "Elgin",
        fips: "48021",
        defectClass: "ADAPTER-NEEDED",
        status: "open",
        lastSeenAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        rowId: "Elgin",
        fips: "48021",
        defectClass: "BLOCK13-QUARANTINE",
        status: "resolved",
        lastSeenAt: new Date("2026-08-02T00:00:00.000Z"),
        parcelNodeId: "48021:34145",
      },
      {
        rowId: "Bastrop",
        fips: "48021",
        defectClass: "ADAPTER-NEEDED",
        status: "open",
        lastSeenAt: new Date("2026-08-03T00:00:00.000Z"),
      },
    ]);
  });

  it("returns only the requested rowId's events", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Elgin" });
    expect(res.status).toBe(200);
    expect(res.body.rowId).toBe("Elgin");
    expect(res.body.total).toBe(2);
    expect(res.body.events).toHaveLength(2);
    for (const ev of res.body.events) {
      expect(ev.rowId).toBe("Elgin");
    }
  });

  it("filters by status=open", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Elgin", status: "open" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].defectClass).toBe("ADAPTER-NEEDED");
    expect(res.body.events[0].status).toBe("open");
  });

  it("filters by status=resolved", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Elgin", status: "resolved" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.events[0].defectClass).toBe("BLOCK13-QUARANTINE");
    expect(res.body.events[0].parcelNodeId).toBe("48021:34145");
  });

  it("returns events newest-first (lastSeenAt DESC)", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Elgin" });
    expect(res.status).toBe(200);
    const tsList = res.body.events.map((e: { lastSeenAt: string }) => e.lastSeenAt);
    expect(tsList[0]).toBe("2026-08-02T00:00:00.000Z");
    expect(tsList[1]).toBe("2026-08-01T00:00:00.000Z");
  });

  it("normalizes the empty-string storage sentinel back to null on the wire", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Elgin", status: "open" });
    expect(res.status).toBe(200);
    // The open Elgin/ADAPTER-NEEDED row was seeded with parcelNodeId
    // defaulted to "" (not present) and checkId "" (not present); both
    // must come back as null, not the empty string.
    expect(res.body.events[0].parcelNodeId).toBeNull();
    expect(res.body.events[0].checkId).toBeNull();
    expect(res.body.events[0].railOrCheck).toBe("railASourceReachable");
  });

  it("a rowId with no matching events returns an empty list, not a 404", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "NoSuchRow" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.events).toEqual([]);
  });
});

describe("GET /api/onboarding-ledger/events, pagination", () => {
  beforeEach(async () => {
    // Five open events on the same row, distinct lastSeenAt so ordering is
    // deterministic.
    await seedEvents(
      Array.from({ length: 5 }, (_, i) => ({
        rowId: "Bastrop",
        fips: "48021",
        defectClass: `DEFECT-${i}`,
        status: "open" as const,
        lastSeenAt: new Date(Date.UTC(2026, 7, 1, i)),
      })),
    );
  });

  it("paginates via limit + offset and reports the unfiltered-by-page total", async () => {
    const page1 = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Bastrop", limit: 2, offset: 0 });
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(5);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);
    expect(page1.body.events).toHaveLength(2);

    const page2 = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Bastrop", limit: 2, offset: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(5);
    expect(page2.body.offset).toBe(2);
    expect(page2.body.events).toHaveLength(2);

    const page1Ids = page1.body.events.map((e: { id: string }) => e.id);
    const page2Ids = page2.body.events.map((e: { id: string }) => e.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  it("defaults to limit=100, offset=0 when unspecified", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Bastrop" });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.events).toHaveLength(5);
  });

  it("caps limit at 500 even when a larger value is requested", async () => {
    const res = await request(getApp())
      .get(EVENTS_PATH)
      .set(serviceAuth)
      .query({ rowId: "Bastrop", limit: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
  });
});
