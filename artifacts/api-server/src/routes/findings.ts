/**
 * V1-1 / AIR-1 — finding endpoints.
 *
 * Seven routes, all reviewer-only (`session.audience === "internal"`):
 *
 *   - POST /submissions/{id}/findings/generate
 *       Kicks off an async run of the finding engine
 *       (`@workspace/finding-engine`). Returns 202 +
 *       `{ generationId, state: "pending" }`. Single-flight: a
 *       concurrent kickoff trips the partial unique index on
 *       `finding_runs (submission_id) WHERE state = 'pending'` and is
 *       mapped to 409 with the in-flight job's id.
 *   - GET /submissions/{id}/findings/status
 *       Polls the most recent run for the submission. `idle` when no
 *       run has ever fired.
 *   - GET /submissions/{id}/findings
 *       Lists current findings (newest first, includes overridden
 *       originals + their revisions for the audit pair).
 *   - GET /submissions/{id}/findings/runs
 *       Recent generation attempts capped at the sweep's keep value.
 *   - POST /findings/{id}/accept
 *   - POST /findings/{id}/reject
 *   - POST /findings/{id}/override
 *       Reviewer mutations. Override creates a NEW row with
 *       `revisionOf` pointing back; the original is stamped
 *       `overridden` in place (never deleted).
 *
 * Mirrors the parcelBriefings briefing-generate kickoff/status
 * pattern at `routes/parcelBriefings.ts:1655-1846`. The engine itself
 * runs in mock mode by default — the route never branches on the
 * mode, it just hands the resolved client to `generateFindings`.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  findings,
  findingRuns,
  submissions,
  parcelBriefings,
  briefingSources,
  type Finding,
  type FindingRun,
  type Submission,
  type BriefingSource,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  AcceptFindingParams,
  GenerateSubmissionFindingsBody,
  GenerateSubmissionFindingsParams,
  GetSubmissionFindingsGenerationStatusParams,
  ListSubmissionFindingsGenerationRunsParams,
  ListSubmissionFindingsParams,
  OverrideFindingBody,
  OverrideFindingParams,
  RejectFindingParams,
} from "@workspace/api-zod";
import {
  generateFindings,
  type BriefingSourceInput,
  type CodeSectionInput,
  type EngineFinding,
  type FindingCitation,
  type GenerateFindingsResult,
} from "@workspace/finding-engine";
import { FINDING_ENGINE_ACTOR_ID } from "@workspace/server-actor-ids";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  FINDING_EVENT_TYPES,
  type FindingEventType,
} from "../atoms/finding.atom";
import {
  getFindingLlmClient,
  getFindingLlmMode,
} from "../lib/findingLlmClient";

const router: IRouter = Router();

/** Pinned event-type constants — break compilation on a rename. */
const FINDING_GENERATED_EVENT_TYPE: FindingEventType = FINDING_EVENT_TYPES[0];
const FINDING_ACCEPTED_EVENT_TYPE: FindingEventType = FINDING_EVENT_TYPES[1];
const FINDING_REJECTED_EVENT_TYPE: FindingEventType = FINDING_EVENT_TYPES[2];
const FINDING_OVERRIDDEN_EVENT_TYPE: FindingEventType = FINDING_EVENT_TYPES[3];

/** Stable system actor for engine-driven finding events. */
const FINDING_ENGINE_ACTOR = {
  kind: "system" as const,
  id: FINDING_ENGINE_ACTOR_ID,
};

/** PG unique-violation SQLSTATE — same helper as parcelBriefings.ts. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || cause === PG_UNIQUE_VIOLATION;
}

/** Closed wire union for the run row's `state` column. */
type FindingRunState = "pending" | "completed" | "failed";

/**
 * Reviewer-only audience gate. Mirrors the helper at
 * `routes/reviewerAnnotations.ts:108-114` verbatim — kept inline
 * (not in a shared `audienceGuards.ts` module) so each route is
 * self-contained and grep-able.
 *
 * Returns `true` once the guard sent a 403 so the caller can
 * early-return.
 */
function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "findings_require_internal_audience" });
  return true;
}

/**
 * Per Phase 1A approval the keep-per-submission default is 5 with
 * env override `FINDING_RUNS_KEEP_PER_SUBMISSION`. Inlined here
 * (rather than shared with the briefing sweep helper) so a future
 * sweep tuning that touches one cap doesn't accidentally rebalance
 * the other.
 */
