/**
 * Plan-review report-run status GET — honest contract for the no-run and
 * malformed-id cases (regression guard for the prod 500).
 *
 * The bug: GET /plan-review/engagements/:id/reports/:type returned HTTP 500
 * for any report type whose engagement id was a non-uuid (the live probe used
 * the truncated id `33ba88d7`). Every report type that fell PAST the early
 * `running`-row return reached `loadReviewerBffEngagement`, whose Drizzle
 * `WHERE id = $1` runs against a `uuid` column; Postgres throws
 * `invalid input syntax for type uuid` on a non-uuid, surfacing as an
 * unhandled 500. A type WITH a running run-row (drainage on prod) returned
 * `running` before that query, which is why ONLY the no-row types 500'd.
 *
 * The bug PRE-DATED the durable run-state PR (#253): the null run-row path
 * itself always returned a clean not-run; the throw was the engagement uuid
 * query, present in the in-memory version too. So this suite asserts both
 * halves — the malformed id is a clean 404 (not a 500) for EVERY report type,
 * AND the valid-engagement paths (no row → not-run, running row → running,
 * stale running → error) are unchanged.
 *
 * Uses the real-PG route harness (withTestSchema via setup.ts). Requires
 * TEST_DATABASE_URL / DATABASE_URL — CI-authoritative when unset.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { db, engagements } from "@workspace/db";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";
import {
  markReportRunError,
  markReportRunOk,
  markReportRunRunning,
} from "../lib/reportRunState";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("planReviewReportStatus.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

/**
 * Every report type the tiles poll. Each falls past the early running-row
 * return when unstarted, so each is a distinct chance to hit the uuid query
 * (subsurface/encumbrances/hydrology have NO derived-row loader — they returned
 * 500 on prod purely because of the shared engagement lookup, not a
 * type-specific throw).
 */
const REPORT_TYPES = [
  "topography",
  "drainage",
  "hydrology",
  "subsurface",
  "encumbrances",
] as const;

async function seedEngagement(): Promise<string> {
  const [row] = await db
    .insert(engagements)
    .values({
      name: "Report Status Eng",
      nameLower: "report status eng",
      ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
      jurisdiction: "bastrop-tx",
      address: "1 Status Way, Bastrop TX",
    })
    .returning();
  return row!.id;
}

describe("report status GET — malformed (non-uuid) engagement id is a clean 404, not a 500", () => {
  // The literal prod id from the live probe, plus a couple of other non-uuid
  // shapes so the guard is not narrowly coupled to the 8-hex-char form.
  for (const badId of ["33ba88d7", "not-a-uuid", "123"]) {
    for (const type of REPORT_TYPES) {
      it(`id=${badId} type=${type} → 404 engagement_not_found (was 500)`, async () => {
        const res = await request(getApp()).get(
          `/api/plan-review/engagements/${badId}/reports/${type}`,
        );
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "engagement_not_found" });
      });
    }
  }
});

describe("report status GET — valid engagement, unstarted report returns honest not-run", () => {
  let engagementId: string;
  beforeEach(async () => {
    engagementId = await seedEngagement();
  });

  for (const type of REPORT_TYPES) {
    it(`type=${type} with NO run-row → 200 not-run (never 500)`, async () => {
      const res = await request(getApp()).get(
        `/api/plan-review/engagements/${engagementId}/reports/${type}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not-run");
    });
  }
});

describe("report status GET — existing run-row status is unchanged", () => {
  let engagementId: string;
  beforeEach(async () => {
    engagementId = await seedEngagement();
  });

  it("a running row surfaces status=running (early return, no engagement query)", async () => {
    await markReportRunRunning(
      engagementId,
      "drainage",
      "gen-run-1",
      Date.now(),
      ctx.schema!.db,
    );
    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/reports/drainage`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    expect(res.body.generationId).toBe("gen-run-1");
  });

  it("a stale running row surfaces status=error via the watchdog (not forever-running)", async () => {
    // Started far enough in the past to exceed the watchdog budget + grace.
    await markReportRunRunning(
      engagementId,
      "topography",
      "gen-stale-1",
      Date.now() - 60 * 60 * 1000,
      ctx.schema!.db,
    );
    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/reports/topography`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(String(res.body.error)).toContain("watchdog-stale");
  });

  it("an error row surfaces status=error with its true reason (not not-run)", async () => {
    // topography with an error row and no derived-topography row → the failure
    // signal must win over not-run.
    await markReportRunError(
      engagementId,
      "topography",
      "no-geocode",
      "address did not geocode",
      "gen-err-1",
      ctx.schema!.db,
    );
    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/reports/topography`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(String(res.body.error)).toContain("no-geocode");
  });

  it("an inline-ok subsurface row surfaces status=ok with its result", async () => {
    await markReportRunOk(
      engagementId,
      "subsurface",
      "gen-ok-1",
      { status: "ok", result: { mapunit: "TeC2", pct: 55 } },
      {},
      ctx.schema!.db,
    );
    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/reports/subsurface`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.result).toEqual({ mapunit: "TeC2", pct: 55 });
  });
});
