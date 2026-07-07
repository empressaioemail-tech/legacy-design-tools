// Plan-review BFF response types.
//
// PURE TYPE MODULE — no runtime, no React, no imports from the app.
// Derived from the actual app wire shapes:
//   - artifacts/codex-reviewer-qa/src/lib/planReviewBff.ts (thin BFF client)
//   - packages/tile-shell/src/types.ts (EngagementDetail / PrecedenceResultWire)
//   - artifacts/api-server/src/routes/planReviewBff.ts (res.json() sites)
//
// Deviations from the idealized dispatch shapes are noted inline.

// ─── Queue ───────────────────────────────────────────────────────
// Matches the app's EngagementQueueItem (tile-shell/types.ts) and the
// api-server GET /queue res.json() rows exactly.
export type QueueRow = {
  id: string
  engagementId: string
  engagementName: string
  status: string
  reportRunState: string | null
  openFindingCount: number
  daysInQueue: number
}

// Reviewer-scoped engagement listing (GET /plan-review/reviewer/engagements).
export type ReviewerEngagementRow = {
  id: string
  name: string
  address: string | null
  jurisdiction: string | null
  status: string
  submissionCount: number
  updatedAt: string
}

// ─── Reports ─────────────────────────────────────────────────────
// The api-server GET /engagements/:id/reports/:type emits these statuses:
//   ok | running | not-run | error | unavailable
// (verified in artifacts/api-server/src/routes/planReviewBff.ts and
//  artifacts/api-server/src/lib/planReviewLayerRun.ts).
// `degraded` + `degradedReason` are included for forward-compat with the
// wider Cortex report surface (admin/functions uses "degraded" tile status);
// the plan-review report routes do NOT currently emit them. Noted deviation.
export type ReportStatus =
  | 'ok'
  | 'degraded'
  | 'error'
  | 'running'
  | 'not-run'
  | 'unavailable'

export type ReportResult<T = unknown> = {
  status: ReportStatus
  result?: T
  error?: string
  degradedReason?: string
  generationId?: string
}

// ─── Engagement ──────────────────────────────────────────────────
// Matches api-server GET /engagements/:id res.json() and tile-shell
// EngagementDetail. `reportResults` keyed by report type → ReportResult.
export type Engagement = {
  id: string
  name: string
  jurisdiction: string | null
  address: string | null
  apn: string | null
  applicantName: string | null
  latitude: number | null
  longitude: number | null
  reportResults: Record<string, ReportResult>
}

// Alias — the app and dispatch both use "EngagementDetail" for the same shape.
export type EngagementDetail = Engagement

// ─── Findings ────────────────────────────────────────────────────
// NOTE / DEVIATION: The dispatch's idealized Finding shape (findingId,
// codeSection, description, determination, confidence{value,kind},
// citationIds, status:'open'|'accepted'|'rejected'|'edited') does NOT match
// the app. The api-server exposes findings only through opaque
// `listSubmissionFindingsWire` (findings: unknown[]) and patchFinding returns
// `unknown`. The DB finding row uses status values
// 'accepted' | 'overridden' (with revisionOf) — not the idealized union.
// Rather than invent fields the wire does not carry, Finding is typed to the
// shape the app can actually assert, with confidence inlined (no hard
// @hauska/atom-contract runtime dep). Consumers that need the raw wire use
// SubmissionFindings (opaque) below.
export type FindingDetermination = 'pass' | 'fail' | 'advisory'
export type FindingConfidenceKind = 'calibrated' | 'asserted' | 'deterministic'
export type FindingStatus = 'open' | 'accepted' | 'rejected' | 'edited'

export type FindingConfidence = {
  value: number
  kind: FindingConfidenceKind
}

export type Finding = {
  findingId: string
  codeSection: string
  description: string
  determination: FindingDetermination
  confidence: FindingConfidence
  citationIds: string[]
  status: FindingStatus
}

// The wire actually returned by GET /submissions/:id/findings — opaque array
// (api-server returns `{ findings: unknown[] }`).
export type SubmissionFindings = {
  findings: unknown[]
}

// ─── Letters ─────────────────────────────────────────────────────
// RECONCILIATION: the app defines TWO different LetterDraft shapes.
//  1. planReviewBff.ts fetchEngagementLetter/generateEngagementLetter return
//     { draft: string | null; generatedAt: string | null }  → LetterDraft
//     (this is what the api-server GET/POST .../letter actually emits).
//  2. planReviewBff.ts `export type LetterDraft` used by draftLetter() is
//     { letterId; sections[] } → renamed here to LetterDocument to remove the
//     name collision.
// The typed CortexClient.getLetter/generateLetter methods use LetterDraft (#1),
// matching the live api-server routes.
export type LetterDraft = {
  draft: string | null
  generatedAt: string | null
}

export type LetterDocument = {
  letterId: string
  sections: Array<{ kind: string; heading: string; content: string }>
}

// ─── Sheets ──────────────────────────────────────────────────────
// From PlanReviewSheetWire (planReviewBff.ts) — matches api-server
// GET /engagements/:id/sheets res.json().sheets[].
export type Sheet = {
  sheetId: string
  label: string
  pageNumber: string
  snapshotId: string
  thumbnailUrl: string
  contentBody: string | null
  crossRefs: unknown[]
  createdAt: string
}

