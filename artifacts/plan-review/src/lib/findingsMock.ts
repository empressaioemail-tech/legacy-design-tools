/**
 * AIR-2 Findings — CLIENT-SIDE MOCK MODULE (legacy).
 *
 * Production code MUST NOT import from this module directly — it
 * imports from `./findingsApi` instead. That barrel is the single
 * swap point for the AIR-1 backend wiring (see `./findingsApi.ts`
 * top-of-file comment for the full procedure and the follow-up for
 * context).
 *
 * What still lives here:
 *   - The mock hook implementations (re-exported through
 *     `findingsApi`).
 *   - The deterministic 3-finding fixture used by the mock
 *     `useGenerateSubmissionFindings` mutation.
 *   - Test-only seed / reset / peek helpers
 *     (`__seedFindingsForTests`, `__resetFindingsMockForTests`,
 *     `__peekFindingsForTests`) — these are imported by
 *     `FindingsTab.test.tsx` and DO NOT survive the AIR-1 swap.
 *
 * What moved out:
 *   - Pure URL atom-id allow-list helpers
 *     (`isWellFormedFindingId`, `submissionIdFromFindingId`) now live
 *     in `./findingUrl.ts` because they have no backend coupling and
 *     must outlive this module.
 *
 * `generateSubmissionFindings()` always yields the same three-
 * finding fixture (1 blocker / 1 concern / 1 advisory) so component
 * + e2e tests stay deterministic.
 */
import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

// ─── Types (mirror AIR-1's planned generated shapes) ───────────────

export type FindingSeverity = "blocker" | "concern" | "advisory";

/**
 * FIXED v1 category enum (per AIR-1 recon, FINAL for the AIR push).
 * Adding categories is an event-modeled schema change, not a silent
 * extension — keep this list in lock-step with AIR-1's definition.
 */
export type FindingCategory =
  | "setback"
  | "height"
  | "coverage"
  | "egress"
  | "use"
  | "overlay-conflict"
  | "divergence-related"
  | "other";

export type FindingStatus =
  | "ai-produced"
  | "accepted"
  | "rejected"
  | "overridden"
  | "promoted-to-architect";

export interface FindingCodeCitation {
  kind: "code-section";
  atomId: string;
}
export interface FindingSourceCitation {
  kind: "briefing-source";
  id: string;
  label: string;
}
export type FindingCitation = FindingCodeCitation | FindingSourceCitation;

export interface FindingActor {
  kind: "user" | "agent" | "system";
  id: string;
  displayName?: string | null;
}

export interface Finding {
  /** Atom id: `finding:{submissionId}:{ulid}`. */
  id: string;
  submissionId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  text: string;
  citations: FindingCitation[];
  confidence: number;
  lowConfidence: boolean;
  status: FindingStatus;
  reviewerStatusBy: FindingActor | null;
  reviewerStatusChangedAt: string | null;
  reviewerComment: string | null;
  /** Optional pointer at the offending bim-model element. */
  elementRef: string | null;
  /** Optional pointer at the backing briefing source. */
  sourceRef: { id: string; label: string } | null;
  aiGeneratedAt: string;
  /** When this is an overridden revision, the original AI finding's id. */
  revisionOf: string | null;
  /**
   * PLR-v2 Track 1 — true iff this row was produced by the AI
   * compliance-checker engine (vs. authored by a reviewer or an
   * override revision). Optional in Pass A; legacy rows that
   * predate the column read as undefined and the FE defaults to
   * AI-generated since the reviewer-authored bucket was empty
   * before Track 1 landed.
   */
  aiGenerated?: boolean;
  /** PLR-v2 Track 1 — reviewer who accepted the AI finding. Null when not yet accepted. */
  acceptedByReviewerId?: string | null;
  acceptedAt?: string | null;
  /** Actor envelope for the accepting reviewer; carries displayName so the badge renders without a per-row user fetch. */
  acceptedBy?: FindingActor | null;
}

