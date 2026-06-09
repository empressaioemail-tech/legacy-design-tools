/**
 * Unit tests for {@link rescueStalePendingFindingRuns} — marks
 * orphaned `finding_runs` rows stuck in `pending` as failed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestSchema,
  dropTestSchema,
  truncateAll,
  type TestSchemaContext,
} from "@workspace/db/testing";

const { engagements, findingRuns, submissions } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const {
  FINDING_RUN_ORPHANED_TIMEOUT_ERROR,
  MIAMI_KEYSTONE_ENGAGEMENT_ID,
  rescueStalePendingFindingRuns,
} = await import("../lib/findingRunsSweep");

let schema: TestSchemaContext;

beforeAll(async () => {
  schema = await createTestSchema();
});

afterEach(async () => {
  await truncateAll(schema.pool, [
    "findings",
    "finding_runs",
    "submissions",
    "engagements",
  ]);
});

afterAll(async () => {
  await dropTestSchema(schema);
});

async function seedEngagement(id?: string) {
  const [eng] = await schema.db
    .insert(engagements)
    .values({
      ...(id ? { id } : {}),
      name: "sweep-test",
      nameLower: "sweep-test",
      jurisdiction: "Miami, FL",
      address: "1 Test St",
      status: "active",
    })
    .returning();
  return eng!;
}

async function seedSubmission(engagementId: string) {
  const [sub] = await schema.db
    .insert(submissions)
    .values({
      engagementId,
      jurisdiction: "Miami, FL",
      note: null,
    })
    .returning();
  return sub!;
}

async function seedPendingRun(
  submissionId: string,
  startedAt: Date,
) {
  const [run] = await schema.db
    .insert(findingRuns)
    .values({
      submissionId,
      state: "pending",
      startedAt,
    })
    .returning();
  return run!;
}

describe("rescueStalePendingFindingRuns", () => {
  it("marks pending runs older than the threshold as failed with orphaned-timeout", async () => {
    const eng = await seedEngagement();
    const staleSub = await seedSubmission(eng.id);
    const freshSub = await seedSubmission(eng.id);
    const now = new Date("2026-06-09T12:00:00Z");
    const stale = await seedPendingRun(
      staleSub.id,
      new Date("2026-06-09T11:00:00Z"),
    );
    const fresh = await seedPendingRun(
      freshSub.id,
      new Date("2026-06-09T11:45:00Z"),
    );

    const result = await rescueStalePendingFindingRuns({
      db: schema.db,
      now,
      rescueThresholdMs: 30 * 60 * 1000,
    });

    expect(result.rescuedByTimeout).toBe(1);
    expect(result.rescuedImmediate).toBe(0);

    const [staleRow] = await schema.db
      .select()
      .from(findingRuns)
      .where(eq(findingRuns.id, stale.id));
    expect(staleRow!.state).toBe("failed");
    expect(staleRow!.error).toBe(FINDING_RUN_ORPHANED_TIMEOUT_ERROR);
    expect(staleRow!.completedAt).toEqual(now);

    const [freshRow] = await schema.db
      .select()
      .from(findingRuns)
      .where(eq(findingRuns.id, fresh.id));
    expect(freshRow!.state).toBe("pending");
  });

  it("immediately expires all pending runs on configured engagement ids", async () => {
    const eng = await seedEngagement(MIAMI_KEYSTONE_ENGAGEMENT_ID);
    const sub = await seedSubmission(eng.id);
    const now = new Date("2026-06-09T12:00:00Z");
    await seedPendingRun(sub.id, new Date("2026-06-09T11:59:00Z"));

    const result = await rescueStalePendingFindingRuns({
      db: schema.db,
      now,
      immediateEngagementIds: [MIAMI_KEYSTONE_ENGAGEMENT_ID],
    });

    expect(result.rescuedImmediate).toBe(1);
    const rows = await schema.db.select().from(findingRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("failed");
    expect(rows[0]!.error).toBe(FINDING_RUN_ORPHANED_TIMEOUT_ERROR);
  });
});
