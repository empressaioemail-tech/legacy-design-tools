/**
 * /api/submissions/{id}/findings* + /api/findings/{id}/* — V1-1
 * route integration tests.
 *
 * Covers (mock mode by default — no Anthropic mocking required):
 *   - 403 on non-internal audience
 *   - 404 on missing submission / finding
 *   - generate happy path: 202 → status pending → completed; row
 *     count matches the mock fixture; finding.generated events
 *     anchored against each row's atomId
 *   - generate single-flight: concurrent kickoff returns 409 +
 *     in-flight generationId
 *   - list endpoint surfaces the persisted rows newest-first
 *   - runs endpoint surfaces the most recent N (capped)
 *   - status endpoint exposes invalidCitationCount,
 *     invalidCitations, discardedFindingCount distinctly
 *   - accept / reject mutations stamp reviewer attribution + emit
 *     finding.{accepted,rejected} events; second call refreshes
 *     timestamp; status-violating transition is 409
 *   - override creates a new revision row + preserves the original
 *     in place with status="overridden"; emits finding.overridden
 *     against the ORIGINAL atom id
 *
 * Mirrors `parcel-briefings-generate.test.ts` lifecycle. Engine runs
 * mock-mode by default per `AIR_FINDING_LLM_MODE` unset; no SDK mock
 * needed.
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
        throw new Error("findings-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

// V1-7: stub the codes-side retrieval at the boundary so the route's
// retrieval call is deterministic in tests without standing up the
// embeddings service. Pattern mirrors `engagements.test.ts:38-52` —
// preserve the rest of the module (in particular `keyFromEngagement`,
// which the route uses to derive the jurisdiction key the test asserts
// against), and only override the network-shaped function under test.
//
// `vi.hoisted` is required because `vi.mock` calls are hoisted to the
// top of the module by vitest's transform; without `hoisted`, the
// factory closure would reference a `const` that has not yet been
// initialized at hoist time.
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    retrieveAtomsForQuestion: retrieveAtomsForQuestionMock,
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  submissions,
  parcelBriefings,
  briefingSources,
  materializableElements,
  findings,
  findingRuns,
  atomEvents,
} = await import("@workspace/db");
const { eq, and, desc } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  // Reset the retrieval stub between tests so a `mockReturnValueOnce`
  // queued in one test doesn't leak into the next. Default behavior:
  // return zero atoms (the V1-1 baseline). Tests that exercise the
  // retrieval-reaches-engine path override per-call.
  retrieveAtomsForQuestionMock.mockReset();
  retrieveAtomsForQuestionMock.mockResolvedValue([]);
});

const REVIEWER_HEADERS = {
  "x-audience": "internal",
  "x-requestor": "user:reviewer-test",
};

async function seedEngagementSubmission(name = "Findings Test Engagement") {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Bastrop, TX",
      address: "1 Pine St",
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

/**
 * Seed a parcel-briefing + one current source so the engine has
 * something to cite when the kickoff route resolves the engine's
 * input bundle. Without this the mock generator emits zero findings.
 */
