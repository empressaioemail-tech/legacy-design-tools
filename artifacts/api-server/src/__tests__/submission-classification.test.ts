/**
 * Track 1 — submission auto-classification tests.
 *
 * Covers:
 *   - parseClassificationResponse: tolerates leading/trailing prose,
 *     drops unknown disciplines, clamps confidence.
 *   - upsertAutoClassification: idempotent — does not overwrite an
 *     existing row.
 *   - autoTriggerClassificationOnSubmissionCreated wires through the
 *     submission-create route in mock-mode (no client → empty
 *     classification persisted).
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
const { engagements, submissions, submissionClassifications } = await import(
  "@workspace/db"
);
const { eq } = await import("drizzle-orm");

const { parseClassificationResponse, upsertAutoClassification } = await import(
  "../lib/classifySubmission"
);
const { getHistoryService } = await import("../atoms/registry");

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

function fakeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
  } as unknown as Parameters<typeof upsertAutoClassification>[3];
}

async function seedEngagementAndSubmission(): Promise<{
  engagementId: string;
  submissionId: string;
}> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const db = ctx.schema.db;
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
      engagementId: eng.id,
      jurisdiction: "Bastrop, TX",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: "4806632",
      status: "pending",
    })
    .returning({ id: submissions.id });
  return { engagementId: eng.id, submissionId: sub.id };
}

describe("parseClassificationResponse", () => {
  const log = fakeLogger() as unknown as Parameters<
    typeof parseClassificationResponse
  >[1];

  it("parses a minimal valid response", () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        projectType: "residential-addition",
        disciplines: ["building", "residential"],
        applicableCodeBooks: ["IRC 2021"],
        confidence: 0.81,
      }),
      log,
      "sub-1",
    );
    expect(result).toEqual({
      projectType: "residential-addition",
      disciplines: ["building", "residential"],
      applicableCodeBooks: ["IRC 2021"],
      confidence: 0.81,
    });
  });

  it("tolerates leading/trailing prose around the JSON object", () => {
    const result = parseClassificationResponse(
      `Here is your classification:\n\n${JSON.stringify({
        projectType: "x",
        disciplines: ["building"],
        applicableCodeBooks: [],
        confidence: 0.5,
      })}\n\nThanks!`,
      log,
      "sub-1",
    );
    expect(result.projectType).toBe("x");
    expect(result.disciplines).toEqual(["building"]);
    expect(result.confidence).toBe(0.5);
  });

  it("drops unknown discipline values silently", () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        projectType: "x",
        disciplines: ["building", "not-a-discipline", "fire-life-safety"],
        applicableCodeBooks: [],
        confidence: 0.7,
      }),
      log,
      "sub-1",
    );
    expect(result.disciplines).toEqual(["building", "fire-life-safety"]);
  });

  it("nulls out-of-range confidence", () => {
    const result = parseClassificationResponse(
      JSON.stringify({
        projectType: "x",
        disciplines: [],
        applicableCodeBooks: [],
        confidence: 1.5,
      }),
      log,
      "sub-1",
    );
    expect(result.confidence).toBeNull();
  });

  it("returns the empty result on a non-JSON response", () => {
    const result = parseClassificationResponse(
      "I'm sorry, I can't classify this.",
      log,
      "sub-1",
    );
    expect(result).toEqual({
      projectType: null,
      disciplines: [],
      applicableCodeBooks: [],
      confidence: null,
    });
  });

  it("returns the empty result on malformed JSON inside braces", () => {
    const result = parseClassificationResponse(
      "{ definitely not json }",
      log,
      "sub-1",
    );
    expect(result).toEqual({
      projectType: null,
      disciplines: [],
      applicableCodeBooks: [],
      confidence: null,
    });
  });
});

describe("upsertAutoClassification (idempotent)", () => {
  it("inserts a row on first call, no-ops if a row already exists", async () => {
    const { submissionId } = await seedEngagementAndSubmission();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const log = fakeLogger();

    const first = await upsertAutoClassification(
      submissionId,
      {
        projectType: "first-attempt",
        disciplines: ["building"],
        applicableCodeBooks: ["IBC 2021"],
        confidence: 0.6,
      },
      getHistoryService(),
      log,
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
      getHistoryService(),
      log,
    );
    expect(second).toBeNull();

    const rows = await db
      .select()
      .from(submissionClassifications)
      .where(eq(submissionClassifications.submissionId, submissionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectType).toBe("first-attempt");
  });

  it("does not overwrite a 'reviewer' row when the auto path runs after reclassify", async () => {
    const { submissionId } = await seedEngagementAndSubmission();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const log = fakeLogger();

    // Reviewer landed first (e.g. dev-tools direct write).
    await db.insert(submissionClassifications).values({
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
      getHistoryService(),
      log,
    );
    expect(result).toBeNull();

    const rows = await db
      .select()
      .from(submissionClassifications)
      .where(eq(submissionClassifications.submissionId, submissionId));
    expect(rows[0]!.source).toBe("reviewer");
    expect(rows[0]!.projectType).toBe("reviewer-set");
  });
});

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
        .post(`/api/engagements/${eng.id}/submissions`)
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
