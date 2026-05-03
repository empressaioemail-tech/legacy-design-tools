/**
 * Track 1 Pass B — shared e2e seeder + cookie helper.
 *
 * One canonical entry point that seeds every fixture surface the three
 * Track 1 Pass B specs (`discipline-filter`, `ai-badge-persistence`,
 * `triage-strip`) consume:
 *
 *   - A reviewer `users` row carrying the scenario's
 *     `disciplines: PlanReviewDiscipline[]`. The dev-only `pr_session`
 *     cookie that `promoteToInternalAudience` plants references this
 *     row's id, so `GET /api/session` hydrates `requestor.disciplines`
 *     from `users.disciplines` (see `routes/session.ts`).
 *
 *   - A primary `engagements` + `submissions` pair plus a deterministic
 *     `submission_classifications` upsert. Submissions are created via
 *     the public POST so any post-create hooks (atom events, fire-and-
 *     forget auto-classifier) run; the classification row is then
 *     overwritten with `source: 'reviewer'` so the spec doesn't depend
 *     on the LLM. The auto-classifier is integration-tested at the
 *     route level — e2e specs do NOT exercise the LLM (Empressa Q3).
 *
 *   - Per-scenario auxiliary rows:
 *       `discipline-filter`     — 2 additional engagement+submission
 *                                  pairs with non-overlapping
 *                                  classifications, so the chip-bar
 *                                  narrowing has rows to drop and
 *                                  recover.
 *       `ai-badge-persistence`  — three findings on the primary
 *                                  submission: 1 unaccepted AI, 1
 *                                  reviewer-authored, 1 unaccepted AI
 *                                  reserved for the failure-mode
 *                                  reject test.
 *       `triage-strip`          — 11 findings on the primary
 *                                  submission distributed
 *                                  2-blocker / 5-concern / 4-advisory
 *                                  to drive a non-trivial severity
 *                                  rollup, plus 3 prior submissions on
 *                                  separate engagements with the same
 *                                  applicant firm so the triage-strip
 *                                  applicant-history pill shows
 *                                  totalPrior=3, approved=2, returned=1
 *                                  with one returned reason.
 *
 *   - `cleanup()` deletes the user row + every engagement; FK cascades
 *     drop submissions / classifications / findings / atom_events the
 *     scenario produced.
 *
 * Seeding strategy mirrors `reviewer-refresh-affordances.spec.ts` — no
 * new mechanism. Direct `@workspace/db` inserts for rows whose final
 * state matters (priors with terminal verdicts, deterministic
 * classifications, fully-shaped finding rows) and the public POST for
 * the primary submission so route hooks fire.
 */

import { type APIRequestContext } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import {
  db,
  engagements,
  submissions,
  submissionClassifications,
  findings,
  users,
} from "@workspace/db";

export type PlanReviewDiscipline =
  | "building"
  | "electrical"
  | "mechanical"
  | "plumbing"
  | "residential"
  | "fire-life-safety"
  | "accessibility";

type Scenario =
  | "discipline-filter"
  | "ai-badge-persistence"
  | "triage-strip";

export interface SeedTrack1Result {
  runTag: string;
  reviewer: {
    id: string;
    displayName: string;
    disciplines: PlanReviewDiscipline[];
  };
  applicantFirm: string;
  primary: {
    engagementId: string;
    engagementName: string;
    submissionId: string;
    classification: {
      disciplines: PlanReviewDiscipline[];
      projectType: string;
    };
    findings: Array<{
      id: string;
      atomId: string;
      aiGenerated: boolean;
      status: string;
    }>;
  };
  others: Array<{
    engagementId: string;
    engagementName: string;
    submissionId: string;
    disciplines: PlanReviewDiscipline[];
  }>;
  priors: Array<{
    engagementId: string;
    submissionId: string;
    verdict: "approved" | "returned";
  }>;
  cleanup: () => Promise<void>;
}