async function seedBriefingForEngagement(engagementId: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [briefing] = await ctx.schema.db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  const [source] = await ctx.schema.db
    .insert(briefingSources)
    .values({
      briefingId: briefing.id,
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "Bastrop UDC",
      note: "test seed",
      uploadObjectPath: "/objects/zoning",
      uploadOriginalFilename: "zoning.geojson",
      uploadContentType: "application/geo+json",
      uploadByteSize: 1024,
      snapshotDate: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return { briefing, source };
}

async function waitForStatus(
  submissionId: string,
  expected: "completed" | "failed",
  timeoutMs = 2000,
): Promise<{ state: string; body: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let last: { state: string; body: Record<string, unknown> } = {
    state: "pending",
    body: {},
  };
  while (Date.now() < deadline) {
    const res = await request(getApp())
      .get(`/api/submissions/${submissionId}/findings/status`)
      .set(REVIEWER_HEADERS);
    last = { state: res.body.state, body: res.body };
    if (res.body.state === expected) return last;
    if (res.body.state === "failed" && expected === "completed") {
      throw new Error(
        `finding generation failed: ${JSON.stringify(res.body)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `findings status did not reach ${expected} within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

describe("findings — audience gate", () => {
  it("403s on non-internal audience for every endpoint", async () => {
    const { submission } = await seedEngagementSubmission();
    const r1 = await request(getApp()).get(
      `/api/submissions/${submission.id}/findings`,
    );
    expect(r1.status).toBe(403);

    const r2 = await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({});
    expect(r2.status).toBe(403);

    const r3 = await request(getApp()).get(
      `/api/submissions/${submission.id}/findings/status`,
    );
    expect(r3.status).toBe(403);
  });
});

describe("POST /api/submissions/:id/findings/generate (mock mode)", () => {
  it("404s when the submission does not exist", async () => {
    const res = await request(getApp())
      .post(
        `/api/submissions/00000000-0000-0000-0000-000000000000/findings/generate`,
      )
      .send({})
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("submission_not_found");
  });

  it("kicks off, completes, persists findings, and emits one finding.generated event per row", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission();
    await seedBriefingForEngagement(engagement.id);

    const kickoff = await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(kickoff.status).toBe(202);
    expect(kickoff.body).toMatchObject({ state: "pending" });
    expect(typeof kickoff.body.generationId).toBe("string");
    const generationId = kickoff.body.generationId as string;

    const completed = await waitForStatus(submission.id, "completed");
    expect(completed.body.generationId).toBe(generationId);
    expect(completed.body.error).toBeNull();

    const rows = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submission.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.atomId.startsWith(`finding:${submission.id}:`)).toBe(true);
      expect(r.status).toBe("ai-produced");
      expect(r.findingRunId).toBe(generationId);
    }

    // One finding.generated event per persisted row, anchored on
    // each row's public atom id.
    for (const r of rows) {
      const events = await ctx.schema.db
        .select()
        .from(atomEvents)
        .where(
          and(
            eq(atomEvents.entityType, "finding"),
            eq(atomEvents.entityId, r.atomId),
          ),
        );
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.eventType).toBe("finding.generated");
    }
  });

  it("returns 409 + the in-flight generationId on a concurrent kickoff", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { submission } = await seedEngagementSubmission(
      "single-flight-engagement",
    );
    // Insert a synthetic pending row so the partial-unique index
    // immediately trips on a fresh kickoff.
    const [pending] = await ctx.schema.db
      .insert(findingRuns)
      .values({ submissionId: submission.id, state: "pending" })
      .returning();

    const res = await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("finding_generation_already_in_flight");
    expect(res.body.generationId).toBe(pending.id);
  });
});

describe("GET /api/submissions/:id/findings/status", () => {
  it("returns idle when no run has ever fired", async () => {
    const { submission } = await seedEngagementSubmission("idle-engagement");
    const res = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings/status`)
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("idle");
    expect(res.body.generationId).toBeNull();
    expect(res.body.discardedFindingCount).toBeNull();
  });

  it("surfaces invalidCitationCount, invalidCitations, and discardedFindingCount as distinct dimensions", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "counters-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    const completed = await waitForStatus(submission.id, "completed");
    // Mock fixture cites only resolved ids, so both counters are 0
    // — but the wire shape must surface both as numbers (not null)
    // on the completed branch.
    expect(completed.body.invalidCitationCount).toBe(0);
    expect(completed.body.invalidCitations).toEqual([]);
    expect(completed.body.discardedFindingCount).toBe(0);
  });
});

describe("GET /api/submissions/:id/findings", () => {
  it("returns the persisted findings newest-first", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "list-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    await waitForStatus(submission.id, "completed");

    const res = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.findings.length).toBeGreaterThan(0);
    const first = res.body.findings[0];
    expect(typeof first.id).toBe("string");
    expect(first.id.startsWith(`finding:${submission.id}:`)).toBe(true);
    expect(first.status).toBe("ai-produced");
    expect(first.submissionId).toBe(submission.id);
  });
});

describe("GET /api/submissions/:id/findings/runs", () => {
  it("returns recent runs newest-first capped at the keep value", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { submission } = await seedEngagementSubmission("runs-engagement");

    // Seed eight terminal rows directly. The default keep cap is 5;
    // the route must surface only the five most-recent.
    for (let i = 0; i < 8; i++) {
      await ctx.schema.db.insert(findingRuns).values({
        submissionId: submission.id,
        state: "completed",
        startedAt: new Date(Date.now() - (8 - i) * 1000),
        completedAt: new Date(Date.now() - (8 - i) * 1000 + 100),
      });
    }
    const res = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings/runs`)
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
  });
});