export interface FindingRun {
  generationId: string;
  state: "pending" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  invalidCitationCount: number;
  discardedFindingCount: number;
}

// ─── In-memory store ──────────────────────────────────────────────

const findingsBySubmission = new Map<string, Finding[]>();
const runsBySubmission = new Map<string, FindingRun[]>();

/**
 * Bridge for the partial-swap state in `findingsApi.ts`: the manual-
 * add hook now POSTs through the real backend, but the list hook
 * still reads from this in-memory map. Pushing the server-returned
 * row in here lets the existing list query refetch render the new
 * finding without a manual reload. Will be deleted when
 * `useListSubmissionFindings` itself is swapped to the generated
 * GET hook.
 */
export function mockUpsertFinding(submissionId: string, finding: Finding): void {
  const prior = findingsBySubmission.get(submissionId) ?? [];
  const filtered = prior.filter((f) => f.id !== finding.id);
  findingsBySubmission.set(submissionId, [finding, ...filtered]);
}

function makeUlid(): string {
  // Crockford-base32-ish stub. The real AIR-1 ulid format is fine
  // here — we only need uniqueness + a stable shape for the
  // `finding:{submissionId}:{ulid}` atom id.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`.toUpperCase().slice(0, 26);
}

function findingId(submissionId: string): string {
  return `finding:${submissionId}:${makeUlid()}`;
}

function generationId(): string {
  return `frun_${makeUlid().toLowerCase().slice(0, 16)}`;
}

/**
 * Deterministic three-finding fixture (1 blocker / 1 concern / 1
 * advisory) per AIR-1's mock-mode contract. Citation atom ids are
 * stable strings so the URL deep-link tests and the screenshot
 * captures always render the same labels.
 */
function buildFixtureFindings(submissionId: string): Finding[] {
  const now = new Date().toISOString();
  return [
    {
      id: findingId(submissionId),
      submissionId,
      severity: "blocker",
      category: "setback",
      text:
        "North side-yard setback is 3'-2\" — the applicable Bastrop UDC standard requires a 5'-0\" minimum. " +
        "The proposed envelope projects 1'-10\" into the required setback at the second floor. " +
        "See [[CODE:bastrop-udc-4-3-2-b]] for the dimensional rule and " +
        "{{atom|briefing-source|src-bastrop-udc-2024|Bastrop UDC §4.3.2}} for the source provision.",
      citations: [
        { kind: "code-section", atomId: "bastrop-udc-4-3-2-b" },
        {
          kind: "briefing-source",
          id: "src-bastrop-udc-2024",
          label: "Bastrop UDC §4.3.2",
        },
      ],
      confidence: 0.92,
      lowConfidence: false,
      status: "ai-produced",
      reviewerStatusBy: null,
      reviewerStatusChangedAt: null,
      reviewerComment: null,
      elementRef: "wall:north-side-l2",
      sourceRef: {
        id: "src-bastrop-udc-2024",
        label: "Bastrop UDC §4.3.2",
      },
      aiGeneratedAt: now,
      revisionOf: null,
    },
    {
      id: findingId(submissionId),
      submissionId,
      severity: "concern",
      category: "egress",
      text:
        "Bedroom 2's egress window net clear opening appears to be 4.8 sqft. " +
        "IRC §R310.2.1 requires a minimum of 5.7 sqft for grade-floor openings " +
        "([[CODE:irc-r310-2-1]]). Confirm sill height and window schedule.",
      citations: [{ kind: "code-section", atomId: "irc-r310-2-1" }],
      confidence: 0.55,
      lowConfidence: true,
      status: "ai-produced",
      reviewerStatusBy: null,
      reviewerStatusChangedAt: null,
      reviewerComment: null,
      elementRef: "window:bedroom-2-egress",
      sourceRef: null,
      aiGeneratedAt: now,
      revisionOf: null,
    },
    {
      id: findingId(submissionId),
      submissionId,
      severity: "advisory",
      category: "other",
      text:
        "Plant schedule on L1.00 lists 6 street trees but the planting plan shows 8. " +
        "Reconcile counts before final submission. See [[CODE:bastrop-udc-6-7-1]].",
      citations: [{ kind: "code-section", atomId: "bastrop-udc-6-7-1" }],
      confidence: 0.78,
      lowConfidence: false,
      status: "ai-produced",
      reviewerStatusBy: null,
      reviewerStatusChangedAt: null,
      reviewerComment: null,
      elementRef: null,
      sourceRef: null,
      aiGeneratedAt: now,
      revisionOf: null,
    },
  ];
}