/**
 * Plant the dev-only `pr_session` cookie that promotes the browser to
 * `audience === "internal"` with a specific reviewer id. Mirrors the
 * cookie wiring in `reviewer-refresh-affordances.spec.ts:176-194` — the
 * production session middleware fail-closes this cookie shape, so it's
 * a dev / e2e seam only.
 *
 * The `requestorId` MUST match a `users` row's `id` if the spec needs
 * `Session.requestor.disciplines` to hydrate (the session route
 * `SELECT`s by `users.id = requestor.id`; a missing row falls through
 * to `[]`, which is the "Show all" branch).
 */
export async function promoteToInternalAudience(
  context: import("@playwright/test").BrowserContext,
  opts: { requestorId: string },
): Promise<void> {
  const proxyOrigin = new URL(
    process.env["E2E_BASE_URL"] ?? "http://localhost:80",
  );
  await context.addCookies([
    {
      name: "pr_session",
      value: encodeURIComponent(
        JSON.stringify({
          audience: "internal",
          requestor: { kind: "user", id: opts.requestorId },
        }),
      ),
      domain: proxyOrigin.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
    },
  ]);
}

/**
 * Top-level entry point. Each call returns a fully-isolated fixture
 * keyed by a fresh `RUN_TAG`; specs MUST call `cleanup()` from
 * `test.afterAll` to drop the engagement(s) + user row this scenario
 * produced.
 */
export async function seedTrack1Scenario(opts: {
  scenario: Scenario;
  request: APIRequestContext;
}): Promise<SeedTrack1Result> {
  // Early-fail safety: the seeder only works against a real Postgres.
  // Mirrors the assumption in reviewer-refresh-affordances.spec.ts —
  // `@workspace/db` throws on import if `DATABASE_URL` is unset, but
  // surfacing a clear message here saves the spec runner a confusing
  // "@workspace/db threw on first import" trace.
  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "seedTrack1Scenario: DATABASE_URL must be set; the e2e suite seeds via @workspace/db direct inserts.",
    );
  }

  switch (opts.scenario) {
    case "discipline-filter":
      return seedDisciplineFilterScenario(opts.request);
    case "ai-badge-persistence":
      return seedAiBadgePersistenceScenario(opts.request);
    case "triage-strip":
      return seedTriageStripScenario(opts.request);
  }
}

// ---------- shared helpers -----------------------------------------------

function makeRunTag(prefix: string): string {
  // Compact run tag — short enough to keep test names legible, unique
  // enough that two parallel local runs don't collide on the same row.
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedReviewer(
  runTag: string,
  disciplines: PlanReviewDiscipline[],
): Promise<{ id: string; displayName: string }> {
  const id = `e2e-reviewer-${runTag}`;
  const displayName = `E2E Reviewer ${runTag}`;
  await db.insert(users).values({
    id,
    displayName,
    disciplines,
  });
  return { id, displayName };
}

async function seedEngagement(opts: {
  runTag: string;
  suffix: string;
  applicantFirm: string;
}): Promise<{ id: string; name: string }> {
  const name = `e2e Track1 Pass B ${opts.suffix} ${opts.runTag}`;
  const [row] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.toLowerCase(),
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: `${opts.suffix} Pass-B Way, Moab, UT 84532`,
      applicantFirm: opts.applicantFirm,
      status: "active",
    })
    .returning();
  if (!row) {
    throw new Error(`seedEngagement(${opts.suffix}): insert returned no row`);
  }
  return { id: row.id, name };
}

async function postSubmission(
  request: APIRequestContext,
  engagementId: string,
  note: string,
): Promise<string> {
  const resp = await request.post(
    `/api/engagements/${engagementId}/submissions`,
    {
      data: { note },
      headers: { "content-type": "application/json" },
    },
  );
  if (resp.status() !== 201) {
    throw new Error(
      `seed: POST /api/engagements/${engagementId}/submissions returned ${resp.status()}: ${await resp.text()}`,
    );
  }
  const body = (await resp.json()) as { submissionId?: string };
  if (!body.submissionId) {
    throw new Error("seed: submissions response did not include submissionId");
  }
  return body.submissionId;
}