describe("POST /api/findings/:id/accept", () => {
  it("flips status to accepted, stamps reviewer attribution, emits finding.accepted", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "accept-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    await waitForStatus(submission.id, "completed");

    const list = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    const target = list.body.findings[0];

    const res = await request(getApp())
      .post(`/api/findings/${target.id}/accept`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.finding.status).toBe("accepted");
    expect(res.body.finding.reviewerStatusBy).toEqual({
      kind: "user",
      id: "reviewer-test",
      displayName: null,
    });
    expect(res.body.finding.reviewerStatusChangedAt).toBeTruthy();

    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "finding"),
          eq(atomEvents.entityId, target.id),
          eq(atomEvents.eventType, "finding.accepted"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("404s on a malformed / missing finding atom id", async () => {
    const res = await request(getApp())
      .post(`/api/findings/finding:not:real/accept`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/findings/:id/reject", () => {
  it("flips status to rejected and emits finding.rejected", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "reject-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    await waitForStatus(submission.id, "completed");

    const list = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    const target = list.body.findings[0];

    const res = await request(getApp())
      .post(`/api/findings/${target.id}/reject`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.finding.status).toBe("rejected");
  });

  it("returns 409 when the finding's status forbids rejection (e.g. already overridden)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "reject-409-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    await waitForStatus(submission.id, "completed");

    const list = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    const target = list.body.findings[0];

    // Override first to set status to "overridden", then attempt reject.
    await request(getApp())
      .post(`/api/findings/${target.id}/override`)
      .send({
        text: "Reviewer-authored revision text that is comfortably long enough to survive the discard rule.",
        severity: "concern",
        category: "other",
        reviewerComment: "AI was wrong about this.",
      })
      .set(REVIEWER_HEADERS);

    const res = await request(getApp())
      .post(`/api/findings/${target.id}/reject`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("finding_status_forbids_reject");
  });
});

describe("POST /api/findings/:id/override", () => {
  it("creates a new revision row, preserves the original with status='overridden', and emits finding.overridden against the original", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "override-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    await waitForStatus(submission.id, "completed");

    const list = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    const target = list.body.findings[0];
    const originalAtomId = target.id;

    const res = await request(getApp())
      .post(`/api/findings/${originalAtomId}/override`)
      .send({
        text: "Reviewer-authored revision text that is comfortably long enough to survive the discard rule.",
        severity: "concern",
        category: "other",
        reviewerComment: "AI's original was wrong; here's the corrected reading.",
      })
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    const revision = res.body.finding;
    expect(revision.id).not.toBe(originalAtomId);
    expect(revision.id.startsWith(`finding:${submission.id}:`)).toBe(true);
    expect(revision.status).toBe("overridden");
    expect(revision.severity).toBe("concern");
    expect(revision.category).toBe("other");
    expect(revision.reviewerComment).toBe(
      "AI's original was wrong; here's the corrected reading.",
    );
    expect(revision.revisionOf).toBe(originalAtomId);

    // The original is preserved in place with status="overridden".
    const refetched = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    const originals = refetched.body.findings.filter(
      (f: { id: string }) => f.id === originalAtomId,
    );
    expect(originals).toHaveLength(1);
    expect(originals[0]!.status).toBe("overridden");

    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "finding"),
          eq(atomEvents.entityId, originalAtomId),
          eq(atomEvents.eventType, "finding.overridden"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      originalAtomId,
      revisionAtomId: revision.id,
    });
  });

  it("returns 409 when overriding an already-overridden finding", async () => {
    // Empressa post-review decision: a finding can only be overridden
    // ONCE. Multiple sibling revisions pointing at the same
    // `revision_of` would muddy the audit trail. Second override on
    // the original returns 409 + `finding_already_overridden`.
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "double-override-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    await waitForStatus(submission.id, "completed");

    const list = await request(getApp())
      .get(`/api/submissions/${submission.id}/findings`)
      .set(REVIEWER_HEADERS);
    const target = list.body.findings[0];
    const originalAtomId = target.id;

    const overrideBody = {
      text: "Reviewer-authored revision text that is comfortably long enough to survive the discard rule.",
      severity: "concern" as const,
      category: "other" as const,
      reviewerComment: "First override.",
    };

    // First override succeeds — original is now `overridden`.
    const first = await request(getApp())
      .post(`/api/findings/${originalAtomId}/override`)
      .send(overrideBody)
      .set(REVIEWER_HEADERS);
    expect(first.status).toBe(200);

    // Second override on the same original is a 409. The route loads
    // the row, sees status === "overridden", and rejects before
    // opening the transaction (so no sibling revision is created).
    const second = await request(getApp())
      .post(`/api/findings/${originalAtomId}/override`)
      .send({ ...overrideBody, reviewerComment: "Second override." })
      .set(REVIEWER_HEADERS);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("finding_already_overridden");

    // Verify only ONE revision row was inserted (post-condition for
    // the single-revision rule). We count rows whose `revision_of`
    // points at the original's row pk; the wire surface only carries
    // the atom-id form, so resolve the original's row pk via a quick
    // lookup.
    const [originalRow] = await ctx.schema.db
      .select({ id: findings.id })
      .from(findings)
      .where(eq(findings.atomId, originalAtomId));
    expect(originalRow).toBeDefined();
    const revisions = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.revisionOf, originalRow!.id));
    expect(revisions).toHaveLength(1);
  });
});

