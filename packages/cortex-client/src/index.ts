export { createCortexClient, CortexApiError } from './client'
export type { CortexClient, CortexClientConfig } from './client'
// Tile capability registry — React-free, serializable single source of truth.
export { TILE_CAPABILITIES, TILE_CAPABILITY_BY_ID } from './tileCapabilities'
export type {
  TileCapability,
  TileCapabilityStatus,
  TileCapabilityCategory,
} from './tileCapabilities'
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
  GeocodeResult,
  PrecedenceResultWire,
  ComplianceRunResult,
  TileDefWire,
  DocumentUploadUrl,
  DocumentUploadComplete,
  EngagementSubmissionCreated,
  EngagementSubmissionSummary,
  SubmissionFindingsStatus,
  EngagementDocument,
  DataroomAtomChip,
  DataroomIngestResult,
  AssertedConfidence,
} from './types'
