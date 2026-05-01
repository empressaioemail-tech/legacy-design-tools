/**
 * Submission atom contract test (sprint A4 / Task #63).
 *
 * Two suites in this file:
 *   1. The framework's `runAtomContractTests` against
 *      `makeSubmissionAtom`, which asserts the four-layer
 *      ContextSummary shape, default-mode/supported-modes invariant,
 *      and inline-reference round-trip.
 *   2. Behavior cases the contract suite doesn't cover: a real seeded
 *      submission row surfaces the engagement parent reference and the
 *      `submittedAt` keyMetric; a not-found id returns the structural
 *      shape with `typed.found: false`.
 *
 * Lifecycle mirrors `engagement-atom.test.ts`: one per-file Postgres
 * schema, `vi.mock("@workspace/db")` proxies `db` to the test schema's
 * drizzle instance, and the registration is built lazily so contextSummary
 * calls read from the live test schema.
 */

import {
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  it,
  expect,
  vi,
} from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("submission-atom.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema, truncateAll } = await import(
  "@workspace/db/testing"
);
const dbModule = await import("@workspace/db");
const { engagements, submissions } = dbModule;
const { runAtomContractTests, createInMemoryEventService } = await import(
  "@workspace/empressa-atom/testing"
);
const { defaultScope } = await import("@workspace/empressa-atom");
const { makeSubmissionAtom } = await import("../atoms/submission.atom");

const lazyDb = new Proxy({} as typeof dbModule.db, {
  get: (_t, prop) => Reflect.get(dbModule.db as object, prop, dbModule.db),
});

const ENGAGEMENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUBMISSION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function seedSubmission(): Promise<void> {
  if (!ctx.schema)
    throw new Error("submission-atom.test: ctx.schema not set");
  const db = ctx.schema.db;
  await db.insert(engagements).values({
    id: ENGAGEMENT_ID,
    name: "Submission Atom Contract",
    nameLower: "submission-atom-contract",
    jurisdiction: "Moab, UT",
    jurisdictionCity: "Moab",
    jurisdictionState: "UT",
    address: "1 Submission Way",
  });
  await db.insert(submissions).values({
    id: SUBMISSION_ID,
    engagementId: ENGAGEMENT_ID,
    jurisdiction: "Moab, UT",
    jurisdictionCity: "Moab",
    jurisdictionState: "UT",
    jurisdictionFips: "4950150",
    note: "Permit set v1.",
  });
}

describe("submission atom (contract)", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    await seedSubmission();
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  const submissionAtom = makeSubmissionAtom({ db: lazyDb });

  // The submission atom has no `composition` edges, so the contract
  // suite's composition-resolution step has nothing to register.
  runAtomContractTests(submissionAtom, {
    withFixture: { entityId: SUBMISSION_ID },
  });
});

