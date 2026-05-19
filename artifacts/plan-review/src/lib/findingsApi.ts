/**
 * Findings — production-surface barrel.
 *
 * Single point of coupling between the plan-review reviewer UI and
 * the backend. Every hook re-exported here delegates to the generated
 * Orval client (`@workspace/api-client-react`) against the eight
 * `routes/findings.ts` endpoints. The mock-bridge that previously
 * lived in `./findingsMock.ts` has been deleted; consumer signatures
 * (hook arg shapes, return shapes, error envelope) are preserved so
 * the FindingsTab / FindingDrillIn / FindingsRunsPanel /
 * OverrideFindingModal / Compliance Engine surfaces keep their
 * existing call sites unchanged.
 *
 * Wire shapes are re-exported as the consumer-facing local names
 * (`Finding`, `FindingActor`, `FindingRun`, etc.) so the rest of the
 * UI continues to import from `findingsApi` rather than reaching
 * directly into the generated package.
 */

import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  acceptFinding as acceptFindingApi,
  createSubmissionFinding as createSubmissionFindingApi,
  generateSubmissionFindings as generateSubmissionFindingsApi,
  getListSubmissionFindingsQueryKey,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListSubmissionFindingsGenerationRunsQueryKey,
  getSubmissionFindingsGenerationStatus as getSubmissionFindingsGenerationStatusApi,
  listSubmissionFindings as listSubmissionFindingsApi,
  listSubmissionFindingsGenerationRuns as listSubmissionFindingsGenerationRunsApi,
  overrideFinding as overrideFindingApi,
  rejectFinding as rejectFindingApi,
  type Finding as WireFinding,
  type FindingActor as WireFindingActor,
  type FindingCategory as WireFindingCategory,
  type FindingCitation as WireFindingCitation,
  type FindingCodeCitation as WireFindingCodeCitation,
  type FindingSeverity as WireFindingSeverity,
  type FindingSourceCitation as WireFindingSourceCitation,
  type FindingSourceRef as WireFindingSourceRef,
  type FindingStatus as WireFindingStatus,
  type SubmissionFindingsGenerationRun as WireSubmissionFindingsGenerationRun,
} from "@workspace/api-client-react";

// ─── Public types — alias the generated wire shapes so the rest of
//     plan-review keeps importing from `findingsApi` rather than
//     reaching into the generated package directly.

export type Finding = WireFinding;
export type FindingActor = WireFindingActor;
export type FindingCategory = WireFindingCategory;
export type FindingCitation = WireFindingCitation;
export type FindingCodeCitation = WireFindingCodeCitation;
export type FindingSeverity = WireFindingSeverity;
export type FindingSourceCitation = WireFindingSourceCitation;
export type FindingStatus = WireFindingStatus;

/**
 * Per-submission run row. The generated wire type lives behind the
 * `runs[]` envelope on `GET /submissions/:id/findings/runs`; alias it
 * here under the historical local name so the runs panel and
 * submission-detail-modal stay decoupled from the generated package.
 */
export type FindingRun = WireSubmissionFindingsGenerationRun;

/**
 * Manual-add payload. Matches the wire-side `CreateSubmissionFindingBody`
 * shape one-for-one; kept under the historical local name so the
 * FindingsTab manual-add disclosure (and the canned-finding picker
 * that prefills it) continue to compile unchanged.
 */
export interface CreateSubmissionFindingPayload {
  title: string;
  description?: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  codeCitation?: string | null;
  sourceCitation?: WireFindingSourceRef | null;
  elementRef?: string | null;
}

/**
 * Override payload (FE-side composite). The wire-side
 * `OverrideFindingBody` carries `text / severity / category /
 * reviewerComment`; `findingId` lives in the URL path. The local
 * payload bundles the id with the body so the hook can match the mock
 * module's previous calling convention
 * (`override.mutateAsync({ findingId, ... })`).
 */
