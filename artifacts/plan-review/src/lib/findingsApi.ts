/**
 * Findings — production-surface barrel.
 *
 * Single swap point between the plan-review reviewer UI and the
 * backend. Today it re-exports the in-memory mock implementation
 * from `./findingsMock`; the full swap to the generated React Query
 * hooks in `@workspace/api-client-react` is tracked as a follow-up.
 *
 * Pure ID-shape helpers (`isWellFormedFindingId`,
 * `submissionIdFromFindingId`) deliberately live in `./findingUrl.ts`
 * — they must continue to work after the mock module is deleted.
 */

export type {
  CreateSubmissionFindingPayload,
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
  useAcceptFinding,
  useCreateSubmissionFinding,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  useListSubmissionFindings,
  useListSubmissionFindingsGenerationRuns,
  useOverrideFinding,
  useRejectFinding,
  FindingAlreadyOverriddenError,
  useFindingsGenerationPolling,
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  FINDING_STATUS_LABELS,
  SEVERITY_ORDER,
  compareFindings,
  listSubmissionFindingsKey,
  listSubmissionFindingsRunsKey,
  submissionFindingsStatusKey,
} from "./findingsMock";