describe("submission atom (behavior)", () => {
  beforeAll(async () => {
    if (!ctx.schema) ctx.schema = await createTestSchema();
  });

  beforeEach(async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    await truncateAll(ctx.schema.pool, ["engagements", "submissions"]);
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  it("surfaces the engagement parent reference and submittedAt keyMetric", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Behavior Test",
        nameLower: "behavior-test",
        jurisdiction: "Moab, UT",
        address: "1 Test Way",
      })
      .returning({ id: engagements.id });
    const [sub] = await db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Moab, UT",
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        jurisdictionFips: "4950150",
        note: "Behavior note.",
      })
      .returning();

    const atom = makeSubmissionAtom({ db: lazyDb });
    const summary = await atom.contextSummary(sub!.id, defaultScope());

    expect(summary.typed.found).toBe(true);
    expect(summary.typed.engagementId).toBe(eng.id);
    expect(summary.typed.note).toBe("Behavior note.");
    expect(summary.relatedAtoms).toEqual([
      {
        kind: "atom",
        entityType: "engagement",
        entityId: eng.id,
      },
    ]);
    const submittedAtMetric = summary.keyMetrics.find(
      (m) => m.label === "Submitted at",
    );
    expect(submittedAtMetric).toBeDefined();
    expect(typeof submittedAtMetric?.value).toBe("string");
    const jurisdictionMetric = summary.keyMetrics.find(
      (m) => m.label === "Jurisdiction",
    );
    expect(jurisdictionMetric?.value).toBe("Moab, UT");
    // Prose includes the jurisdiction label and the note.
    expect(summary.prose).toContain("Moab");
    expect(summary.prose).toContain("Behavior note.");
  });

  it("surfaces a recorded jurisdiction response in keyMetrics, prose, and typed", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Response Behavior",
        nameLower: "response-behavior",
        jurisdiction: "Moab, UT",
        address: "1 Response Way",
      })
      .returning({ id: engagements.id });
    const respondedAt = new Date("2026-04-15T10:00:00.000Z");
    const [sub] = await db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Moab, UT",
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
        note: "Permit set v1.",
        status: "corrections_requested",
        reviewerComment: "Need updated egress diagrams.",
        respondedAt,
      })
      .returning();

    const atom = makeSubmissionAtom({ db: lazyDb });
    const summary = await atom.contextSummary(sub!.id, defaultScope());

    // Typed payload carries the response fields.
    expect(summary.typed.status).toBe("corrections_requested");
    expect(summary.typed.reviewerComment).toBe(
      "Need updated egress diagrams.",
    );
    expect(summary.typed.respondedAt).toBe(respondedAt.toISOString());

    // keyMetrics surfaces a labeled status (not the raw enum value)
    // and a "Responded at" timestamp now that a reply exists.
    const statusMetric = summary.keyMetrics.find(
      (m) => m.label === "Status",
    );
    expect(statusMetric?.value).toBe("Corrections requested");
    const respondedAtMetric = summary.keyMetrics.find(
      (m) => m.label === "Responded at",
    );
    expect(respondedAtMetric?.value).toBe(respondedAt.toISOString());

    // Prose includes the response sentence so a single read gives the
    // full back-and-forth.
    expect(summary.prose).toContain("Jurisdiction response: Corrections requested");
    expect(summary.prose).toContain("Need updated egress diagrams.");
  });

  it("defaults to a Pending status keyMetric and omits 'Responded at' on a fresh submission", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const [eng] = await db
      .insert(engagements)
      .values({
        name: "Pending Default",
        nameLower: "pending-default",
        jurisdiction: "Moab, UT",
        address: "1 Pending Way",
      })
      .returning({ id: engagements.id });
    const [sub] = await db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Moab, UT",
      })
      .returning();

    const atom = makeSubmissionAtom({ db: lazyDb });
    const summary = await atom.contextSummary(sub!.id, defaultScope());

    expect(summary.typed.status).toBe("pending");
    expect(summary.typed.respondedAt).toBeNull();
    const statusMetric = summary.keyMetrics.find(
      (m) => m.label === "Status",
    );
    expect(statusMetric?.value).toBe("Pending");
    const respondedAtMetric = summary.keyMetrics.find(
      (m) => m.label === "Responded at",
    );
    expect(respondedAtMetric).toBeUndefined();
    // Prose does NOT include a "Jurisdiction response" sentence yet.
    expect(summary.prose).not.toContain("Jurisdiction response");
  });

  it(
    "historyProvenance points at the matching `engagement.submitted` event " +
      "anchored against the parent engagement",
    async () => {
      if (!ctx.schema) throw new Error("ctx.schema not set");
      const db = ctx.schema.db;
      const [eng] = await db
        .insert(engagements)
        .values({
          name: "Provenance Test",
          nameLower: "provenance-test",
          jurisdiction: "Moab, UT",
          address: "1 Provenance Way",
        })
        .returning({ id: engagements.id });
      const [sub] = await db
        .insert(submissions)
        .values({
          engagementId: eng.id,
          jurisdiction: "Moab, UT",
          jurisdictionCity: "Moab",
          jurisdictionState: "UT",
          note: "Targeted submission.",
        })
        .returning();

      const history = createInMemoryEventService();
      // An unrelated event the lookup should skip over.
      await history.appendEvent({
        entityType: "engagement",
        entityId: eng.id,
        eventType: "engagement.geocoded",
        actor: { kind: "system", id: "test" },
        payload: { foo: "bar" },
      });
      const submittedEvent = await history.appendEvent({
        entityType: "engagement",
        entityId: eng.id,
        eventType: "engagement.submitted",
        actor: { kind: "system", id: "test" },
        payload: { submissionId: sub!.id, jurisdiction: "Moab, UT" },
      });
      // A second `engagement.submitted` for a *different* submission —
      // the matcher must filter on `submissionId` payload, not just event
      // type, otherwise it would latch on to the most recent one.
      await history.appendEvent({
        entityType: "engagement",
        entityId: eng.id,
        eventType: "engagement.submitted",
        actor: { kind: "system", id: "test" },
        payload: {
          submissionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          jurisdiction: "Moab, UT",
        },
      });

      const atom = makeSubmissionAtom({ db: lazyDb, history });
      const summary = await atom.contextSummary(sub!.id, defaultScope());

      expect(summary.historyProvenance.latestEventId).toBe(submittedEvent.id);
      expect(summary.historyProvenance.latestEventAt).toBe(
        submittedEvent.occurredAt.toISOString(),
      );
    },
  );

  it(
    "historyProvenance falls back to submittedAt when no matching " +
      "`engagement.submitted` event exists",
    async () => {
      if (!ctx.schema) throw new Error("ctx.schema not set");
      const db = ctx.schema.db;
      const [eng] = await db
        .insert(engagements)
        .values({
          name: "Fallback Test",
          nameLower: "fallback-test",
          jurisdiction: "Moab, UT",
          address: "1 Fallback Way",
        })
        .returning({ id: engagements.id });
      const [sub] = await db
        .insert(submissions)
        .values({
          engagementId: eng.id,
          jurisdiction: "Moab, UT",
          note: "No event recorded.",
        })
        .returning();

      const history = createInMemoryEventService();
      const atom = makeSubmissionAtom({ db: lazyDb, history });
      const summary = await atom.contextSummary(sub!.id, defaultScope());

      expect(summary.historyProvenance.latestEventId).toBe("");
      expect(summary.historyProvenance.latestEventAt).toBe(
        sub!.submittedAt.toISOString(),
      );
    },
  );

  it("not-found returns the structural shape with typed.found=false", async () => {
    const atom = makeSubmissionAtom({ db: lazyDb });
    const summary = await atom.contextSummary(
      "00000000-0000-0000-0000-000000000000",
      defaultScope(),
    );
    expect(summary.typed).toEqual({
      id: "00000000-0000-0000-0000-000000000000",
      found: false,
    });
    expect(summary.relatedAtoms).toEqual([]);
    expect(summary.keyMetrics).toEqual([]);
    expect(summary.prose).toContain("could not be found");
    expect(summary.scopeFiltered).toBe(false);
  });
});