export interface OverrideFindingPayload {
  findingId: string;
  text: string;
  severity: FindingSeverity;
  category: FindingCategory;
  reviewerComment: string;
}

// ─── Query keys — alias the generated Orval keys under the historical
//     local names. The SSE invalidator and the override-modal refresh
//     both reach for these symbols; pointing them at the generated key
//     means an invalidation actually hits the real cache slot.

export function listSubmissionFindingsKey(submissionId: string): QueryKey {
  return getListSubmissionFindingsQueryKey(submissionId);
}

export function submissionFindingsStatusKey(submissionId: string): QueryKey {
  return getGetSubmissionFindingsGenerationStatusQueryKey(submissionId);
}

export function listSubmissionFindingsRunsKey(
  submissionId: string,
): QueryKey {
  return getListSubmissionFindingsGenerationRunsQueryKey(submissionId);
}

// ─── Labels + sort comparator (pure helpers, no backend coupling).

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

// ─── Error envelope.

/**
 * Structured error thrown by `useOverrideFinding` when the server
 * returns 409 `finding_already_overridden`. The route body carries
 * `{ error, message }` only — `resolvedBy` and `resolvedAt` are
 * resolved from the local query cache so the modal can render an
 * inline attribution block even though the wire shape omits it.
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

const SERVER_ERROR_LABELS: Record<string, string> = {
  invalid_submission_id: "That submission id is not valid.",
  invalid_create_finding_body:
    "Some required fields are missing or invalid. Check the title, severity, and category.",
  submission_not_found: "This submission no longer exists.",
  missing_session_requestor:
    "Your session is missing reviewer attribution. Sign in again and retry.",
  findings_require_internal_audience:
    "Only reviewers can add findings to a submission.",
  "Failed to create finding":
    "The server could not save this finding. Try again in a moment.",
};

export function describeCreateFindingError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data;
    if (data && typeof data === "object") {
      const code = (data as { error?: unknown }).error;
      if (typeof code === "string") {
        return SERVER_ERROR_LABELS[code] ?? code;
      }
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to add finding.";
}

// ─── Hooks.

interface FindingMutateContext {
  submissionId: string;
}

/**
 * List findings for a submission. The generated hook returns
 * `{ findings: Finding[] }`; consumers (FindingsTab, FindingDrillIn,
 * SubmissionDetailModal) read `.data` as `Finding[]`, so unwrap here
 * via the `select` option to preserve the call-site contract.
 */
export function useListSubmissionFindings(
  submissionId: string,
  options?: { query?: Partial<UseQueryOptions<Finding[]>> },
) {
  return useQuery<Finding[]>({
    queryKey: getListSubmissionFindingsQueryKey(submissionId),
    queryFn: async () => {
      const resp = await listSubmissionFindingsApi(submissionId);
      return resp.findings;
    },
    enabled: !!submissionId,
    staleTime: 5_000,
    ...(options?.query ?? {}),
  });
}

/**
 * List recent generation runs for a submission. Wire envelope is
 * `{ runs: FindingRun[] }`; that's exactly what the existing
 * FindingsRunsPanel / FindingsTab auto-failure badge expect, so this
 * wrapper passes the data through unchanged.
 */
export function useListSubmissionFindingsGenerationRuns(
  submissionId: string,
  options?: { query?: Partial<UseQueryOptions<{ runs: FindingRun[] }>> },
) {
  return useQuery<{ runs: FindingRun[] }>({
    queryKey: getListSubmissionFindingsGenerationRunsQueryKey(submissionId),
    queryFn: () => listSubmissionFindingsGenerationRunsApi(submissionId),
    enabled: !!submissionId,
    staleTime: 5_000,
    ...(options?.query ?? {}),
  });
}

/**
 * Status of the most recent run. `idle` is collapsed to `null` so the
 * single existing call surface (re-exported for completeness; current
 * consumers reach for `useFindingsGenerationPolling` instead) keeps
 * the historical "no row → null" semantic.
 */