const DEFAULT_KEEP_PER_SUBMISSION = 5;

function resolveKeepPerSubmission(): number {
  const raw = process.env.FINDING_RUNS_KEEP_PER_SUBMISSION;
  if (!raw) return DEFAULT_KEEP_PER_SUBMISSION;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KEEP_PER_SUBMISSION;
  return n;
}

interface FindingActorWire {
  kind: "user" | "agent" | "system";
  id: string;
  displayName?: string | null;
}

/** Wire shape returned by the findings endpoints. */
interface FindingWire {
  id: string;
  submissionId: string;
  severity: "blocker" | "concern" | "advisory";
  category: string;
  status:
    | "ai-produced"
    | "accepted"
    | "rejected"
    | "overridden"
    | "promoted-to-architect";
  text: string;
  citations: FindingCitation[];
  confidence: number;
  lowConfidence: boolean;
  reviewerStatusBy: FindingActorWire | null;
  reviewerStatusChangedAt: string | null;
  reviewerComment: string | null;
  elementRef: string | null;
  sourceRef: { id: string; label: string } | null;
  aiGeneratedAt: string;
  revisionOf: string | null;
}

function actorFromRequest(req: Request): FindingActorWire | null {
  const requestor = req.session.requestor;
  if (!requestor || !requestor.id) return null;
  // The session shape's `kind` union is `"user" | "agent"`; widen
  // to the wire's `"user" | "agent" | "system"` (the wire shape is
  // more permissive because the same actor envelope round-trips
  // through history events stamped by system-actors). Narrowed
  // back at insert time.
  const wire: FindingActorWire = {
    kind: requestor.kind as FindingActorWire["kind"],
    id: requestor.id,
    displayName: null,
  };
  // Optional displayName lives on the requestor via the user lookup
  // helper, but the session middleware only populates `kind` + `id`
  // today — leave displayName null and let the FE resolve via the
  // users endpoint when needed.
  return wire;
}

function toWire(row: Finding, revisionOfAtomId: string | null): FindingWire {
  const citations = Array.isArray(row.citations)
    ? (row.citations as FindingCitation[])
    : [];
  const reviewerStatusBy =
    row.reviewerStatusBy && typeof row.reviewerStatusBy === "object"
      ? (row.reviewerStatusBy as FindingActorWire)
      : null;
  const sourceRef =
    row.sourceRef && typeof row.sourceRef === "object"
      ? (row.sourceRef as { id: string; label: string })
      : null;
  return {
    id: row.atomId,
    submissionId: row.submissionId,
    severity: row.severity as FindingWire["severity"],
    category: row.category,
    status: row.status as FindingWire["status"],
    text: row.text,
    citations,
    confidence: Number(row.confidence),
    lowConfidence: row.lowConfidence,
    reviewerStatusBy,
    reviewerStatusChangedAt: row.reviewerStatusChangedAt
      ? row.reviewerStatusChangedAt.toISOString()
      : null,
    reviewerComment: row.reviewerComment,
    elementRef: row.elementRef,
    sourceRef,
    aiGeneratedAt: row.aiGeneratedAt.toISOString(),
    revisionOf: revisionOfAtomId,
  };
}

/**
 * Look up the atom_id of a finding by its row pk. Used by the wire
 * projection to surface `revisionOf` as a public atom id (never the
 * internal uuid).
 */
async function atomIdForRowId(rowId: string | null): Promise<string | null> {
  if (!rowId) return null;
  try {
    const rows = await db
      .select({ atomId: findings.atomId })
      .from(findings)
      .where(eq(findings.id, rowId))
      .limit(1);
    return rows[0]?.atomId ?? null;
  } catch {
    return null;
  }
}

async function loadSubmission(submissionId: string): Promise<Submission | null> {
  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  return rows[0] ?? null;
}

