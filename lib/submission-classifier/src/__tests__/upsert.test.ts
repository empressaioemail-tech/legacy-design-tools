/**
 * `upsertAutoClassification` — idempotency tests. Moved from
 * api-server's `submission-classification.test.ts` as part of the
 * `@workspace/submission-classifier` extraction.
 *
 * Both cases pin the "auto path never overwrites an existing row"
 * contract that protects reviewer reclassifications from being
 * silently clobbered by a fire-and-forget retry of the auto-trigger
 * hook.
 *
 * Uses `withTestSchema` from `@workspace/db/testing` — same posture
 * other lib packages (e.g. finding-engine integration tests) use
 * when they need a real Postgres schema rather than a mock.
 */

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  engagements,
  submissions,
  submissionClassifications,
} from "@workspace/db";
import {
  PostgresEventAnchoringService,
  type EventAnchoringService,
} from "@workspace/empressa-atom";
import {
  withTestSchema,
  type TestDb,
  type TestSchemaContext,
} from "@workspace/db/testing";
import { upsertAutoClassification } from "../upsert";
import type { ClassifierLogger } from "../types";

function fakeLogger(): ClassifierLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function historyFor(ctx: TestSchemaContext): EventAnchoringService {
  return new PostgresEventAnchoringService(
    ctx.db as unknown as ConstructorParameters<
      typeof PostgresEventAnchoringService
    >[0],
  );
}

async function seedEngagementAndSubmission(
  db: TestDb,
): Promise<{ submissionId: string }> {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: "Classifier Engagement",
      nameLower: "classifier engagement",
      jurisdiction: "Bastrop, TX",
      status: "active",
    })
    .returning({ id: engagements.id });
  const [sub] = await db
    .insert(submissions)
    .values({
      engagementId: eng!.id,
      jurisdiction: "Bastrop, TX",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: "4806632",
      status: "pending",
    })
    .returning({ id: submissions.id });
  return { submissionId: sub!.id };
}

describe("upsertAutoClassification (idempotent)", () => {
  it("inserts a row on first call, no-ops if a row already exists", async () => {
    await withTestSchema(async (ctx) => {
      const log = fakeLogger();
      const history = historyFor(ctx);
      const { submissionId } = await seedEngagementAndSubmission(ctx.db);

      const first = await upsertAutoClassification(
        submissionId,
        {
          projectType: "first-attempt",
          disciplines: ["building"],
          applicableCodeBooks: ["IBC 2021"],
          confidence: 0.6,
        },
        history,
        log,
        ctx.db,
      );
      expect(first).not.toBeNull();
      expect(first?.source).toBe("auto");

      // Second call must be a no-op.
      const second = await upsertAutoClassification(
        submissionId,
        {
          projectType: "second-attempt",
          disciplines: ["fire-life-safety"],
          applicableCodeBooks: ["IFC 2021"],
          confidence: 0.99,
        },
        history,
        log,
        ctx.db,
      );
      expect(second).toBeNull();

      const rows = await ctx.db
        .select()
        .from(submissionClassifications)
        .where(eq(submissionClassifications.submissionId, submissionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.projectType).toBe("first-attempt");
    });
  });

  it("does not overwrite a 'reviewer' row when the auto path runs after reclassify", async () => {
    await withTestSchema(async (ctx) => {
      const log = fakeLogger();
      const history = historyFor(ctx);
      const { submissionId } = await seedEngagementAndSubmission(ctx.db);

      // Reviewer landed first (e.g. dev-tools direct write).
      await ctx.db.insert(submissionClassifications).values({
        submissionId,
        projectType: "reviewer-set",
        disciplines: ["accessibility"],
        applicableCodeBooks: [],
        source: "reviewer",
      });

      const result = await upsertAutoClassification(
        submissionId,
        {
          projectType: "auto-set",
          disciplines: ["building"],
          applicableCodeBooks: ["IBC 2021"],
          confidence: 0.5,
        },
        history,
        log,
        ctx.db,
      );
      expect(result).toBeNull();

      const rows = await ctx.db
        .select()
        .from(submissionClassifications)
        .where(eq(submissionClassifications.submissionId, submissionId));
      expect(rows[0]!.source).toBe("reviewer");
      expect(rows[0]!.projectType).toBe("reviewer-set");
    });
  });
});