export function useGetSubmissionFindingsGenerationStatus(
  submissionId: string,
  options?: { query?: Partial<UseQueryOptions<FindingRun | null>> },
) {
  return useQuery<FindingRun | null>({
    queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(submissionId),
    queryFn: async () => {
      const resp = await getSubmissionFindingsGenerationStatusApi(submissionId);
      if (resp.state === "idle" || !resp.generationId || !resp.startedAt) {
        return null;
      }
      return {
        generationId: resp.generationId,
        state: resp.state,
        startedAt: resp.startedAt,
        completedAt: resp.completedAt,
        error: resp.error,
        invalidCitationCount: resp.invalidCitationCount,
        invalidCitations: resp.invalidCitations,
        discardedFindingCount: resp.discardedFindingCount,
      };
    },
    enabled: !!submissionId,
    ...(options?.query ?? {}),
  });
}

/**
 * Kick off a fresh finding-generation run. The route returns 202 +
 * `{ generationId, state: "pending" }`. The mock previously bundled
 * the in-memory polling loop into the same mutation; the real server
 * is fire-and-forget, so callers poll
 * `useFindingsGenerationPolling` (or the runs list) to observe state
 * transitions. Returning `{ generationId }` keeps the consumer
 * contract (`FindingsRunsPanel`, `FindingsEmptyState`,
 * `FindingsAutoFailureBadge`).
 */
export function useGenerateSubmissionFindings(submissionId: string) {
  const qc = useQueryClient();
  return useMutation<{ generationId: string }, unknown, void>({
    mutationFn: async () => {
      const resp = await generateSubmissionFindingsApi(submissionId, {});
      return { generationId: resp.generationId };
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(submissionId),
      });
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsGenerationRunsQueryKey(submissionId),
      });
      // Also invalidate the list — the route is async (202 + pending),
      // so this initial refetch may return the prior set, but it
      // primes React Query so the SSE `finding.added` invalidations
      // can resolve the new rows as the engine emits them. In tests
      // that stub the generate endpoint as synchronously persisting
      // the fixture, this is the trigger that lets the new rows
      // appear on the next render.
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
    },
  });
}

/**
 * Accept a finding. Wire returns `{ finding }`; unwrap so consumers
 * (FindingsTab row + FindingDrillIn) keep using the mutation result
 * as a `Finding` directly.
 */
export function useAcceptFinding(
  submissionId: string,
  options?: UseMutationOptions<
    Finding,
    unknown,
    { findingId: string },
    FindingMutateContext
  >,
) {
  const qc = useQueryClient();
  return useMutation<Finding, unknown, { findingId: string }, FindingMutateContext>({
    mutationFn: async ({ findingId }) => {
      const resp = await acceptFindingApi(findingId);
      return resp.finding;
    },
    ...(options ?? {}),
    onSuccess: (...args) => {
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
      return options?.onSuccess?.(...args);
    },
  });
}

/**
 * Reject a finding. Same wire-shape unwrap as accept.
 */
export function useRejectFinding(
  submissionId: string,
  options?: UseMutationOptions<
    Finding,
    unknown,
    { findingId: string },
    FindingMutateContext
  >,
) {
  const qc = useQueryClient();
  return useMutation<Finding, unknown, { findingId: string }, FindingMutateContext>({
    mutationFn: async ({ findingId }) => {
      const resp = await rejectFindingApi(findingId);
      return resp.finding;
    },
    ...(options ?? {}),
    onSuccess: (...args) => {
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
      return options?.onSuccess?.(...args);
    },
  });
}

/**
 * Override a finding. Maps the consumer-facing payload (which carries
 * `findingId` alongside the body fields) onto the wire's split URL-
 * path / JSON-body shape. On 409 `finding_already_overridden` the
 * thrown `ApiError` is translated into `FindingAlreadyOverriddenError`
 * with `resolvedBy` / `resolvedAt` lifted from the local list cache —
 * the server's 409 envelope only carries `{error, message}`, so the
 * cache is the only client-side source for attribution.
 */