// ─── Query keys ───────────────────────────────────────────────────

export function listSubmissionFindingsKey(submissionId: string): readonly unknown[] {
  return ["findings", submissionId, "list"];
}
export function submissionFindingsStatusKey(submissionId: string): readonly unknown[] {
  return ["findings", submissionId, "status"];
}
export function listSubmissionFindingsRunsKey(
  submissionId: string,
): readonly unknown[] {
  return ["findings", submissionId, "runs"];
}

// ─── Hooks (mock-only; signatures mirror AIR-1's planned hooks) ───

export function useListSubmissionFindings(
  submissionId: string,
  options?: { query?: Partial<UseQueryOptions<Finding[]>> },
) {
  return useQuery<Finding[]>({
    queryKey: listSubmissionFindingsKey(submissionId),
    queryFn: async () => findingsBySubmission.get(submissionId) ?? [],
    enabled: !!submissionId,
    staleTime: 5_000,
    ...(options?.query ?? {}),
  });
}

export function useListSubmissionFindingsGenerationRuns(
  submissionId: string,
  options?: { query?: Partial<UseQueryOptions<{ runs: FindingRun[] }>> },
) {
  return useQuery<{ runs: FindingRun[] }>({
    queryKey: listSubmissionFindingsRunsKey(submissionId),
    queryFn: async () => ({
      runs: runsBySubmission.get(submissionId) ?? [],
    }),
    enabled: !!submissionId,
    staleTime: 5_000,
    ...(options?.query ?? {}),
  });
}

export function useGetSubmissionFindingsGenerationStatus(
  submissionId: string,
  options?: { query?: Partial<UseQueryOptions<FindingRun | null>> },
) {
  return useQuery<FindingRun | null>({
    queryKey: submissionFindingsStatusKey(submissionId),
    queryFn: async () => {
      const runs = runsBySubmission.get(submissionId) ?? [];
      return runs[0] ?? null;
    },
    enabled: !!submissionId,
    ...(options?.query ?? {}),
  });
}

/**
 * Generation kickoff. Mirrors AIR-1 mock mode:
 *   - inserts a `pending` run row
 *   - resolves the run after a short delay with the deterministic
 *     three-finding fixture
 *   - flips the run row to `completed` and sets findings on the
 *     submission so the list query refetches with the new set.
 */
export function useGenerateSubmissionFindings(submissionId: string) {
  const qc = useQueryClient();
  return useMutation<{ generationId: string }>({
    mutationFn: async () => {
      const id = generationId();
      const startedAt = new Date().toISOString();
      const pending: FindingRun = {
        generationId: id,
        state: "pending",
        startedAt,
        completedAt: null,
        error: null,
        invalidCitationCount: 0,
        discardedFindingCount: 0,
      };
      const prior = runsBySubmission.get(submissionId) ?? [];
      runsBySubmission.set(submissionId, [pending, ...prior]);
      qc.invalidateQueries({ queryKey: submissionFindingsStatusKey(submissionId) });
      qc.invalidateQueries({ queryKey: listSubmissionFindingsRunsKey(submissionId) });

      // Simulate the async generation. Real AIR-1 uses a fire-and-
      // forget worker + status polling; the mock collapses both
      // into a single delayed promise so component tests can drive
      // it via `vi.useFakeTimers()` or just await the mutation.
      await new Promise((r) => setTimeout(r, 400));

      const completedAt = new Date().toISOString();
      const findings = buildFixtureFindings(submissionId);
      findingsBySubmission.set(submissionId, findings);
      const completed: FindingRun = {
        ...pending,
        state: "completed",
        completedAt,
        invalidCitationCount: 0,
        discardedFindingCount: 0,
      };
      const next = [completed, ...prior];
      runsBySubmission.set(submissionId, next);

      qc.invalidateQueries({ queryKey: listSubmissionFindingsKey(submissionId) });
      qc.invalidateQueries({ queryKey: submissionFindingsStatusKey(submissionId) });
      qc.invalidateQueries({ queryKey: listSubmissionFindingsRunsKey(submissionId) });
      return { generationId: id };
    },
  });
}

