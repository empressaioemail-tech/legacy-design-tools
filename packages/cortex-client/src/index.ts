export { createCortexClient, CortexApiError } from './client'
export type { CortexClient, CortexClientConfig } from './client'
// Response types — Track C
export type * from './types'
// Explicit re-exports of the key wire types (convenience for consumers).
export type {
  QueueRow,
  Engagement,
  EngagementDetail,
  ReportResult,
  ReportStatus,
  Finding,
  SubmissionFindings,
  LetterDraft,
  LetterDocument,
  Sheet,
  ResponseTask,
  IntakeParseResult,
  PrecedenceResultWire,
  ComplianceRunResult,
  TileDefWire,
  DocumentUploadUrl,
  DocumentUploadComplete,
  EngagementSubmissionCreated,
  EngagementSubmissionSummary,
  SubmissionFindingsStatus,
} from './types'