export function useOverrideFinding(
  submissionId: string,
  options?: UseMutationOptions<
    Finding,
    unknown,
    OverrideFindingPayload,
    FindingMutateContext
  >,
) {
  const qc = useQueryClient();
  return useMutation<Finding, unknown, OverrideFindingPayload, FindingMutateContext>({
    mutationFn: async (payload) => {
      try {
        const resp = await overrideFindingApi(payload.findingId, {
          text: payload.text,
          severity: payload.severity,
          category: payload.category,
          reviewerComment: payload.reviewerComment,
        });
        return resp.finding;
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          err.data &&
          typeof err.data === "object" &&
          (err.data as { error?: unknown }).error === "finding_already_overridden"
        ) {
          const cached = qc.getQueryData<Finding[]>(
            getListSubmissionFindingsQueryKey(submissionId),
          );
          const row = cached?.find((f) => f.id === payload.findingId) ?? null;
          throw new FindingAlreadyOverriddenError({
            message: (err.data as { message?: string }).message,
            resolvedBy: row?.reviewerStatusBy ?? null,
            resolvedAt: row?.reviewerStatusChangedAt ?? null,
          });
        }
        throw err;
      }
    },
    ...(options ?? {}),
    onSuccess: (...args) => {
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
      return options?.onSuccess?.(...args);
    },
  });
}

/**
 * Manual-add hook. POSTs the structured payload to
 * `POST /api/submissions/:id/findings`, invalidates the list query so
 * the new row materializes on the next refetch, and surfaces errors
 * through the generated `ApiError` (mapped to user-facing strings by
 * `describeCreateFindingError`).
 */
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
      const resp = await createSubmissionFindingApi(submissionId, {
        title,
        description: description.length > 0 ? description : null,
        severity: payload.severity,
        category: payload.category,
        codeCitation: payload.codeCitation ?? null,
        sourceCitation: payload.sourceCitation ?? null,
        elementRef: payload.elementRef ?? null,
      });
      return resp.finding;
    },
    ...(options ?? {}),
    onSuccess: (...args) => {
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
      return options?.onSuccess?.(...args);
    },
  });
}

/**
 * Thin polling helper used by the runs panel + auto-failure badge +
 * empty-state CTA to flip into a "Generating…" state while a run is
 * in flight. Wraps the status endpoint with a short `refetchInterval`
 * while `enabled` is true; returns `null` when no run exists or the
 * row is `idle`. The previous mock implementation polled the in-
 * memory store every 250ms; 1s against the real endpoint is fast
 * enough for the visual state to stay tight without hammering the
 * server, and the runs landed-row arrives on the next list-query
 * refetch in any case.
 */
export function useFindingsGenerationPolling(
  submissionId: string,
  enabled: boolean,
  intervalMs = 1_000,
): FindingRun | null {
  const [snap, setSnap] = useState<FindingRun | null>(null);
  useEffect(() => {
    if (!enabled || !submissionId) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = await getSubmissionFindingsGenerationStatusApi(submissionId);
        if (cancelled) return;
        if (resp.state === "idle" || !resp.generationId || !resp.startedAt) {
          setSnap(null);
          return;
        }
        setSnap({
          generationId: resp.generationId,
          state: resp.state,
          startedAt: resp.startedAt,
          completedAt: resp.completedAt,
          error: resp.error,
          invalidCitationCount: resp.invalidCitationCount,
          invalidCitations: resp.invalidCitations,
          discardedFindingCount: resp.discardedFindingCount,
        });
      } catch {
        // Transient failures shouldn't break the polling loop; the
        // next tick (or the manual list refetch) will catch up.
      }
    };
    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [submissionId, enabled, intervalMs]);
  return snap;
}