interface FindingMutateContext {
  submissionId: string;
}

function updateFinding(
  submissionId: string,
  findingIdToUpdate: string,
  updater: (f: Finding) => Finding | Finding[],
): void {
  const list = findingsBySubmission.get(submissionId) ?? [];
  const next: Finding[] = [];
  for (const f of list) {
    if (f.id === findingIdToUpdate) {
      const result = updater(f);
      if (Array.isArray(result)) next.push(...result);
      else next.push(result);
    } else {
      next.push(f);
    }
  }
  findingsBySubmission.set(submissionId, next);
}

export function useAcceptFinding(
  submissionId: string,
  options?: UseMutationOptions<Finding, unknown, { findingId: string }, FindingMutateContext>,
) {
  const qc = useQueryClient();
  return useMutation<Finding, unknown, { findingId: string }, FindingMutateContext>({
    mutationFn: async ({ findingId: fid }) => {
      let updated: Finding | null = null;
      updateFinding(submissionId, fid, (f) => {
        updated = {
          ...f,
          status: "accepted",
          reviewerStatusBy: { kind: "user", id: "reviewer-current", displayName: "Reviewer" },
          reviewerStatusChangedAt: new Date().toISOString(),
        };
        return updated;
      });
      qc.invalidateQueries({ queryKey: listSubmissionFindingsKey(submissionId) });
      if (!updated) throw new Error("Finding not found");
      return updated;
    },
    ...(options ?? {}),
  });
}

export function useRejectFinding(
  submissionId: string,
  options?: UseMutationOptions<Finding, unknown, { findingId: string }, FindingMutateContext>,
) {
  const qc = useQueryClient();
  return useMutation<Finding, unknown, { findingId: string }, FindingMutateContext>({
    mutationFn: async ({ findingId: fid }) => {
      let updated: Finding | null = null;
      updateFinding(submissionId, fid, (f) => {
        updated = {
          ...f,
          status: "rejected",
          reviewerStatusBy: { kind: "user", id: "reviewer-current", displayName: "Reviewer" },
          reviewerStatusChangedAt: new Date().toISOString(),
        };
        return updated;
      });
      qc.invalidateQueries({ queryKey: listSubmissionFindingsKey(submissionId) });
      if (!updated) throw new Error("Finding not found");
      return updated;
    },
    ...(options ?? {}),
  });
}

export interface OverrideFindingPayload {
  findingId: string;
  text: string;
  severity: FindingSeverity;
  category: FindingCategory;
  reviewerComment: string;
}

/**
 * Structured error thrown by `useOverrideFinding` when the targeted
 * finding has already been overridden. Mirrors the server's 409
 * envelope (`finding_already_overridden`) so the FE can render an
 * inline conflict note with attribution and a refresh affordance
 * instead of a generic toast.
 */
export class FindingAlreadyOverriddenError extends Error {
  readonly code = "finding_already_overridden" as const;
  readonly status = 409 as const;
  readonly resolvedBy: FindingActor | null;
  readonly resolvedAt: string | null;
  constructor(args: {
    message?: string;
    resolvedBy: FindingActor | null;
    resolvedAt: string | null;
  }) {
    super(
      args.message ??
        "This finding has already been overridden. The original cannot be overridden again.",
    );
    this.name = "FindingAlreadyOverriddenError";
    this.resolvedBy = args.resolvedBy;
    this.resolvedAt = args.resolvedAt;
  }
}

