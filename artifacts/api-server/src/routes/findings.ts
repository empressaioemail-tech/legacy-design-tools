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
  engagements,
  findings,
  findingRuns,
  submissions,
  parcelBriefings,
  briefingSources,
  materializableElements,
  type Finding,
  type FindingRun,
  type Submission,
  type BriefingSource,
  type MaterializableElement,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  keyFromEngagement,
  retrieveAtomsForQuestion,
  type RetrievedAtom,
} from "@workspace/codes";
import {
  AcceptFindingParams,
  CreateSubmissionFindingBody,
  CreateSubmissionFindingParams,
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
  type BimElementInput,
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
import { publishSubmissionFindingEvent } from "../lib/submissionLiveEvents";

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

/**
 * Top-K cap for the per-submission code-atom retrieval that feeds the
 * finding engine's `<reference_code_atoms>` block. Matches `chat.ts`'s
 * `MAX_RETRIEVED_ATOMS = 8` precedent (the original V1-1 implementation
 * notes claimed K=12 — that was wrong; the chat path has always been 8,
 * and V1-7 Phase 1A confirmed alignment).
 */
const MAX_FINDING_RETRIEVED_ATOMS = 8;

/**
 * Hard cap on the briefing-narrative excerpt used as the retrieval
 * query. The full A–G narrative can run multiple KB; embedding models
 * accept long inputs but a tighter window keeps the embedding focused
 * on the parcel-specific signal at the top of the narrative
 * (executive summary + threshold issues), which is where vector
 * relevance is concentrated for the kinds of compliance questions the
 * engine surfaces.
 */
const RETRIEVAL_QUERY_MAX_CHARS = 1500;

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
 * Project a {@link RetrievedAtom} into the engine's `CodeSectionInput`.
 *
 * The engine's `<reference_code_atoms>` block is the resolver allow-list
 * the citation validator strips against — every `[[CODE:atomId]]` token
 * the model emits must point at one of these `atomId` values. The
 * `label` follows the chat-side fallback chain
 * (`sectionNumber → sectionTitle → codeBook`, with the title appended
 * for context when both are present); the `snippet` is the atom's full
 * body, which the prompt assembler in
 * `lib/finding-engine/src/prompt.ts` truncates to
 * `PROMPT_CODE_SNIPPET_MAX_CHARS` before serialization.
 */
function toCodeSectionInput(a: RetrievedAtom): CodeSectionInput {
  const ref = a.sectionNumber ?? a.sectionTitle ?? a.codeBook;
  const label = a.sectionTitle && a.sectionNumber
    ? `${ref} — ${a.sectionTitle}`
    : ref;
  return {
    atomId: a.id,
    label,
    snippet: a.body,
  };
}

/**
 * Project a `materializable_elements` row into the engine's
 * `BimElementInput`.
 *
 * `ref` is the row's uuid pk (Phase 1A decision Ask #3 — raw uuid is
 * the wire shape; the FE drill-in resolves uuid → element via
 * existing `/bim-models/...` routes). The mock fixture at
 * `findingsMock.ts:170` uses a typed pointer like `"wall:north-side-l2"`
 * but that was illustrative shorthand — real wire is the uuid.
 *
 * `label` falls back to `elementKind` when no operator-authored label
 * exists. `description` carries the lock state so the prompt can
 * surface "advisory" elements differently from "locked" geometry the
 * architect may not modify without a divergence event.
 */
function toBimElementInput(row: MaterializableElement): BimElementInput {
  return {
    ref: row.id,
    label: row.label ?? row.elementKind,
    description: row.locked
      ? `${row.elementKind} (locked)`
      : `${row.elementKind} (advisory)`,
  };
}

/**
 * Resolve the engine's input bundle for a given submission. Loads the
 * submission's engagement, the engagement's parcel-briefing (and
 * narrative), the briefing's current sources + materializable
 * elements, and a jurisdiction-scoped top-K of code atoms.
 *
 * V1-7 wired in `codeSections` (retrieved via `lib/codes/retrieval`)
 * and `bimElements` (from `materializable_elements`) — V1-1 had
 * passed `[]` for both. The retrieval call is wrapped in try/catch
 * (warn-and-continue) so a transient embedding-service or DB hiccup
 * cannot fail the in-flight generation; mirrors the chat.ts fail-safe
 * at routes/chat.ts:607-612.
 *
 * Returns empty arrays for the new fields when the prerequisite data
 * is missing:
 *   - `codeSections: []` when the engagement's jurisdiction does not
 *     resolve to a registered key (no warmup configured for this
 *     locale → no atoms in our corpus to retrieve from)
 *   - `bimElements: []` when no parcel-briefing exists yet (the
 *     materializable-element rows hang off briefing_id, so without a
 *     briefing there is nothing to surface).
 */
async function resolveEngineInputs(
  submissionId: string,
  log: typeof logger,
): Promise<{
  briefingNarrative: string | undefined;
  sources: BriefingSource[];
  codeSections: CodeSectionInput[];
  bimElements: BimElementInput[];
}> {
  const subRows = await db
    .select({ engagementId: submissions.engagementId })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  const sub = subRows[0];
  if (!sub) {
    return {
      briefingNarrative: undefined,
      sources: [],
      codeSections: [],
      bimElements: [],
    };
  }

  // Load the engagement so we can resolve its jurisdiction key for
  // retrieval. Same key-resolution chain chat.ts uses (structured
  // city/state → freeform jurisdiction → address scan), so a
  // submission against an engagement with a recognized location
  // gets the same atoms here as that engagement's chat turns would.
  const engRows = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, sub.engagementId))
    .limit(1);
  const engagement = engRows[0];
  const jurisdictionKey = engagement
    ? keyFromEngagement({
        jurisdictionCity: engagement.jurisdictionCity,
        jurisdictionState: engagement.jurisdictionState,
        jurisdiction: engagement.jurisdiction,
        address: engagement.address,
      })
    : null;

  const briefingRows = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, sub.engagementId))
    .limit(1);
  const briefing = briefingRows[0];

  // Pull the briefing's narrative if one has been generated; the
  // engine excerpts it inside the `<briefing>` block. Doubles as the
  // retrieval query below — the briefing is the richest semantic
  // signal we have for "what compliance issues might this submission
  // surface?".
  let briefingNarrative: string | undefined;
  if (briefing) {
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
    if (narrativeFragments.length > 0) {
      briefingNarrative = narrativeFragments.join("\n\n");
    }
  }

  // Current (non-superseded) sources for the engagement's briefing.
  const sources = briefing
    ? await db
        .select()
        .from(briefingSources)
        .where(
          and(
            eq(briefingSources.briefingId, briefing.id),
            isNull(briefingSources.supersededAt),
          ),
        )
    : [];

  // V1-7: code-atom retrieval. Skip entirely when the engagement has
  // no recognized jurisdiction (the `code_atoms` corpus is keyed on
  // `jurisdictionKey`; without a key there is nothing to retrieve and
  // the lexical-fallback path would just return []). The synthesized
  // fallback query handles the briefing-not-yet-generated case so a
  // submission can still get code context from the corpus.
  let codeSections: CodeSectionInput[] = [];
  if (jurisdictionKey) {
    const fallbackQuery =
      `Compliance review for ${
        engagement?.name ?? `submission ${submissionId}`
      } in ${engagement?.jurisdiction ?? "unknown jurisdiction"}.`;
    const rawQuery = briefingNarrative ?? fallbackQuery;
    const query =
      rawQuery.length > RETRIEVAL_QUERY_MAX_CHARS
        ? rawQuery.slice(0, RETRIEVAL_QUERY_MAX_CHARS)
        : rawQuery;
    try {
      const atoms = await retrieveAtomsForQuestion({
        jurisdictionKey,
        question: query,
        limit: MAX_FINDING_RETRIEVED_ATOMS,
        logger: log,
      });
      codeSections = atoms.map(toCodeSectionInput);
      log.info(
        {
          submissionId,
          jurisdictionKey,
          retrievedCount: codeSections.length,
          queryLength: query.length,
          queryFromBriefing: briefingNarrative !== undefined,
        },
        "finding generation: retrieval populated codeSections",
      );
    } catch (err) {
      // Warn-and-continue: a transient retrieval failure should not
      // burn an entire run. The engine will produce findings against
      // sources + briefing narrative alone (mock mode) or skip code
      // citations against a degraded reference block (anthropic mode
      // — tokens cite only briefing-source ids, code citations get
      // stripped by the validator).
      log.warn(
        { err, submissionId, jurisdictionKey },
        "finding generation: code retrieval failed — continuing without code context",
      );
    }
  } else {
    log.info(
      { submissionId },
      "finding generation: no jurisdiction key resolved — skipping code retrieval",
    );
  }

  // V1-7: materializable-element load. Hangs off the briefing row,
  // not the bim-model row (the schema's FK is to `parcel_briefings`).
  // Skipped when no briefing exists — there is nothing for the engine
  // to anchor `elementRef` against. No K-cap because the seven
  // element kinds + per-engagement bound (Spec 53 §4) keep this list
  // small in practice; if growth becomes a concern, a cap can be
  // added without touching the engine surface.
  let bimElements: BimElementInput[] = [];
  if (briefing) {
    try {
      const matRows = await db
        .select()
        .from(materializableElements)
        .where(eq(materializableElements.briefingId, briefing.id));
      bimElements = matRows.map(toBimElementInput);
    } catch (err) {
      log.warn(
        { err, submissionId, briefingId: briefing.id },
        "finding generation: materializable-element load failed — continuing without bim elements",
      );
    }
  }

  return { briefingNarrative, sources, codeSections, bimElements };
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
    const inputs = await resolveEngineInputs(submissionId, reqLog);
    const client = await getFindingLlmClient();
    const mode = getFindingLlmMode();
    reqLog.info(
      {
        submissionId,
        generationId,
        mode,
        sourceCount: inputs.sources.length,
        codeSectionCount: inputs.codeSections.length,
        bimElementCount: inputs.bimElements.length,
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
        codeSections: inputs.codeSections,
        bimElements: inputs.bimElements,
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
      // PLR-9 — fan out to any open SSE subscribers for the
      // submission so reviewer cohorts watching the run see new
      // rows stream in without a manual refetch.
      publishSubmissionFindingEvent({
        submissionId: row.submissionId,
        type: "finding.added",
        payload: {
          findingId: row.atomId,
          severity: row.severity,
          category: row.category,
          generationId,
          source: "engine",
        },
      });
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
      { err, error: message, submissionId, generationId },
      "finding generation: failed",
    );
  }
}

