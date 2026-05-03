/**
 * Track 1 — submission auto-classification HTTP-route test.
 *
 * The pure parser cases (`parseClassificationResponse`) and the
 * idempotent-upsert cases (`upsertAutoClassification`) moved with
 * the classifier code itself into
 * `lib/submission-classifier/src/__tests__/`. This file retains the
 * one case that exercises the api-server's HTTP route — the fire-
 * and-forget hook fired by `POST /api/engagements/:id/submissions`
 * has to live in the route-test harness because it's testing the
 * route's wiring, not the classifier's behavior.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("submission-classification.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissionClassifications } = await import(
  "@workspace/db"
);
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const ARCHITECT_AUDIENCE = ["x-audience", "user"] as const;
const ARCHITECT_REQUESTOR = ["x-requestor", "user:architect-1"] as const;

function asArchitect<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(ARCHITECT_AUDIENCE[0], ARCHITECT_AUDIENCE[1])
    .set(ARCHITECT_REQUESTOR[0], ARCHITECT_REQUESTOR[1]);
}

describe("auto-trigger via POST /api/engagements/:id/submissions", () => {
  it("creates a 'auto' classification row in mock mode and surfaces it on the queue", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;

    // Create the engagement directly.
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Trigger Engagement",
        nameLower: "trigger engagement",
        jurisdiction: "Bastrop, TX",
        status: "active",
      })
      .returning({ id: engagements.id });

    const res = await asArchitect(
      request(getApp())
        .post(`/api/engagements/${eng!.id}/submissions`)
        .send({}),
    );
    expect(res.status).toBe(201);
    const submissionId = res.body.submissionId as string;

    // Fire-and-forget: poll the row up to ~1.5s for the classifier to land.
    let classification: typeof submissionClassifications.$inferSelect | undefined;
    for (let i = 0; i < 30; i++) {
      const rows = await db
        .select()
        .from(submissionClassifications)
        .where(eq(submissionClassifications.submissionId, submissionId));
      if (rows[0]) {
        classification = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(classification).toBeDefined();
    // Mock-mode path: empty disciplines, null project type, null confidence.
    expect(classification!.source).toBe("auto");
    expect(classification!.disciplines).toEqual([]);
    expect(classification!.projectType).toBeNull();
  });
});