async function loadFindingByAtomId(atomId: string): Promise<Finding | null> {
  const rows = await db
    .select()
    .from(findings)
    .where(eq(findings.atomId, atomId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Project a `briefing_sources` row into the engine's input shape.
 * Mirrors the helper at parcelBriefings.ts:1280-1289.
 */
function toEngineSourceInput(s: BriefingSource): BriefingSourceInput {
  return {
    id: s.id,
    layerKind: s.layerKind,
    sourceKind: s.sourceKind,
    provider: s.provider,
    snapshotDate: s.snapshotDate.toISOString(),
    note: s.note,
  };
}

/**
 * Resolve the engine's input bundle for a given submission. The
 * route layer does this synchronously before kicking off the async
 * run so an obvious "no engagement / no briefing" gap fails fast as
 * a 400 rather than burning a run.
 *
 * V1-1 baseline: code-section atomIds are intentionally NOT
 * retrieved here — the AIR-1 implementation notes left retrieval
 * out of the v1 surface. The engine still works (mock mode emits
 * the deterministic fixture against whatever sources are passed),
 * and a follow-up commit will wire `lib/codes/retrieval` once
 * Empressa approves the retrieval policy.
 */
async function resolveEngineInputs(submissionId: string): Promise<{
  briefingNarrative: string | undefined;
  sources: BriefingSource[];
}> {
  const subRows = await db
    .select({ engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) return { briefingNarrative: undefined, sources: [] };

  const briefingRows = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, sub.engagementId))
    .limit(1);
  const briefing = briefingRows[0];
  if (!briefing) return { briefingNarrative: undefined, sources: [] };

  // Pull the briefing's narrative if one has been generated; the
  // engine excerpts it inside the `<briefing>` block.
  const narrativeFragments: string[] = [];
  for (const section of [
    briefing.sectionA,
    briefing.sectionB,
    briefing.sectionC,
    briefing.sectionD,
    briefing.sectionE,
    briefing.sectionF,
    briefing.sectionG,
  ]) {
    if (section) narrativeFragments.push(section);
  }
  const briefingNarrative =
    narrativeFragments.length > 0
      ? narrativeFragments.join("\n\n")
      : undefined;

  // Current (non-superseded) sources for the engagement's briefing.
  const sources = await db
    .select()
    .from(briefingSources)
    .where(
      and(
        eq(briefingSources.briefingId, briefing.id),
        isNull(briefingSources.supersededAt),
      ),
    );

  return { briefingNarrative, sources };
}

/**
 * Best-effort emission of `finding.generated` for one inserted row.
 * Mirrors the contract used by parcelBriefings — a transient history
 * outage cannot fail the in-flight generation.
 */
async function emitFindingGeneratedEvent(
  history: ReturnType<typeof getHistoryService>,
  finding: Finding,
  generationId: string,
  reqLog: typeof logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "finding",
      entityId: finding.atomId,
      eventType: FINDING_GENERATED_EVENT_TYPE,
      actor: FINDING_ENGINE_ACTOR,
      payload: {
        findingId: finding.id,
        atomId: finding.atomId,
        submissionId: finding.submissionId,
        severity: finding.severity,
        category: finding.category,
        confidence: Number(finding.confidence),
        generationId,
      },
    });
    reqLog.debug(
      {
        findingId: finding.id,
        atomId: finding.atomId,
        eventId: event.id,
      },
      "finding.generated event appended",
    );
  } catch (err) {
    reqLog.error(
      { err, findingId: finding.id, atomId: finding.atomId },
      "finding.generated event append failed — row write kept",
    );
  }
}

/**
 * Best-effort emission for the reviewer-mutation events
 * (`finding.accepted` / `finding.rejected` / `finding.overridden`).
 */
async function emitFindingMutationEvent(
  history: ReturnType<typeof getHistoryService>,
  args: {
    finding: Finding;
    eventType: FindingEventType;
    actor: FindingActorWire | { kind: "system"; id: string };
    payload: Record<string, unknown>;
  },
  reqLog: typeof logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "finding",
      entityId: args.finding.atomId,
      eventType: args.eventType,
      actor: args.actor,
      payload: args.payload,
    });
    reqLog.debug(
      {
        findingId: args.finding.id,
        atomId: args.finding.atomId,
        eventType: args.eventType,
        eventId: event.id,
      },
      `${args.eventType} event appended`,
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        findingId: args.finding.id,
        atomId: args.finding.atomId,
        eventType: args.eventType,
      },
      `${args.eventType} event append failed — row write kept`,
    );
  }
}

/** Persist one engine-emitted finding. */
async function persistFinding(
  engineFinding: EngineFinding,
  generationId: string,
): Promise<Finding> {
  const [row] = await db
    .insert(findings)
    .values({
      atomId: engineFinding.atomId,
      submissionId: engineFinding.submissionId,
      severity: engineFinding.severity,
      category: engineFinding.category,
      status: "ai-produced",
      text: engineFinding.text,
      citations: engineFinding.citations as unknown as Record<string, unknown>[],
      confidence: String(engineFinding.confidence),
      lowConfidence: engineFinding.lowConfidence,
      elementRef: engineFinding.elementRef,
      sourceRef:
        engineFinding.sourceRef as unknown as Record<string, unknown> | null,
      aiGeneratedAt: engineFinding.aiGeneratedAt,
      findingRunId: generationId,
    })
    .returning();
  return row!;
}