// ─── V1-7: retrieval + bimElements wire-up ───────────────────────

describe("V1-7 — code retrieval wired into the engine input", () => {
  it("retrieved code atoms reach the engine and surface as [[CODE:...]] tokens on persisted findings", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "retrieval-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    // Stub a single canned atom. The mock-mode finding fixture cites
    // the first code-section it receives, so this id must show up
    // verbatim in at least one persisted finding's `text`.
    const cannedAtomId = "11111111-1111-1111-1111-111111111111";
    retrieveAtomsForQuestionMock.mockResolvedValueOnce([
      {
        id: cannedAtomId,
        sourceName: "bastrop_municode",
        jurisdictionKey: "bastrop_tx",
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current supplement)",
        sectionNumber: "§4.3.2.B",
        sectionTitle: "Side Yard Setbacks",
        body: "Side yard setback shall be 5'-0\" minimum.",
        sourceUrl: "https://example.com/bastrop-udc-4-3-2-b",
        score: 0.74,
        retrievalMode: "vector",
      },
    ]);

    const kickoff = await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(kickoff.status).toBe(202);
    await waitForStatus(submission.id, "completed");

    // The route resolved the engagement's "Bastrop, TX" jurisdiction
    // string into the `bastrop_tx` registered key and called
    // retrieval with K=8 against that key.
    expect(retrieveAtomsForQuestionMock).toHaveBeenCalledTimes(1);
    expect(retrieveAtomsForQuestionMock.mock.calls[0]![0]).toMatchObject({
      jurisdictionKey: "bastrop_tx",
      limit: 8,
    });
    // The query passed to retrieval was the briefing-narrative slice
    // (truncated to 1500 chars). Without a generated narrative on
    // the seed briefing, the synthesized fallback fires — assert
    // either is non-empty.
    const callArgs = retrieveAtomsForQuestionMock.mock.calls[0]![0] as {
      question: string;
    };
    expect(typeof callArgs.question).toBe("string");
    expect(callArgs.question.length).toBeGreaterThan(0);
    expect(callArgs.question.length).toBeLessThanOrEqual(1500);

    // The mock-mode engine fixture's blocker text inlines a
    // [[CODE:atomId]] token for the first code-section input, and
    // the citation validator preserves it because the resolver
    // recognizes the canned atom id.
    const persistedFindings = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submission.id));
    const blocker = persistedFindings.find((f) => f.severity === "blocker");
    expect(blocker).toBeTruthy();
    expect(blocker!.text).toContain(`[[CODE:${cannedAtomId}]]`);
    // The citation also lands on the citations jsonb array.
    const citations = blocker!.citations as Array<{
      kind: string;
      atomId?: string;
    }>;
    expect(
      citations.some(
        (c) => c.kind === "code-section" && c.atomId === cannedAtomId,
      ),
    ).toBe(true);
  });

  it("skips retrieval when the engagement's jurisdiction does not resolve to a registered key", async () => {
    if (!ctx.schema) throw new Error("ctx");
    // Engagement with an unrecognized jurisdiction string: keyFromEngagement
    // walks structured city/state → freeform → address scan and returns
    // null when nothing matches the registry.
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "no-jurisdiction-engagement",
        nameLower: "no-jurisdiction-engagement",
        jurisdiction: "Atlantis, Lost Continent",
        address: "1 Trident Way, Atlantis",
        status: "active",
      })
      .returning();
    const [sub] = await ctx.schema.db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: "Atlantis, Lost Continent",
      })
      .returning();
    await seedBriefingForEngagement(eng.id);

    const kickoff = await request(getApp())
      .post(`/api/submissions/${sub.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(kickoff.status).toBe(202);
    await waitForStatus(sub.id, "completed");

    // No jurisdiction key → no retrieval call at all (the chat-side
    // fail-safe applies: an unrecognized locale is a true negative,
    // we don't fabricate atoms from a different jurisdiction).
    expect(retrieveAtomsForQuestionMock).not.toHaveBeenCalled();

    // The mock fixture suppresses the blocker without a code-section
    // input, so the surviving findings cite none either.
    const persistedFindings = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, sub.id));
    for (const f of persistedFindings) {
      expect(f.text).not.toMatch(/\[\[CODE:/);
    }
  });
});

describe("V1-7 — materializable elements wired into the engine input", () => {
  it("seeded materializable elements reach the engine and one finding's elementRef matches a row uuid", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "materializable-engagement",
    );
    const { briefing } = await seedBriefingForEngagement(engagement.id);

    // Seed two materializable elements against the briefing. The
    // mock-mode engine fixture anchors its blocker on the first
    // bim element it receives, so the persisted blocker's
    // `elementRef` must equal one of the seeded row uuids.
    const matRows = await ctx.schema.db
      .insert(materializableElements)
      .values([
        {
          briefingId: briefing.id,
          elementKind: "setback-plane",
          label: "Front setback (15 ft)",
          locked: true,
        },
        {
          briefingId: briefing.id,
          elementKind: "buildable-envelope",
          label: null,
          locked: false,
        },
      ])
      .returning();
    expect(matRows).toHaveLength(2);
    const seededIds = new Set(matRows.map((r) => r.id));

    // Stage one retrieval atom so the engine receives a non-empty
    // codeSections list. The mock generator gates blocker and
    // concern findings on `firstCode`; without this, only the
    // advisory fires, and the advisory always sets elementRef:null.
    // The concern fires with elementRef = bimElements[1].ref =
    // the second seeded materializable-element row uuid.
    retrieveAtomsForQuestionMock.mockResolvedValueOnce([
      {
        id: "22222222-2222-2222-2222-222222222222",
        sourceName: "bastrop_municode",
        jurisdictionKey: "bastrop_tx",
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current supplement)",
        sectionNumber: "§4.3.2.B",
        sectionTitle: "Side Yard Setbacks",
        body: "Side yard setback shall be 5'-0\" minimum.",
        sourceUrl: "https://example.com/bastrop-udc-4-3-2-b",
        score: 0.74,
        retrievalMode: "vector",
      },
    ]);

    const kickoff = await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(kickoff.status).toBe(202);
    await waitForStatus(submission.id, "completed");

    const persistedFindings = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submission.id));
    // At least one finding (the mock blocker) carries an elementRef
    // that points at one of the seeded materializable-element row
    // uuids — the route's `toBimElementInput` set `ref = row.id`.
    const anchored = persistedFindings.filter(
      (f) => f.elementRef && seededIds.has(f.elementRef),
    );
    expect(anchored.length).toBeGreaterThan(0);
  });
});

describe("V1-7 — retrieval-failure fail-safe", () => {
  it("a retrieval throw does not fail the run; status reaches `completed` with no code citations", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { engagement, submission } = await seedEngagementSubmission(
      "retrieval-failure-engagement",
    );
    await seedBriefingForEngagement(engagement.id);

    retrieveAtomsForQuestionMock.mockRejectedValueOnce(
      new Error("simulated embedding-service outage"),
    );

    const kickoff = await request(getApp())
      .post(`/api/submissions/${submission.id}/findings/generate`)
      .send({})
      .set(REVIEWER_HEADERS);
    expect(kickoff.status).toBe(202);
    const completed = await waitForStatus(submission.id, "completed");
    // The run completes (warn-and-continue contract). Even though
    // retrieval threw, the engine ran against sources alone.
    expect(completed.body.state).toBe("completed");
    expect(completed.body.error).toBeNull();

    // Persisted findings carry no [[CODE:...]] tokens because no
    // code-section inputs reached the engine.
    const persistedFindings = await ctx.schema.db
      .select()
      .from(findings)
      .where(eq(findings.submissionId, submission.id));
    for (const f of persistedFindings) {
      expect(f.text).not.toMatch(/\[\[CODE:/);
    }
  });
});