/**
 * Overwrite the submission's classification row deterministically. The
 * primary's POST may have queued a fire-and-forget auto-classifier; the
 * upsert with `source: 'reviewer'` wins regardless of order, and the
 * `onConflictDoUpdate` keeps this safe under any race.
 */
async function upsertClassification(opts: {
  submissionId: string;
  projectType: string;
  disciplines: PlanReviewDiscipline[];
  reviewerId: string;
  reviewerDisplayName: string;
}): Promise<void> {
  await db
    .insert(submissionClassifications)
    .values({
      submissionId: opts.submissionId,
      projectType: opts.projectType,
      disciplines: opts.disciplines,
      applicableCodeBooks: ["IBC 2021", "NEC 2020"],
      confidence: "1.0",
      source: "reviewer",
      classifiedBy: {
        kind: "user",
        id: opts.reviewerId,
        displayName: opts.reviewerDisplayName,
      },
    })
    .onConflictDoUpdate({
      target: submissionClassifications.submissionId,
      set: {
        projectType: opts.projectType,
        disciplines: opts.disciplines,
        applicableCodeBooks: ["IBC 2021", "NEC 2020"],
        confidence: "1.0",
        source: "reviewer",
        classifiedBy: {
          kind: "user",
          id: opts.reviewerId,
          displayName: opts.reviewerDisplayName,
        },
        updatedAt: new Date(),
      },
    });
}

interface FindingSeed {
  severity: "blocker" | "concern" | "advisory";
  category: string;
  status: "ai-produced" | "accepted" | "rejected" | "overridden";
  text: string;
  aiGenerated: boolean;
  acceptedByReviewerId?: string;
  acceptedAt?: Date;
  reviewerStatusBy?: {
    kind: "user" | "agent" | "system";
    id: string;
    displayName?: string;
  };
}

async function insertFindings(
  submissionId: string,
  seeds: FindingSeed[],
): Promise<Array<{ id: string; atomId: string; aiGenerated: boolean; status: string }>> {
  const out: Array<{ id: string; atomId: string; aiGenerated: boolean; status: string }> = [];
  for (const seed of seeds) {
    const [row] = await db
      .insert(findings)
      .values({
        atomId: "tmp",
        submissionId,
        severity: seed.severity,
        category: seed.category,
        status: seed.status,
        text: seed.text,
        confidence: "0.85",
        aiGenerated: seed.aiGenerated,
        acceptedByReviewerId: seed.acceptedByReviewerId ?? null,
        acceptedAt: seed.acceptedAt ?? null,
        reviewerStatusBy: seed.reviewerStatusBy ?? null,
        reviewerStatusChangedAt: seed.reviewerStatusBy ? new Date() : null,
      })
      .returning({ id: findings.id });
    if (!row) throw new Error("insertFindings: returned no row");
    // Stamp the public atom id `finding:{submissionId}:{rowUuid}` to
    // mirror the route's insert helper. Keeps the public id grammar
    // consistent so a deep-link constructed off the seeded row resolves.
    const atomId = `finding:${submissionId}:${row.id}`;
    await db
      .update(findings)
      .set({ atomId })
      .where(eq(findings.id, row.id));
    out.push({
      id: row.id,
      atomId,
      aiGenerated: seed.aiGenerated,
      status: seed.status,
    });
  }
  return out;
}