/**
 * Update a run row to a terminal state. Mirrors
 * parcelBriefings.ts:1509-1551.
 */
async function finalizeRun(
  runId: string,
  patch: {
    state: Extract<FindingRunState, "completed" | "failed">;
    error: string | null;
    invalidCitationCount: number | null;
    invalidCitations: string[] | null;
    discardedFindingCount: number | null;
  },
  reqLog: typeof logger,
): Promise<void> {
  try {
    const updated = await db
      .update(findingRuns)
      .set({
        state: patch.state,
        error: patch.error,
        invalidCitationCount: patch.invalidCitationCount,
        invalidCitations: patch.invalidCitations,
        discardedFindingCount: patch.discardedFindingCount,
        completedAt: new Date(),
      })
      .where(eq(findingRuns.id, runId))
      .returning({ id: findingRuns.id });
    if (updated.length === 0) {
      reqLog.warn(
        { runId, state: patch.state },
        "finding generation: run row missing on terminal update (submission likely deleted)",
      );
    }
  } catch (err) {
    reqLog.error(
      { err, runId, state: patch.state },
      "finding generation: terminal run-row update failed",
    );
  }
}

/**
 * The async generation body. Runs after the kickoff route has 202'd.
 * Persists every state transition to the `finding_runs` row so the
 * status endpoint surfaces the run's true outcome even if the
 * api-server restarts mid-flight or another instance handles the
 * poll. Never throws — terminal failures land in the row.
 */
async function runFindingGeneration(args: {
  submissionId: string;
  generationId: string;
  reqLog: typeof logger;
}): Promise<void> {
  const { submissionId, generationId, reqLog } = args;
  try {
    const inputs = await resolveEngineInputs(submissionId);
    const client = await getFindingLlmClient();
    const mode = getFindingLlmMode();
    reqLog.info(
      {
        submissionId,
        generationId,
        mode,
        sourceCount: inputs.sources.length,
        hasNarrative: !!inputs.briefingNarrative,
      },
      "finding generation: engine call starting",
    );

    const subRows = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);
    const sub = subRows[0];
    if (!sub) {
      throw new Error(`submission row vanished mid-generation: ${submissionId}`);
    }

    const codeSections: CodeSectionInput[] = [];
    const result: GenerateFindingsResult = await generateFindings(
      {
        submission: {
          id: sub.id,
          jurisdiction: sub.jurisdiction,
          projectName: null,
          note: sub.note,
        },
        briefingNarrative: inputs.briefingNarrative,
        sources: inputs.sources.map(toEngineSourceInput),
        codeSections,
        bimElements: [],
      },
      {
        mode,
        ...(client ? { anthropicClient: client } : {}),
      },
    );

    // Insert findings, then emit events. Atomicity within the run is
    // preserved by the run row's pending → completed transition; the
    // FE only flips to "completed" when the row update lands, so a
    // partial finding-insert window can't be observed externally.
    const persistedRows: Finding[] = [];
    for (const ef of result.findings) {
      try {
        const row = await persistFinding(ef, generationId);
        persistedRows.push(row);
      } catch (err) {
        reqLog.error(
          { err, atomId: ef.atomId, submissionId },
          "finding generation: row insert failed — continuing",
        );
      }
    }

    const history = getHistoryService();
    for (const row of persistedRows) {
      await emitFindingGeneratedEvent(history, row, generationId, reqLog);
    }

    if (result.invalidCitations.length > 0) {
      reqLog.warn(
        {
          submissionId,
          generationId,
          invalidCount: result.invalidCitations.length,
          discardedCount: result.discardedFindings.length,
          sample: result.invalidCitations.slice(0, 5),
        },
        "finding generation: engine emitted unresolved citation tokens (stripped)",
      );
    }

    await finalizeRun(
      generationId,
      {
        state: "completed",
        error: null,
        invalidCitationCount: result.invalidCitations.length,
        invalidCitations: [...result.invalidCitations],
        discardedFindingCount: result.discardedFindings.length,
      },
      reqLog,
    );
    reqLog.info(
      {
        submissionId,
        generationId,
        producer: result.producer,
        persistedCount: persistedRows.length,
        invalidCitationCount: result.invalidCitations.length,
        discardedFindingCount: result.discardedFindings.length,
      },
      "finding generation: completed",
    );
  } catch (err) {
    const message = (err as Error).message ?? "unknown engine failure";
    await finalizeRun(
      generationId,
      {
        state: "failed",
        error: message,
        invalidCitationCount: null,
        invalidCitations: null,
        discardedFindingCount: null,
      },
      reqLog,
    );
    reqLog.error(
      { err, submissionId, generationId },
      "finding generation: failed",
    );
  }
}

