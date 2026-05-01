/**
 * AIR-2 Findings — production-surface barrel.
 *
 * This module is the SINGLE SWAP POINT between the AIR-2 reviewer
 * UI and the AIR-1 backend. Today it re-exports the in-memory mock
 * implementation from `./findingsMock` because AIR-1 (the
 * `finding` atom + `/api/submissions/:id/findings*` endpoints +
 * generated React Query hooks) hasn't landed yet — see Task #341
 * for context. Once AIR-1 ships, this file is the only file that
 * needs to change in the plan-review artifact.
 *
 * AIR-1 swap procedure (when the generated hooks exist):
 *   1. Confirm `pnpm --filter @workspace/api-spec run codegen` has
 *      produced the seven hook names below in
 *      `lib/api-client-react/src/generated/api.ts`. The hook names
 *      here intentionally mirror the planned generated names so the
 *      swap is mechanical.
 *   2. Replace the body of this file with re-exports from
 *      `@workspace/api-client-react` for the hooks and from a small
 *      shared types module for the `Finding*` types + label maps.
 *      See the block at the bottom of this file marked
 *      "AIR-1 SWAP TARGET" for the exact shape.
 *   3. Delete `./findingsMock.ts` and the `__resetFindingsMockForTests`
 *      / `__seedFindingsForTests` / `__peekFindingsForTests` helpers.
 *      Update `components/findings/__tests__/FindingsTab.test.tsx` to
 *      seed via `queryClient.setQueryData(listSubmissionFindingsKey(...), …)`
 *      and assert via `queryClient.getQueryData(...)` (or MSW for
 *      end-to-end coverage).
 *   4. Run `pnpm run typecheck` and the FindingsTab test file. No
 *      other consumer in `artifacts/plan-review/src/` should need to
 *      change — every component already imports from this barrel.
 *
 * NOTE on URL helpers: the pure ID-shape helpers
 * (`isWellFormedFindingId`, `submissionIdFromFindingId`) deliberately
 * live in `./findingUrl.ts`, NOT here. They have no backend coupling
 * and must continue to work after the mock module is deleted.
 */

// ─── Production surface ───────────────────────────────────────────
//
// Everything below is the surface the plan-review components consume.
// Anything that should NOT survive the AIR-1 swap (test seed/peek/reset
// helpers, the deterministic 3-finding fixture, the in-memory store)
// stays in `./findingsMock.ts` and is imported only by the test file.

export type {
  Finding,
  FindingActor,
  FindingCategory,
  FindingCitation,
  FindingCodeCitation,
  FindingRun,
  FindingSeverity,
  FindingSourceCitation,
  FindingStatus,
  OverrideFindingPayload,
} from "./findingsMock";

export {
  // Hook names mirror the AIR-1 generated names exactly.
  useAcceptFinding,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  useListSubmissionFindings,
  useListSubmissionFindingsGenerationRuns,
  useOverrideFinding,
  useRejectFinding,

  // Mock-only polling helper. AIR-1's generated
  // `useGetSubmissionFindingsGenerationStatus` accepts a
  // `refetchInterval` query option that replaces this on swap; until
  // then this collapses to the same idea over the in-memory mock.
  useFindingsGenerationPolling,

  // Pure helpers / label maps — survive the swap into a shared
  // types/labels module under `lib/api-client-react` (or a sibling
  // `lib/findings-ui-labels` package, depending on AIR-1's call).
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  FINDING_STATUS_LABELS,
  SEVERITY_ORDER,
  compareFindings,

  // Query keys are exported so AIR-1-era tests can prime + invalidate
  // the React Query cache directly without touching mock internals.
  listSubmissionFindingsKey,
  listSubmissionFindingsRunsKey,
  submissionFindingsStatusKey,
} from "./findingsMock";

/*
  ─── AIR-1 SWAP TARGET (delete the re-exports above and use this) ──

  export type {
    Finding,
    FindingActor,
    FindingCategory,
    FindingCitation,
    FindingCodeCitation,
    FindingRun,
    FindingSeverity,
    FindingSourceCitation,
    FindingStatus,
    OverrideFindingPayload,
  } from "@workspace/api-client-react";

  export {
    useAcceptFinding,
    useGenerateSubmissionFindings,
    useGetSubmissionFindingsGenerationStatus,
    useListSubmissionFindings,
    useListSubmissionFindingsGenerationRuns,
    useOverrideFinding,
    useRejectFinding,
    // The generated query keys come from orval's emitted module.
    getListSubmissionFindingsQueryKey as listSubmissionFindingsKey,
    getListSubmissionFindingsGenerationRunsQueryKey as listSubmissionFindingsRunsKey,
    getGetSubmissionFindingsGenerationStatusQueryKey as submissionFindingsStatusKey,
  } from "@workspace/api-client-react";

  // The AIR-2 mock's `useFindingsGenerationPolling` collapses into
  // the generated `useGetSubmissionFindingsGenerationStatus`'s
  // `refetchInterval` option — drop it and update the two callers
  // (FindingsTab, FindingsRunsPanel) to pass `{ query:
  // { refetchInterval: (data) => data?.state === "pending" ? 1500 : false } }`
  // instead.

  // The label maps + sort comparator move to a small shared module
  // (`lib/findings-ui-labels` or a `ui-labels.ts` colocated with the
  // generated client) so they keep their single-source-of-truth shape:
  export {
    FINDING_CATEGORY_LABELS,
    FINDING_SEVERITY_LABELS,
    FINDING_STATUS_LABELS,
    SEVERITY_ORDER,
    compareFindings,
  } from "@workspace/findings-ui-labels"; // or wherever AIR-1 lands them
*/