function buildCleanup(args: {
  reviewerId: string;
  engagementIds: string[];
}): () => Promise<void> {
  return async () => {
    for (const id of args.engagementIds) {
      try {
        // FK cascades clean up submissions / classifications / findings /
        // atom_events (atom_events does NOT cascade — it's append-only —
        // but the rows are scoped to the engagement and a future run-tag
        // never collides with this scenario's row ids).
        await db.delete(engagements).where(eq(engagements.id, id));
      } catch {
        /* best-effort — keep teardown moving even if one row already gone */
      }
    }
    try {
      await db.delete(users).where(eq(users.id, args.reviewerId));
    } catch {
      /* best-effort */
    }
  };
}

// ---------- scenario: discipline-filter ----------------------------------

async function seedDisciplineFilterScenario(
  request: APIRequestContext,
): Promise<SeedTrack1Result> {
  const runTag = makeRunTag("disc-filter");
  const reviewerDisciplines: PlanReviewDiscipline[] = ["electrical"];
  const reviewer = await seedReviewer(runTag, reviewerDisciplines);

  // Primary (electrical-tagged) — the row the spec asserts is visible
  // under the default chip-bar narrowing.
  const primaryFirm = `E2E Disc-Filter Primary ${runTag}`;
  const primaryEng = await seedEngagement({
    runTag,
    suffix: "primary-electrical",
    applicantFirm: primaryFirm,
  });
  const primarySubId = await postSubmission(
    request,
    primaryEng.id,
    `e2e Pass B disc-filter primary ${runTag}`,
  );
  await upsertClassification({
    submissionId: primarySubId,
    projectType: "mep-replacement",
    disciplines: ["electrical", "mechanical"],
    reviewerId: reviewer.id,
    reviewerDisplayName: reviewer.displayName,
  });

  // Plumbing-only row — should be HIDDEN under the default narrowing
  // and revealed by the "Show all" affordance.
  const plumbingFirm = `E2E Disc-Filter Plumb ${runTag}`;
  const plumbingEng = await seedEngagement({
    runTag,
    suffix: "plumbing-only",
    applicantFirm: plumbingFirm,
  });
  const plumbingSubId = await postSubmission(
    request,
    plumbingEng.id,
    `e2e Pass B disc-filter plumbing ${runTag}`,
  );
  await upsertClassification({
    submissionId: plumbingSubId,
    projectType: "mep-replacement",
    disciplines: ["plumbing"],
    reviewerId: reviewer.id,
    reviewerDisplayName: reviewer.displayName,
  });

  // A second electrical-touching row (mixed disciplines) — proves the
  // narrowing is set-intersection, not exact-match.
  const mixedFirm = `E2E Disc-Filter Mixed ${runTag}`;
  const mixedEng = await seedEngagement({
    runTag,
    suffix: "mixed-electrical",
    applicantFirm: mixedFirm,
  });
  const mixedSubId = await postSubmission(
    request,
    mixedEng.id,
    `e2e Pass B disc-filter mixed ${runTag}`,
  );
  await upsertClassification({
    submissionId: mixedSubId,
    projectType: "commercial-tenant-improvement",
    disciplines: ["building", "electrical", "fire-life-safety"],
    reviewerId: reviewer.id,
    reviewerDisplayName: reviewer.displayName,
  });

  return {
    runTag,
    reviewer: { ...reviewer, disciplines: reviewerDisciplines },
    applicantFirm: primaryFirm,
    primary: {
      engagementId: primaryEng.id,
      engagementName: primaryEng.name,
      submissionId: primarySubId,
      classification: {
        projectType: "mep-replacement",
        disciplines: ["electrical", "mechanical"],
      },
      findings: [],
    },
    others: [
      {
        engagementId: plumbingEng.id,
        engagementName: plumbingEng.name,
        submissionId: plumbingSubId,
        disciplines: ["plumbing"],
      },
      {
        engagementId: mixedEng.id,
        engagementName: mixedEng.name,
        submissionId: mixedSubId,
        disciplines: ["building", "electrical", "fire-life-safety"],
      },
    ],
    priors: [],
    cleanup: buildCleanup({
      reviewerId: reviewer.id,
      engagementIds: [primaryEng.id, plumbingEng.id, mixedEng.id],
    }),
  };
}