// ─── POST /submissions/:id/findings/generate ─────────────────────

router.post(
  "/submissions/:submissionId/findings/generate",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const params = GenerateSubmissionFindingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_submission_id" });
      return;
    }
    const bodyParse = GenerateSubmissionFindingsBody.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      res.status(400).json({ error: "invalid_generate_findings_body" });
      return;
    }
    const submissionId = params.data.submissionId;

    try {
      const sub = await loadSubmission(submissionId);
      if (!sub) {
        res.status(404).json({ error: "submission_not_found" });
        return;
      }

      let kickoffRow: FindingRun;
      try {
        const inserted = await db
          .insert(findingRuns)
          .values({
            submissionId,
            state: "pending",
          })
          .returning();
        kickoffRow = inserted[0]!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Another kickoff won the single-flight race. Surface its
          // id so the caller can poll the same job's outcome rather
          // than retrying with a fresh generationId.
          const [existing] = await db
            .select({ id: findingRuns.id })
            .from(findingRuns)
            .where(eq(findingRuns.submissionId, submissionId))
            .orderBy(desc(findingRuns.startedAt))
            .limit(1);
          res.status(409).json({
            error: "finding_generation_already_in_flight",
            generationId: existing?.id ?? null,
          });
          return;
        }
        throw err;
      }

      const generationId = kickoffRow.id;

      // Fire-and-forget; the row's state is what the status endpoint
      // reads. We do not await — the 202 returns immediately.
      void runFindingGeneration({
        submissionId,
        generationId,
        reqLog,
      });

      reqLog.info(
        { submissionId, generationId },
        "finding generation: kicked off",
      );
      res.status(202).json({ generationId, state: "pending" });
    } catch (err) {
      logger.error({ err, submissionId }, "kickoff finding generation failed");
      res.status(500).json({ error: "Failed to kick off finding generation" });
    }
  },
);

// ─── GET /submissions/:id/findings/status ────────────────────────

router.get(
  "/submissions/:submissionId/findings/status",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const params = GetSubmissionFindingsGenerationStatusParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(400).json({ error: "invalid_submission_id" });
      return;
    }
    const submissionId = params.data.submissionId;

    try {
      const sub = await loadSubmission(submissionId);
      if (!sub) {
        res.status(404).json({ error: "submission_not_found" });
        return;
      }
      const [run] = await db
        .select()
        .from(findingRuns)
        .where(eq(findingRuns.submissionId, submissionId))
        .orderBy(desc(findingRuns.startedAt))
        .limit(1);
      if (!run) {
        res.json({
          generationId: null,
          state: "idle",
          startedAt: null,
          completedAt: null,
          error: null,
          invalidCitationCount: null,
          invalidCitations: null,
          discardedFindingCount: null,
        });
        return;
      }
      res.json({
        generationId: run.id,
        state: run.state as FindingRunState,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        error: run.error,
        invalidCitationCount: run.invalidCitationCount,
        invalidCitations: run.invalidCitations,
        discardedFindingCount: run.discardedFindingCount,
      });
    } catch (err) {
      logger.error(
        { err, submissionId },
        "get finding generation status failed",
      );
      res.status(500).json({ error: "Failed to read finding status" });
    }
  },
);

// ─── GET /submissions/:id/findings ───────────────────────────────

