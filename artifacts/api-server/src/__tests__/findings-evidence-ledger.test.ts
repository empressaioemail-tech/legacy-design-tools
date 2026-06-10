/**
 * Arrow two Phase 1 — tier 1a adjudication-to-atom evidence ledger.
 *
 * Covers:
 *   - 403 on non-internal audience
 *   - projection fans adjudication events to cited code-section atoms
 *   - tenant partition via engagement cortexJurisdictionKey
 *   - statedConfidences collected per cited atom (backend only)
 *   - invalidCitationCount health endpoint
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
        throw new Error("findings-evidence-ledger.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  submissions,
  findings,
  findingRuns,
  atomEvents,
} = await import("@workspace/db");
const { getHistoryService } = await import("../atoms/registry");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const REVIEWER_HEADERS = {
  "x-audience": "internal",
  "x-requestor": "user:reviewer-test",
};

const ARCHITECT_HEADERS = {
  "x-audience": "applicant",
  "x-requestor": "user:architect-test",
};

async function seedTenantEngagement(tenantKey: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: `Ledger ${tenantKey}`,
      nameLower: `ledger ${tenantKey}`,
      jurisdiction: "Bastrop, TX",
      cortexJurisdictionKey: tenantKey,
      status: "active",
    })
    .returning();
  const [sub] = await ctx.schema.db
    .insert(submissions)
    .values({
      engagementId: eng.id,
      jurisdiction: "Bastrop, TX",
    })
    .returning();
  return { engagement: eng, submission: sub };
}

async function seedFindingWithCitations(args: {
  submissionId: string;
  atomId: string;
  citations: Array<{ kind: "code-section"; atomId: string }>;
  confidence: string;
}) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [row] = await ctx.schema.db
    .insert(findings)
    .values({
      atomId: args.atomId,
      submissionId: args.submissionId,
      severity: "concern",
      category: "setback",
      status: "accepted",
      text: "Test finding body",
      citations: args.citations as unknown as Record<string, unknown>[],
      confidence: args.confidence,
      aiGeneratedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return row!;
}

async function appendFindingMutationEvent(args: {
  findingAtomId: string;
  eventType: "finding.accepted" | "finding.rejected" | "finding.overridden";
}) {
  const history = getHistoryService();
  await history.appendEvent({
    entityType: "finding",
    entityId: args.findingAtomId,
    eventType: args.eventType,
    actor: { kind: "user", id: "reviewer-test" },
    payload: { test: true },
  });
}

describe("GET /api/findings/adjudication-evidence", () => {
  it("403s without internal audience", async () => {
    const res = await request(getApp())
      .get("/api/findings/adjudication-evidence")
      .set(ARCHITECT_HEADERS);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("findings_require_internal_audience");
  });

  it("fans accept/reject/override events to cited atoms per jurisdictionTenant", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { submission: subA } = await seedTenantEngagement("bastrop_tx");
    const { submission: subB } = await seedTenantEngagement("elgin_tx");

    const findingA = await seedFindingWithCitations({
      submissionId: subA.id,
      atomId: "finding:sub-a:001",
      citations: [
        { kind: "code-section", atomId: "code:zoning-19.3.2" },
        { kind: "code-section", atomId: "code:setback-4.1" },
      ],
      confidence: "0.82",
    });
    const findingB = await seedFindingWithCitations({
      submissionId: subB.id,
      atomId: "finding:sub-b:001",
      citations: [{ kind: "code-section", atomId: "code:zoning-19.3.2" }],
      confidence: "0.55",
    });
    const findingNoCites = await seedFindingWithCitations({
      submissionId: subA.id,
      atomId: "finding:sub-a:002",
      citations: [],
      confidence: "0.90",
    });

    await appendFindingMutationEvent({
      findingAtomId: findingA.atomId,
      eventType: "finding.accepted",
    });
    await appendFindingMutationEvent({
      findingAtomId: findingB.atomId,
      eventType: "finding.rejected",
    });
    await appendFindingMutationEvent({
      findingAtomId: findingNoCites.atomId,
      eventType: "finding.accepted",
    });
    await appendFindingMutationEvent({
      findingAtomId: findingA.atomId,
      eventType: "finding.overridden",
    });

    const res = await request(getApp())
      .get("/api/findings/adjudication-evidence")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual(
      expect.arrayContaining([
        {
          jurisdictionTenant: "bastrop_tx",
          citedAtomId: "code:setback-4.1",
          acceptCount: 1,
          rejectCount: 0,
          overrideCount: 1,
          statedConfidences: [0.82, 0.82],
        },
        {
          jurisdictionTenant: "bastrop_tx",
          citedAtomId: "code:zoning-19.3.2",
          acceptCount: 1,
          rejectCount: 0,
          overrideCount: 1,
          statedConfidences: [0.82, 0.82],
        },
        {
          jurisdictionTenant: "elgin_tx",
          citedAtomId: "code:zoning-19.3.2",
          acceptCount: 0,
          rejectCount: 1,
          overrideCount: 0,
          statedConfidences: [0.55],
        },
      ]),
    );
    expect(res.body.rows).toHaveLength(3);
  });

  it("normalizes did:hauska:code-section and bare UUID to the same citedAtomId", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { submission } = await seedTenantEngagement("bastrop_tx");
    const corpusUuid = "550e8400-e29b-41d4-a716-446655440000";
    const corpusDid = `did:hauska:code-section:${corpusUuid}`;

    const findingUuid = await seedFindingWithCitations({
      submissionId: submission.id,
      atomId: "finding:uuid-cite:001",
      citations: [{ kind: "code-section", atomId: corpusUuid }],
      confidence: "0.80",
    });
    const findingDid = await seedFindingWithCitations({
      submissionId: submission.id,
      atomId: "finding:did-cite:001",
      citations: [{ kind: "code-section", atomId: corpusDid }],
      confidence: "0.75",
    });

    await appendFindingMutationEvent({
      findingAtomId: findingUuid.atomId,
      eventType: "finding.accepted",
    });
    await appendFindingMutationEvent({
      findingAtomId: findingDid.atomId,
      eventType: "finding.accepted",
    });

    const res = await request(getApp())
      .get("/api/findings/adjudication-evidence?jurisdictionTenant=bastrop_tx")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);

    const row = res.body.rows.find(
      (r: { citedAtomId: string }) => r.citedAtomId === corpusUuid,
    );
    expect(row).toBeDefined();
    expect(row.acceptCount).toBe(2);
    expect(row.statedConfidences).toEqual(expect.arrayContaining([0.8, 0.75]));
    expect(
      res.body.rows.filter(
        (r: { citedAtomId: string }) =>
          r.citedAtomId === corpusUuid || r.citedAtomId === corpusDid,
      ),
    ).toHaveLength(1);
  });

  it("filters by jurisdictionTenant query param", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { submission } = await seedTenantEngagement("bastrop_tx");
    const finding = await seedFindingWithCitations({
      submissionId: submission.id,
      atomId: "finding:filter:001",
      citations: [{ kind: "code-section", atomId: "code:filter-1" }],
      confidence: "0.70",
    });
    await appendFindingMutationEvent({
      findingAtomId: finding.atomId,
      eventType: "finding.accepted",
    });

    const res = await request(getApp())
      .get("/api/findings/adjudication-evidence?jurisdictionTenant=elgin_tx")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });
});

describe("GET /api/findings/adjudication-evidence/health", () => {
  it("403s without internal audience", async () => {
    const res = await request(getApp())
      .get("/api/findings/adjudication-evidence/health")
      .set(ARCHITECT_HEADERS);
    expect(res.status).toBe(403);
  });

  it("reports invalidCitationCount rate across recent completed runs", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { submission } = await seedTenantEngagement("bastrop_tx");
    const now = new Date();

    await ctx.schema.db.insert(findingRuns).values([
      {
        submissionId: submission.id,
        state: "completed",
        startedAt: now,
        completedAt: now,
        invalidCitationCount: 0,
        discardedFindingCount: 0,
      },
      {
        submissionId: submission.id,
        state: "completed",
        startedAt: now,
        completedAt: now,
        invalidCitationCount: 2,
        discardedFindingCount: 0,
      },
      {
        submissionId: submission.id,
        state: "failed",
        startedAt: now,
        completedAt: now,
        invalidCitationCount: 99,
        discardedFindingCount: 0,
      },
    ]);

    const res = await request(getApp())
      .get("/api/findings/adjudication-evidence/health")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.completedRuns).toBe(2);
    expect(res.body.runsWithInvalidCitations).toBe(1);
    expect(res.body.totalInvalidCitations).toBe(2);
    expect(res.body.runInvalidRate).toBeCloseTo(0.5);
    expect(res.body.windowDays).toBe(60);
  });
});

describe("buildAtomAdjudicationEvidenceLedger (lib)", () => {
  it("does not aggregate across tenants for the same cited atom id", async () => {
    const { buildAtomAdjudicationEvidenceLedger } = await import(
      "../lib/atomAdjudicationEvidenceLedger"
    );
    if (!ctx.schema) throw new Error("ctx");
    const { submission: subA } = await seedTenantEngagement("bastrop_tx");
    const { submission: subB } = await seedTenantEngagement("elgin_tx");
    const sharedAtom = "code:shared-section";

    for (const [subId, atomSuffix] of [
      [subA.id, "a"],
      [subB.id, "b"],
    ] as const) {
      const row = await seedFindingWithCitations({
        submissionId: subId,
        atomId: `finding:shared:${atomSuffix}`,
        citations: [{ kind: "code-section", atomId: sharedAtom }],
        confidence: "0.60",
      });
      await appendFindingMutationEvent({
        findingAtomId: row.atomId,
        eventType: "finding.accepted",
      });
    }

    const ledger = await buildAtomAdjudicationEvidenceLedger();
    const sharedRows = ledger.rows.filter((r) => r.citedAtomId === sharedAtom);
    expect(sharedRows).toHaveLength(2);
    expect(sharedRows.map((r) => r.jurisdictionTenant).sort()).toEqual([
      "bastrop_tx",
      "elgin_tx",
    ]);
  });
});

describe("computeInvalidCitationHealth (lib)", () => {
  it("returns null runInvalidRate when no completed runs in window", async () => {
    const { computeInvalidCitationHealth } = await import(
      "../lib/atomAdjudicationEvidenceLedger"
    );
    const health = await computeInvalidCitationHealth(60);
    expect(health.completedRuns).toBe(0);
    expect(health.runInvalidRate).toBeNull();
  });
});