// ─── Response tasks ──────────────────────────────────────────────
// From PlanReviewResponseTaskWire (planReviewBff.ts). NOTE: the api-server
// actually serializes the richer ResponseTaskAtomInstance (from
// @workspace/atoms-l-surface), of which this is the browser-facing subset the
// app types against. Kept to the app-facing subset to avoid an atom-contract
// dependency; extra fields on the wire are ignored by consumers.
export type ResponseTask = {
  entityId: string
  title: string
  description: string
  state: 'open' | 'in-progress' | 'done' | 'cancelled'
  findingId: string | null
  engagementId: string
}

// ─── Geocode ─────────────────────────────────────────────────────
// From the plan-review BFF POST /geocode route (wraps resolvePlace). Drives the
// shell top-bar address-search box → shared active-parcel context.
export type GeocodeResult = {
  placeKey: string
  apn: string | null
  jurisdiction: string | null
  address: string | null
  lat: number
  lng: number
  city: string | null
  state: string | null
  confidence: 'high' | 'coordinates' | 'low'
}

// ─── Intake ──────────────────────────────────────────────────────
// Matches IntakeParseResult (tile-shell/types.ts app-only type) and the
// api-server POST /intake res.json() elements.
export type IntakeParseResult = {
  projectName: string
  address: string
  jurisdiction: string
  projectType: string
  clientName: string
  clientEmail: string
  clientNotes: string
  unverifiedFields: string[]
  sources: Array<{ kind: string; label: string }>
}

// ─── Precedence / compliance ─────────────────────────────────────
// From tile-shell PrecedenceResultWire + api-server compliance-run res.json().
export type PrecedenceResultWire = {
  topic: string
  ruleApplied: string
  governingAtomId: string
  comparedAtomIds: string[]
}

export type ComplianceRunResult = {
  generationId: string
  precedenceResult?: PrecedenceResultWire[]
}

// ─── Admin / tile registry ───────────────────────────────────────
// From TileDefWire (planReviewBff.ts) — api-server GET /admin/functions.
export type TileDefWire = {
  id: string
  label: string
  category: string
  status: string
  degradedReason?: string
}

// ─── Documents / submissions ─────────────────────────────────────
// Added in Track C Phase 3 to let the moved IntakeTile create engagements,
// upload documents, and open submissions without reaching back into the app's
// planReviewBff. Shapes match the api-server routes:
//   POST /engagements/:id/documents/upload-url
//   POST /engagements/:id/documents/complete-upload
//   POST /engagements/:id/submissions
export type DocumentUploadUrl = {
  uploadUrl: string
  gcsPath: string
  objectPath: string
}

export type DocumentUploadComplete = {
  documentId: string | null
  objectPath: string
}

export type EngagementSubmissionCreated = {
  submissionId: string
  engagementId: string
  submittedAt: string
}

// GET /engagements/:id/submissions element (browser-facing subset).
export type EngagementSubmissionSummary = {
  id: string
  submittedAt: string
  jurisdiction: string | null
  note: string | null
  discipline: string | null
  status: string
  reviewerComment: string | null
  respondedAt: string | null
  responseRecordedAt: string | null
  findingGenerationState: string
  findingGenerationError: string | null
  openFindingCount: number
}

// GET /submissions/:id/findings/status.
export type SubmissionFindingsStatus = {
  generationId: string | null
  state: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  invalidCitationCount: number | null
  invalidCitations: unknown
  discardedFindingCount: number | null
}

// ─── Dataroom / Files tile (Phase 2) ─────────────────────────────
// The engine document-ingest pipeline mints CLAIM atoms from an uploaded file
// (point-to model). These shapes mirror what the BFF returns after proxying
// `POST /v1/document-ingest` and persisting the result. Confidence is ALWAYS
// the asserted widthed `{ kind, value, intervalWidth, n }` shape — never a
// bare number — per structural commitment #1.

export type AssertedConfidence = {
  kind: 'asserted' | 'calibrated'
  value: number
  intervalWidth: number
  n: number
}

/** One cited, confidence-graded atom extracted from a dataroom file. */
export type DataroomAtomChip = {
  atomDid: string
  entityType: string
  /** Engine-resolved (clamped) access policy — shown, never user-editable. */
  accessPolicy: string
  storageRelation: string
  confidence: AssertedConfidence
  verificationStatus: string
  /** The pinned source-document CID this atom cites back to. */
  sourceDocumentCid: string
}

/** POST /engagements/:id/documents/:docId/ingest result. */
export type DataroomIngestResult = {
  documentId: string
  status: 'ok' | 'empty' | 'degraded'
  sourceDocumentCid: string | null
  classification: {
    documentType?: string
    adapter?: string
    score?: number
  } | null
  atoms: DataroomAtomChip[]
  reason?: string
}

// GET /engagements/:id/documents — element shape (Dataroom file list).
export type EngagementDocument = {
  id: string
  title: string
  documentType: string
  url: string | null
  createdAt: string
}

// ─── Opaque report payloads (noted) ──────────────────────────────
// annotations, hazard, brief, encumbrances reports are returned by the
// api-server as ReportResult with opaque `result` bodies (Record<string,
// unknown> / geojson blobs / adapter payloads). They are NOT given invented
// field shapes — consumers use ReportResult<unknown> (or narrow at the call
// site). Named here for discoverability only.
export type OpaqueReportResult = ReportResult<unknown>