router.get(
  "/submissions/:submissionId/findings",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const params = ListSubmissionFindingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_submission_id" });
      return;
    }
    const submissionId = params.data.submissionId;

    try {
      const sub = await loadSubmission(submissionId);
      if (!sub) {
        res.status(404).json({ error: "submission_not_found" });
        return;
      }
      const rows = await db
        .select()
        .from(findings)
        .where(eq(findings.submissionId, submissionId))
        .orderBy(desc(findings.createdAt));

      // Resolve revisionOf → atom id for each row in one pass. A
      // separate query batch keeps the wire shape decoupled from
      // the row's internal uuid pk.
      const revisionOfMap = new Map<string, string>();
      const revisionRowIds = rows
        .map((r) => r.revisionOf)
        .filter((v): v is string => !!v);
      if (revisionRowIds.length > 0) {
        const originals = await db
          .select({ id: findings.id, atomId: findings.atomId })
          .from(findings);
        for (const o of originals) {
          revisionOfMap.set(o.id, o.atomId);
        }
      }
      const wire = rows.map((r) =>
        toWire(r, r.revisionOf ? revisionOfMap.get(r.revisionOf) ?? null : null),
      );
      res.json({ findings: wire });
    } catch (err) {
      logger.error({ err, submissionId }, "list submission findings failed");
      res.status(500).json({ error: "Failed to list findings" });
    }
  },
);

// ─── GET /submissions/:id/findings/runs ──────────────────────────

router.get(
  "/submissions/:submissionId/findings/runs",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const params = ListSubmissionFindingsGenerationRunsParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(400).json({ error: "invalid_submission_id" });
      return;
    }
    const submissionId = params.data.submissionId;

    try {
      const sub = await loadSubmission(submissionId);
      if (!sub) {
        res.status(404).json({ error: "submission_not_found" });
        return;
      }
      const limit = resolveKeepPerSubmission();
      const rows = await db
        .select()
        .from(findingRuns)
        .where(eq(findingRuns.submissionId, submissionId))
        .orderBy(desc(findingRuns.startedAt))
        .limit(limit);

      const runs = rows.map((r) => ({
        generationId: r.id,
        state: r.state as FindingRunState,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        error: r.error,
        invalidCitationCount: r.invalidCitationCount,
        invalidCitations: r.invalidCitations,
        discardedFindingCount: r.discardedFindingCount,
      }));
      res.json({ runs });
    } catch (err) {
      logger.error({ err, submissionId }, "list finding runs failed");
      res.status(500).json({ error: "Failed to list finding runs" });
    }
  },
);

// ─── Reviewer mutations ──────────────────────────────────────────

/**
 * Compute the next status from a current status. Returns null when
 * the transition is forbidden (route maps null → 409).
 *
 * Locked transitions per Phase 1A:
 *   - accept  : ai-produced → accepted; accepted → accepted (refresh)
 *   - reject  : ai-produced → rejected; rejected → rejected (refresh)
 *   - override: any non-overridden state can be overridden
 */
function nextStatusForAccept(current: string): "accepted" | null {
  if (current === "ai-produced" || current === "accepted") return "accepted";
  return null;
}

function nextStatusForReject(current: string): "rejected" | null {
  if (current === "ai-produced" || current === "rejected") return "rejected";
  return null;
}

router.post(
  "/findings/:findingId/accept",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const params = AcceptFindingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_finding_id" });
      return;
    }
    const findingId = params.data.findingId;
    const actor = actorFromRequest(req);
    if (!actor) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }

    try {
      const row = await loadFindingByAtomId(findingId);
      if (!row) {
        res.status(404).json({ error: "finding_not_found" });
        return;
      }
      const next = nextStatusForAccept(row.status);
      if (!next) {
        res.status(409).json({ error: "finding_status_forbids_accept" });
        return;
      }
      const now = new Date();
      const [updated] = await db
        .update(findings)
        .set({
          status: next,
          reviewerStatusBy: actor as unknown as Record<string, unknown>,
          reviewerStatusChangedAt: now,
          updatedAt: now,
        })
        .where(eq(findings.id, row.id))
        .returning();
      const finalRow = updated!;
      const revisionOfAtomId = await atomIdForRowId(finalRow.revisionOf);

      await emitFindingMutationEvent(
        getHistoryService(),
        {
          finding: finalRow,
          eventType: FINDING_ACCEPTED_EVENT_TYPE,
          actor,
          payload: {
            findingId: finalRow.id,
            atomId: finalRow.atomId,
            submissionId: finalRow.submissionId,
            previousStatus: row.status,
          },
        },
        reqLog,
      );
      res.json({ finding: toWire(finalRow, revisionOfAtomId) });
    } catch (err) {
      logger.error({ err, findingId }, "accept finding failed");
      res.status(500).json({ error: "Failed to accept finding" });
    }
  },
);