// ---------- scenario: ai-badge-persistence -------------------------------

async function seedAiBadgePersistenceScenario(
  request: APIRequestContext,
): Promise<SeedTrack1Result> {
  const runTag = makeRunTag("ai-badge");
  const reviewerDisciplines: PlanReviewDiscipline[] = ["building"];
  const reviewer = await seedReviewer(runTag, reviewerDisciplines);

  const primaryFirm = `E2E AI-Badge ${runTag}`;
  const primaryEng = await seedEngagement({
    runTag,
    suffix: "ai-badge-primary",
    applicantFirm: primaryFirm,
  });
  const submissionId = await postSubmission(
    request,
    primaryEng.id,
    `e2e Pass B ai-badge primary ${runTag}`,
  );
  await upsertClassification({
    submissionId,
    projectType: "single-family-residence",
    disciplines: ["building", "residential"],
    reviewerId: reviewer.id,
    reviewerDisplayName: reviewer.displayName,
  });

  // Three findings:
  //   [0] AI unaccepted — happy-path target. Click Accept; reload;
  //       assert badge flips to "ai-accepted" with the reviewer's name
  //       and date.
  //   [1] Reviewer-authored — proves the badge's third branch
  //       ("Authored by reviewer (...)") renders correctly alongside.
  //   [2] AI unaccepted — failure-mode target. Click Reject; reload;
  //       assert badge stays "ai-unaccepted" and acceptance fields are
  //       still null in the DB.
  const seeded = await insertFindings(submissionId, [
    {
      severity: "concern",
      category: "egress",
      status: "ai-produced",
      text: "Stair S-1 rise/run combination is outside the IBC 2021 §1011.5.2 envelope.",
      aiGenerated: true,
    },
    {
      severity: "advisory",
      category: "other",
      status: "ai-produced",
      text: "Reviewer-authored: confirm exterior wayfinding signage location at egress courtyard.",
      aiGenerated: false,
      reviewerStatusBy: {
        kind: "user",
        id: reviewer.id,
        displayName: reviewer.displayName,
      },
    },
    {
      severity: "concern",
      category: "height",
      status: "ai-produced",
      text: "Parapet height at the south elevation reads 30in on sheet A-301; verify against IBC 2021 §1015.",
      aiGenerated: true,
    },
  ]);

  return {
    runTag,
    reviewer: { ...reviewer, disciplines: reviewerDisciplines },
    applicantFirm: primaryFirm,
    primary: {
      engagementId: primaryEng.id,
      engagementName: primaryEng.name,
      submissionId,
      classification: {
        projectType: "single-family-residence",
        disciplines: ["building", "residential"],
      },
      findings: seeded,
    },
    others: [],
    priors: [],
    cleanup: buildCleanup({
      reviewerId: reviewer.id,
      engagementIds: [primaryEng.id],
    }),
  };
}

// ---------- scenario: triage-strip ---------------------------------------