/**
 * Outcome of {@link kickoffFindingGenerationForSubmission}: either a
 * fresh run was started, or the partial-unique index tripped because
 * one is already in flight.
 */
export type FindingKickoffOutcome =
  | { kind: "started"; generationId: string }
  | { kind: "already_running"; generationId: string | null };

/**
 * Insert the `finding_runs` kickoff row and dispatch
 * `runFindingGeneration` fire-and-forget. Shared by the manual
 * generate route and the auto-trigger hook so single-flight + dispatch
 * live in exactly one place. Caller is responsible for verifying the
 * submission row exists; on unique-violation the helper returns
 * `already_running` rather than throwing.
 */
export async function kickoffFindingGenerationForSubmission(
  submissionId: string,
  reqLog: typeof logger,
): Promise<FindingKickoffOutcome> {
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
      const [existing] = await db
        .select({ id: findingRuns.id })
        .from(findingRuns)
        .where(eq(findingRuns.submissionId, submissionId))
        .orderBy(desc(findingRuns.startedAt))
        .limit(1);
      return { kind: "already_running", generationId: existing?.id ?? null };
    }
    throw err;
  }

  const generationId = kickoffRow.id;

  // Fire-and-forget; the row's state is what the status endpoint
  // reads. We do not await — callers return immediately.
  void runFindingGeneration({
    submissionId,
    generationId,
    reqLog,
  });

  reqLog.info(
    { submissionId, generationId },
    "finding generation: kicked off",
  );
  return { kind: "started", generationId };
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

      const outcome = await kickoffFindingGenerationForSubmission(
        submissionId,
        reqLog,
      );
      if (outcome.kind === "already_running") {
        // Another kickoff won the single-flight race. Surface its
        // id so the caller can poll the same job's outcome rather
        // than retrying with a fresh generationId.
        res.status(409).json({
          error: "finding_generation_already_in_flight",
          generationId: outcome.generationId,
        });
        return;
      }
      res
        .status(202)
        .json({ generationId: outcome.generationId, state: "pending" });
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
      //
      // Narrow the SELECT to only the row uuids actually referenced by
      // the listed rows' `revision_of` columns — the original
      // implementation scanned the entire `findings` table with no
      // WHERE clause, which would unboundedly read across all tenants
      // once findings start accumulating in production.
      const revisionOfMap = new Map<string, string>();
      const revisionRowIds = rows
        .map((r) => r.revisionOf)
        .filter((v): v is string => !!v);
      if (revisionRowIds.length > 0) {
        const originals = await db
          .select({ id: findings.id, atomId: findings.atomId })
          .from(findings)
          .where(inArray(findings.id, revisionRowIds));
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

// ─── POST /submissions/:id/findings (manual-add) ───
//
// Reviewer adds a finding the AI engine missed. Persists with
// `status="ai-produced"` (so accept/reject/override transitions
// behave identically to engine rows), `confidence=1.0` (the row is
// reviewer-trusted), and reviewer attribution stamped on
// `reviewerStatusBy` so consumers can distinguish a manual row from
// an untouched engine row by the actor's `kind === "user"`.

router.post(
  "/submissions/:submissionId/findings",
  async (req: Request, res: Response): Promise<void> => {
    if (requireReviewerAudience(req, res)) return;
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const params = CreateSubmissionFindingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_submission_id" });
      return;
    }
    const body = CreateSubmissionFindingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_create_finding_body" });
      return;
    }
    const submissionId = params.data.submissionId;
    const actor = actorFromRequest(req);
    if (!actor) {
      res.status(400).json({ error: "missing_session_requestor" });
      return;
    }

    try {
      const sub = await loadSubmission(submissionId);
      if (!sub) {
        res.status(404).json({ error: "submission_not_found" });
        return;
      }

      const title = body.data.title.trim();
      if (title.length === 0) {
        res.status(400).json({ error: "invalid_create_finding_body" });
        return;
      }
      const description = body.data.description?.trim() ?? "";
      const text = description.length > 0 ? `${title}\n\n${description}` : title;

      const newUlid =
        Date.now().toString(36).toUpperCase() +
        Math.random().toString(36).slice(2, 10).toUpperCase();
      const atomId = `finding:${submissionId}:${newUlid}`;

      const citations: FindingCitation[] = [];
      if (body.data.codeCitation) {
        citations.push({
          kind: "code-section",
          atomId: body.data.codeCitation,
        });
      }
      if (body.data.sourceCitation) {
        citations.push({
          kind: "briefing-source",
          id: body.data.sourceCitation.id,
          label: body.data.sourceCitation.label,
        });
      }

      const now = new Date();
      const [row] = await db
        .insert(findings)
        .values({
          atomId,
          submissionId,
          severity: body.data.severity,
          category: body.data.category,
          status: "ai-produced",
          text,
          citations: citations as unknown as Record<string, unknown>[],
          confidence: "1",
          lowConfidence: false,
          reviewerStatusBy: actor as unknown as Record<string, unknown>,
          reviewerStatusChangedAt: now,
          elementRef: body.data.elementRef ?? null,
          sourceRef:
            (body.data.sourceCitation as unknown as Record<
              string,
              unknown
            > | null) ?? null,
          aiGeneratedAt: now,
        })
        .returning();
      const finalRow = row!;

      // Emit a `finding.generated` event so the per-finding history
      // chain has an origin entry, with the reviewer as the actor —
      // distinguishes manual-add provenance from engine-added rows.
      await emitFindingMutationEvent(
        getHistoryService(),
        {
          finding: finalRow,
          eventType: FINDING_GENERATED_EVENT_TYPE,
          actor,
          payload: {
            findingId: finalRow.id,
            atomId: finalRow.atomId,
            submissionId: finalRow.submissionId,
            severity: finalRow.severity,
            category: finalRow.category,
            confidence: 1,
            source: "human-reviewer",
          },
        },
        reqLog,
      );

      publishSubmissionFindingEvent({
        submissionId: finalRow.submissionId,
        type: "finding.added",
        payload: {
          findingId: finalRow.atomId,
          severity: finalRow.severity,
          category: finalRow.category,
          source: "human-reviewer",
          actor,
        },
      });

      reqLog.info(
        {
          submissionId,
          findingId: finalRow.id,
          atomId: finalRow.atomId,
        },
        "manual finding created",
      );
      res.status(201).json({ finding: toWire(finalRow, null) });
    } catch (err) {
      logger.error(
        { err, submissionId },
        "create manual finding failed",
      );
      res.status(500).json({ error: "Failed to create finding" });
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
 * Locked transitions per Phase 1A (refined post-review for override):
 *   - accept  : ai-produced → accepted; accepted → accepted (refresh)
 *   - reject  : ai-produced → rejected; rejected → rejected (refresh)
 *   - override: any state EXCEPT `overridden` can be overridden. A
 *     finding can only be overridden ONCE; a second override returns
 *     409 `finding_already_overridden`. Reviewers act on the revision
 *     row (status="overridden") via accept/reject just like any other
 *     row — the revision is the new "head" the FE renders.
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
      publishSubmissionFindingEvent({
        submissionId: finalRow.submissionId,
        type: "finding.accepted",
        payload: {
          findingId: finalRow.atomId,
          previousStatus: row.status,
          actor,
        },
      });
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
      publishSubmissionFindingEvent({
        submissionId: finalRow.submissionId,
        type: "finding.rejected",
        payload: {
          findingId: finalRow.atomId,
          previousStatus: row.status,
          actor,
        },
      });
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

      // Single-revision rule: a finding can only be overridden ONCE
      // (Empressa post-review decision — multiple sibling revisions
      // pointing at the same `revision_of` would muddy the audit
      // trail). 409 + a wire-stable error code so clients can
      // surface a "this finding has already been overridden" hint.
      if (original.status === "overridden") {
        reqLog.info(
          { findingId: original.id, atomId: original.atomId },
          "override blocked: row already overridden",
        );
        res.status(409).json({
          error: "finding_already_overridden",
          message:
            "This finding has already been overridden. The original cannot be overridden again.",
        });
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
      publishSubmissionFindingEvent({
        submissionId: original.submissionId,
        type: "finding.overridden",
        payload: {
          findingId: original.atomId,
          revisionAtomId,
          previousStatus: original.status,
          actor,
        },
      });
      res.json({ finding: toWire(revisionRow, original.atomId) });
    } catch (err) {
      logger.error({ err, findingId }, "override finding failed");
      res.status(500).json({ error: "Failed to override finding" });
    }
  },
);

export default router;