router.post(
  "/findings/:findingId/reject",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const params = RejectFindingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_finding_id" });
      return;
    }
    const findingId = params.data.findingId;
    const actor = actorFromRequest(req);
    if (!actor) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }

    try {
      const row = await loadFindingByAtomId(findingId);
      if (!row) {
        res.status(404).json({ error: "finding_not_found" });
        return;
      }
      const next = nextStatusForReject(row.status);
      if (!next) {
        res.status(409).json({ error: "finding_status_forbids_reject" });
        return;
      }
      const now = new Date();
      const [updated] = await db
        .update(findings)
        .set({
          status: next,
          reviewerStatusBy: actor as unknown as Record<string, unknown>,
          reviewerStatusChangedAt: now,
          updatedAt: now,
        })
        .where(eq(findings.id, row.id))
        .returning();
      const finalRow = updated!;
      const revisionOfAtomId = await atomIdForRowId(finalRow.revisionOf);

      await emitFindingMutationEvent(
        getHistoryService(),
        {
          finding: finalRow,
          eventType: FINDING_REJECTED_EVENT_TYPE,
          actor,
          payload: {
            findingId: finalRow.id,
            atomId: finalRow.atomId,
            submissionId: finalRow.submissionId,
            previousStatus: row.status,
          },
        },
        reqLog,
      );
      res.json({ finding: toWire(finalRow, revisionOfAtomId) });
    } catch (err) {
      logger.error({ err, findingId }, "reject finding failed");
      res.status(500).json({ error: "Failed to reject finding" });
    }
  },
);

router.post(
  "/findings/:findingId/override",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const params = OverrideFindingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_finding_id" });
      return;
    }
    const body = OverrideFindingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_override_body" });
      return;
    }
    const findingId = params.data.findingId;
    const actor = actorFromRequest(req);
    if (!actor) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }

    try {
      const original = await loadFindingByAtomId(findingId);
      if (!original) {
        res.status(404).json({ error: "finding_not_found" });
        return;
      }

      const now = new Date();
      // Construct the new atom id for the revision row. The format
      // mirrors the engine's stamping at engine.ts so the FE deep-
      // link grammar continues to resolve.
      const newUlid =
        Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).slice(2, 10).toUpperCase();
      const revisionAtomId = `finding:${original.submissionId}:${newUlid}`;

      const revisionRow = await db.transaction(async (tx) => {
        // 1. Stamp the original row `overridden`.
        await tx
          .update(findings)
          .set({
            status: "overridden",
            reviewerStatusBy: actor as unknown as Record<string, unknown>,
            reviewerStatusChangedAt: now,
            reviewerComment: body.data.reviewerComment,
            updatedAt: now,
          })
          .where(eq(findings.id, original.id));

        // 2. Insert the new revision row with reviewer's text.
        const [revision] = await tx
          .insert(findings)
          .values({
            atomId: revisionAtomId,
            submissionId: original.submissionId,
            severity: body.data.severity,
            category: body.data.category,
            status: "overridden",
            text: body.data.text,
            // Override does not re-cite; the reviewer's body may
            // carry inline tokens but the route does not re-validate
            // here (V1-1 baseline — the validator's resolver inputs
            // are not available without re-running the engine).
            citations: [] as unknown as Record<string, unknown>[],
            confidence: original.confidence,
            lowConfidence: original.lowConfidence,
            reviewerStatusBy:
              actor as unknown as Record<string, unknown>,
            reviewerStatusChangedAt: now,
            reviewerComment: body.data.reviewerComment,
            elementRef: original.elementRef,
            sourceRef:
              original.sourceRef as unknown as Record<string, unknown> | null,
            aiGeneratedAt: original.aiGeneratedAt,
            revisionOf: original.id,
          })
          .returning();
        return revision!;
      });

      await emitFindingMutationEvent(
        getHistoryService(),
        {
          finding: original,
          eventType: FINDING_OVERRIDDEN_EVENT_TYPE,
          actor,
          payload: {
            findingId: original.id,
            originalAtomId: original.atomId,
            revisionAtomId,
            submissionId: original.submissionId,
            previousStatus: original.status,
          },
        },
        reqLog,
      );
      res.json({ finding: toWire(revisionRow, original.atomId) });
    } catch (err) {
      logger.error({ err, findingId }, "override finding failed");
      res.status(500).json({ error: "Failed to override finding" });
    }
  },
);

export default router;