/**
 * Override creates a NEW finding atom (cid changes / new id) with
 * `revisionOf` pointing back at the original AI finding. The
 * original is preserved in-place with status="overridden" so the
 * drill-in's "See AI's original" affordance can still surface it
 * for audit. Mirrors AIR-1's planned override semantics.
 *
 * Single-revision rule: a finding can only be overridden ONCE. A
 * second attempt throws {@link FindingAlreadyOverriddenError} so the
 * FE can render an inline 409 message rather than swallowing the
 * conflict.
 */
export function useOverrideFinding(
  submissionId: string,
  options?: UseMutationOptions<Finding, unknown, OverrideFindingPayload, FindingMutateContext>,
) {
  const qc = useQueryClient();
  return useMutation<Finding, unknown, OverrideFindingPayload, FindingMutateContext>({
    mutationFn: async (payload) => {
      const now = new Date().toISOString();
      // 409 check before any write — mirror the server's behavior.
      const list = findingsBySubmission.get(submissionId) ?? [];
      const target = list.find((f) => f.id === payload.findingId);
      if (target && target.status === "overridden") {
        throw new FindingAlreadyOverriddenError({
          resolvedBy: target.reviewerStatusBy,
          resolvedAt: target.reviewerStatusChangedAt,
        });
      }
      let revision: Finding | null = null;
      updateFinding(submissionId, payload.findingId, (original) => {
        const supersededOriginal: Finding = {
          ...original,
          status: "overridden",
          reviewerStatusBy: { kind: "user", id: "reviewer-current", displayName: "Reviewer" },
          reviewerStatusChangedAt: now,
        };
        revision = {
          ...original,
          id: findingId(submissionId),
          severity: payload.severity,
          category: payload.category,
          text: payload.text,
          status: "overridden",
          reviewerStatusBy: { kind: "user", id: "reviewer-current", displayName: "Reviewer" },
          reviewerStatusChangedAt: now,
          reviewerComment: payload.reviewerComment || null,
          revisionOf: original.id,
          aiGeneratedAt: original.aiGeneratedAt,
        };
        return [supersededOriginal, revision];
      });
      qc.invalidateQueries({ queryKey: listSubmissionFindingsKey(submissionId) });
      if (!revision) throw new Error("Finding not found");
      return revision;
    },
    ...(options ?? {}),
  });
}

/**
 * Manual-add payload. Mirrors the wire of
 * `POST /api/submissions/:id/findings`. The server composes the
 * persisted `text` body as `title` + blank line + `description` when
 * a description is provided, so callers should send the headline as
 * `title` and any longer narrative as `description`.
 */
export interface CreateSubmissionFindingPayload {
  title: string;
  description?: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  codeCitation?: string | null;
  sourceCitation?: { id: string; label: string } | null;
  elementRef?: string | null;
}

export function useCreateSubmissionFinding(
  submissionId: string,
  options?: UseMutationOptions<
    Finding,
    unknown,
    CreateSubmissionFindingPayload,
    FindingMutateContext
  >,
) {
  const qc = useQueryClient();
  return useMutation<
    Finding,
    unknown,
    CreateSubmissionFindingPayload,
    FindingMutateContext
  >({
    mutationFn: async (payload) => {
      const title = payload.title.trim();
      if (!title) throw new Error("Title is required.");
      const description = payload.description?.trim() ?? "";
      const text = description ? `${title}\n\n${description}` : title;
      const now = new Date().toISOString();
      const citations: FindingCitation[] = [];
      if (payload.codeCitation) {
        citations.push({ kind: "code-section", atomId: payload.codeCitation });
      }
      if (payload.sourceCitation) {
        citations.push({
          kind: "briefing-source",
          id: payload.sourceCitation.id,
          label: payload.sourceCitation.label,
        });
      }
      const created: Finding = {
        id: findingId(submissionId),
        submissionId,
        severity: payload.severity,
        category: payload.category,
        status: "ai-produced",
        text,
        citations,
        confidence: 1,
        lowConfidence: false,
        reviewerStatusBy: {
          kind: "user",
          id: "reviewer-current",
          displayName: "Reviewer",
        },
        reviewerStatusChangedAt: now,
        reviewerComment: null,
        elementRef: payload.elementRef ?? null,
        sourceRef: payload.sourceCitation ?? null,
        aiGeneratedAt: now,
        revisionOf: null,
      };
      const prior = findingsBySubmission.get(submissionId) ?? [];
      findingsBySubmission.set(submissionId, [created, ...prior]);
      qc.invalidateQueries({ queryKey: listSubmissionFindingsKey(submissionId) });
      return created;
    },
    ...(options ?? {}),
  });
}

