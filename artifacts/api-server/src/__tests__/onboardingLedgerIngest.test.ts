/**
 * Onboarding ledger ingest, OPS-9 S1.
 *
 * Asserts the pinned contract:
 *   - POST /api/onboarding-ledger/ingest is Bearer-gated (anonymous / wrong
 *     key -> 401, no session fallback).
 *   - rowMirror upserts jurisdiction_registry_row_mirror.
 *   - gateSummary/certSummary upsert county_gate_cert_state, and a
 *     cert-grade-only re-ingest does not null out a prior preflight's gate
 *     counts (and vice versa).
 *   - events insert into onboarding_ledger_event; re-ingesting the same
 *     open natural key (rowId, parcelNodeId, defectClass, railOrCheck,
 *     checkId) bumps lastSeenAt on the existing row instead of duplicating
 *     it (idempotent re-ingest).
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL, CI-authoritative when unset.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import {
  db,
  onboardingLedgerEvent,
  jurisdictionRegistryRowMirror,
  countyGateCertState,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import { vi } from "vitest";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("onboardingLedgerIngest.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

const TEST_SERVICE_TOKEN = "test-onboarding-ledger-service-token-xyz";
const INGEST_PATH = "/api/onboarding-ledger/ingest";
const serviceAuth = { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` };

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  process.env.SERVICE_API_KEY = TEST_SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

describe("POST /api/onboarding-ledger/ingest, auth gate", () => {
  it("rejects an anonymous request with 401 (no session fallback)", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .send({ sourceKind: "preflight", events: [] });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set("Authorization", "Bearer wrong-token")
      .send({ sourceKind: "preflight", events: [] });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/onboarding-ledger/ingest, rowMirror upsert", () => {
  it("inserts a new mirror row", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        rowMirror: [
          {
            rowId: "Elgin",
            fips: "48021",
            countyName: "Elgin",
            status: "pre-flight-pending",
            zoningRegime: "euclidean-zoned",
          },
        ],
        events: [],
      });

    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(jurisdictionRegistryRowMirror)
      .where(eq(jurisdictionRegistryRowMirror.rowId, "Elgin"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowId: "Elgin",
      fips: "48021",
      countyName: "Elgin",
      status: "pre-flight-pending",
    });
  });

  it("upserts (updates status) on a second ingest for the same rowId", async () => {
    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        rowMirror: [
          { rowId: "Elgin", fips: "48021", countyName: "Elgin", status: "pre-flight-pending", zoningRegime: "euclidean-zoned" },
        ],
        events: [],
      });

    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        rowMirror: [
          { rowId: "Elgin", fips: "48021", countyName: "Elgin", status: "active", zoningRegime: "euclidean-zoned" },
        ],
        events: [],
      });

    const rows = await db
      .select()
      .from(jurisdictionRegistryRowMirror)
      .where(eq(jurisdictionRegistryRowMirror.rowId, "Elgin"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });
});

describe("POST /api/onboarding-ledger/ingest, gateSummary / certSummary upsert", () => {
  it("a cert-grade-only re-ingest does not null out a prior preflight gateSummary", async () => {
    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        events: [],
        gateSummary: {
          rowId: "Bastrop",
          fips: "48021",
          passCount: 8,
          declineCount: 0,
          checks: [{ id: "railASourceReachable", outcome: "PASS" }],
        },
      });

    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "cert-grade",
        events: [],
        certSummary: {
          rowId: "Bastrop",
          fips: "48021",
          label: "7/7",
          blockPass: true,
          gradedAt: "2026-08-03T00:00:00.000Z",
        },
      });

    const rows = await db
      .select()
      .from(countyGateCertState)
      .where(eq(countyGateCertState.rowId, "Bastrop"));
    expect(rows).toHaveLength(1);
    expect(rows[0].gatePassCount).toBe(8);
    expect(rows[0].gateDeclineCount).toBe(0);
    expect(rows[0].certLabel).toBe("7/7");
    expect(rows[0].certBlockPass).toBe(true);
  });
});

describe("POST /api/onboarding-ledger/ingest, idempotent event re-ingest", () => {
  it("re-ingesting the same open natural key bumps lastSeenAt instead of duplicating", async () => {
    const firstTs = "2026-08-03T00:00:00.000Z";
    const secondTs = "2026-08-03T01:00:00.000Z";

    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        events: [
          {
            ts: firstTs,
            fips: "48021",
            rowId: "Elgin",
            railOrCheck: "railASourceReachable",
            defectClass: "ADAPTER-NEEDED",
            declineReason: "source unreachable, needs adapter: no Rail A layer wired for this row",
          },
        ],
      });

    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        events: [
          {
            ts: secondTs,
            fips: "48021",
            rowId: "Elgin",
            railOrCheck: "railASourceReachable",
            defectClass: "ADAPTER-NEEDED",
            declineReason: "source unreachable, needs adapter: no Rail A layer wired for this row",
          },
        ],
      });

    const rows = await db
      .select()
      .from(onboardingLedgerEvent)
      .where(eq(onboardingLedgerEvent.rowId, "Elgin"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].lastSeenAt.toISOString()).toBe(secondTs);
  });

  it("a different defectClass for the same row does not collide with an existing open event", async () => {
    await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "preflight",
        events: [
          {
            ts: "2026-08-03T00:00:00.000Z",
            fips: "48021",
            rowId: "Elgin",
            railOrCheck: "railASourceReachable",
            defectClass: "ADAPTER-NEEDED",
          },
          {
            ts: "2026-08-03T00:00:00.000Z",
            fips: "48021",
            rowId: "Elgin",
            railOrCheck: "zoningSourceReachableOrUnzoned",
            defectClass: "ADAPTER-NEEDED",
          },
        ],
      });

    const rows = await db
      .select()
      .from(onboardingLedgerEvent)
      .where(eq(onboardingLedgerEvent.rowId, "Elgin"));
    expect(rows).toHaveLength(2);
  });

  it("block13-quarantine events carry a parcelNodeId and defectClass BLOCK13-QUARANTINE", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({
        sourceKind: "block13-quarantine",
        rowMirror: [
          { rowId: "Bastrop", fips: "48021", countyName: "Bastrop", status: "active", zoningRegime: "euclidean-zoned" },
        ],
        events: [
          {
            ts: "2026-08-03T00:00:00.000Z",
            fips: "48021",
            rowId: "Bastrop",
            parcelNodeId: "48021:34145",
            defectClass: "BLOCK13-QUARANTINE",
            severity: "info",
          },
        ],
      });

    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(onboardingLedgerEvent)
      .where(eq(onboardingLedgerEvent.parcelNodeId, "48021:34145"));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceKind).toBe("block13-quarantine");
    expect(rows[0].defectClass).toBe("BLOCK13-QUARANTINE");
  });
});

describe("POST /api/onboarding-ledger/ingest, body validation", () => {
  it("422s an invalid sourceKind", async () => {
    const res = await request(getApp())
      .post(INGEST_PATH)
      .set(serviceAuth)
      .send({ sourceKind: "not-a-real-kind", events: [] });
    expect(res.status).toBe(422);
  });
});