async function seedTriageStripScenario(
  request: APIRequestContext,
): Promise<SeedTrack1Result> {
  const runTag = makeRunTag("triage");
  // Triage-strip spec doesn't depend on the chip-bar narrowing; give
  // the reviewer the full discipline set so the primary row is visible
  // regardless of the default-narrowing seeding behavior.
  const reviewerDisciplines: PlanReviewDiscipline[] = [
    "building",
    "electrical",
    "fire-life-safety",
  ];
  const reviewer = await seedReviewer(runTag, reviewerDisciplines);

  // Stable applicantFirm shared across primary + 3 priors so the
  // case-insensitive trim equality match in `loadApplicantHistory`
  // surfaces the priors.
  const applicantFirm = `E2E Triage Firm ${runTag}`;
  const primaryEng = await seedEngagement({
    runTag,
    suffix: "triage-primary",
    applicantFirm,
  });
  const submissionId = await postSubmission(
    request,
    primaryEng.id,
    `e2e Pass B triage primary ${runTag}`,
  );
  await upsertClassification({
    submissionId,
    projectType: "commercial-tenant-improvement",
    disciplines: ["building", "electrical", "fire-life-safety"],
    reviewerId: reviewer.id,
    reviewerDisplayName: reviewer.displayName,
  });

  // 11 findings: 2 blocker + 5 concern + 4 advisory. Drives the
  // SeverityRollupPill's blocker-heavy → red branch and a non-trivial
  // count assertion in the spec.
  const triageSeeds: FindingSeed[] = [
    ...repeat(2, (i) => ({
      severity: "blocker" as const,
      category: "egress",
      status: "ai-produced" as const,
      text: `Blocker ${i + 1}: egress width below IBC 2021 §1005.3.2 minimum.`,
      aiGenerated: true,
    })),
    ...repeat(5, (i) => ({
      severity: "concern" as const,
      category: "use",
      status: "ai-produced" as const,
      text: `Concern ${i + 1}: occupancy classification ambiguous on cover sheet.`,
      aiGenerated: true,
    })),
    ...repeat(4, (i) => ({
      severity: "advisory" as const,
      category: "other",
      status: "ai-produced" as const,
      text: `Advisory ${i + 1}: confirm interior signage clearances against accessibility guidelines.`,
      aiGenerated: true,
    })),
  ];
  const seededFindings = await insertFindings(submissionId, triageSeeds);

  // 3 prior submissions on separate engagements with the SAME
  // applicantFirm → loadApplicantHistory rolls them up into the
  // triage-strip applicant-history pill. Verdict mix:
  //   - 2 approved
  //   - 1 corrections_requested (returned, with reviewerComment so
  //     `lastReturnReason` populates)
  // Submitted-at deltas keep the 5-row cap unambiguous; the spec
  // asserts the list size.
  const priors: Array<{
    engagementId: string;
    submissionId: string;
    verdict: "approved" | "returned";
  }> = [];
  for (let i = 0; i < 3; i++) {
    const priorEng = await seedEngagement({
      runTag,
      suffix: `triage-prior-${i + 1}`,
      applicantFirm,
    });
    const priorStatus =
      i === 1 ? "corrections_requested" : ("approved" as const);
    const priorReviewerComment =
      i === 1 ? "Egress width below code minimum on sheet A-101." : null;
    // Stagger submittedAt so the priors order deterministically in
    // the hovercard (newest-first). i=0 oldest, i=2 newest.
    const submittedAt = new Date(Date.now() - (3 - i) * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(submissions)
      .values({
        engagementId: priorEng.id,
        status: priorStatus,
        submittedAt,
        reviewerComment: priorReviewerComment,
      })
      .returning({ id: submissions.id });
    if (!row) throw new Error(`triage prior ${i}: insert returned no row`);
    priors.push({
      engagementId: priorEng.id,
      submissionId: row.id,
      verdict: priorStatus === "approved" ? "approved" : "returned",
    });
  }

  return {
    runTag,
    reviewer: { ...reviewer, disciplines: reviewerDisciplines },
    applicantFirm,
    primary: {
      engagementId: primaryEng.id,
      engagementName: primaryEng.name,
      submissionId,
      classification: {
        projectType: "commercial-tenant-improvement",
        disciplines: ["building", "electrical", "fire-life-safety"],
      },
      findings: seededFindings,
    },
    others: [],
    priors,
    cleanup: buildCleanup({
      reviewerId: reviewer.id,
      engagementIds: [primaryEng.id, ...priors.map((p) => p.engagementId)],
    }),
  };
}

function repeat<T>(n: number, fn: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => fn(i));
}

// `sql` is imported above for potential future query needs (e.g. raw
// timestamp manipulation) — referenced here so the import isn't
// stripped by an over-eager linter.
void sql;