/**
 * Test/dev hook to reset the in-memory store between tests. Real
 * AIR-1 will not need this — it's purely a side-effect of the mock
 * persisting state in module-level Maps.
 */
export function __resetFindingsMockForTests(): void {
  findingsBySubmission.clear();
  runsBySubmission.clear();
}

/**
 * Test/dev hook to seed findings for a submission without going
 * through the generation flow — useful for component tests that
 * just want to render the populated state.
 */
export function __seedFindingsForTests(
  submissionId: string,
  findings: Finding[],
): void {
  findingsBySubmission.set(submissionId, findings);
}

/**
 * Test/dev hook to seed finding runs (e.g. a `failed` row produced
 * by the auto-trigger added in Task #447) without going through the
 * generation flow. Inserted newest-first to match the ordering the
 * `/findings/runs` endpoint returns.
 */
export function __seedRunsForTests(
  submissionId: string,
  runs: FindingRun[],
): void {
  runsBySubmission.set(submissionId, runs);
}

/**
 * Test-only synchronous accessor (the React Query layer caches a
 * snapshot but we want the live store for assertions about
 * reviewer-status mutations).
 */
export function __peekFindingsForTests(submissionId: string): Finding[] {
  return findingsBySubmission.get(submissionId) ?? [];
}

/**
 * Helper used by FindingsTab to render the friendly category label
 * without coupling each call site to the enum spelling.
 */
export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  setback: "Setback",
  height: "Height",
  coverage: "Coverage",
  egress: "Egress",
  use: "Use",
  "overlay-conflict": "Overlay conflict",
  "divergence-related": "Divergence-related",
  other: "Other",
};

export const FINDING_SEVERITY_LABELS: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  "ai-produced": "AI-produced",
  accepted: "Accepted",
  rejected: "Rejected",
  overridden: "Overridden",
  "promoted-to-architect": "Promoted",
};

/**
 * Sort comparator: severity ↓ then aiGeneratedAt ↓. Severity order
 * matches the FindingsTab grouping (blocker > concern > advisory).
 */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  concern: 1,
  advisory: 2,
};

export function compareFindings(a: Finding, b: Finding): number {
  const sa = SEVERITY_ORDER[a.severity];
  const sb = SEVERITY_ORDER[b.severity];
  if (sa !== sb) return sa - sb;
  return b.aiGeneratedAt.localeCompare(a.aiGeneratedAt);
}

/**
 * Tiny client-side polling helper used by FindingsTab to flip the
 * "Generate" button into a polling-pill state while the run is
 * pending. Real AIR-1 will use the generated React Query
 * `useGetSubmissionFindingsGenerationStatus` with a `refetchInterval`
 * — this hook collapses to the same idea over the in-memory mock.
 */
export function useFindingsGenerationPolling(
  submissionId: string,
  enabled: boolean,
  intervalMs = 250,
): FindingRun | null {
  const [snap, setSnap] = useState<FindingRun | null>(() => {
    const runs = runsBySubmission.get(submissionId) ?? [];
    return runs[0] ?? null;
  });
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const runs = runsBySubmission.get(submissionId) ?? [];
      setSnap(runs[0] ?? null);
    };
    tick();
    const handle = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(handle);
  }, [submissionId, enabled, intervalMs]);
  return snap;
}
