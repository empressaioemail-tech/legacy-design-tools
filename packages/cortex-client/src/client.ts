import type {
  QueueRow,
  EngagementDetail,
  ReportResult,
  LetterDraft,
  Sheet,
  ResponseTask,
  IntakeParseResult,
  ComplianceRunResult,
  TileDefWire,
  DocumentUploadUrl,
  DocumentUploadComplete,
  EngagementSubmissionCreated,
  EngagementSubmissionSummary,
  SubmissionFindings,
  SubmissionFindingsStatus,
} from './types'

export type CortexClientConfig = {
  baseUrl: string
  getToken: () => string | Promise<string>
}

export type CortexClient = {
  config: CortexClientConfig
  fetch: <T>(path: string, init?: RequestInit) => Promise<T>

  // ─── Typed plan-review BFF convenience methods ─────────────────
  // Consumer supplies baseUrl (e.g. "/api"); these hit "/plan-review/...".
  getQueue: (status?: string) => Promise<QueueRow[]>
  getEngagement: (id: string) => Promise<EngagementDetail>
  runReport: (
    engagementId: string,
    type: string,
  ) => Promise<{ generationId: string }>
  getReport: <T = unknown>(
    engagementId: string,
    type: string,
  ) => Promise<ReportResult<T>>
  getLetter: (engagementId: string) => Promise<LetterDraft>
  generateLetter: (engagementId: string) => Promise<LetterDraft>
  patchFinding: (
    engagementId: string,
    findingId: string,
    patch: { action: 'accept' | 'override' | 'flag'; reason?: string; overrideText?: string },
  ) => Promise<unknown>
  getSheets: (engagementId: string) => Promise<{ sheets: Sheet[] }>
  extractSheets: (
    engagementId: string,
  ) => Promise<{ extracted: number; message?: string }>
  getResponseTasks: (
    engagementId: string,
  ) => Promise<{ responseTasks: ResponseTask[] }>
  createEngagement: (body: {
    name: string
    address?: string
    jurisdiction?: string
  }) => Promise<{ engagementId: string }>
  parseIntake: (body: {
    mode: 'link' | 'file' | 'paste' | 'email'
    content: string | string[]
  }) => Promise<IntakeParseResult[]>
  runCompliancePass: (
    engagementId: string,
    submissionId: string,
  ) => Promise<ComplianceRunResult>
  fetchAdminFunctions: () => Promise<TileDefWire[]>

  // ─── Added in Track C Phase 3 (IntakeTile + compliance/letter moves) ───
  requestDocumentUploadUrl: (
    engagementId: string,
    body: { filename: string; contentType: string },
  ) => Promise<DocumentUploadUrl>
  completeDocumentUpload: (
    engagementId: string,
    body: {
      objectPath: string
      filename: string
      contentType: string
      size: number
    },
  ) => Promise<DocumentUploadComplete>
  createSubmission: (
    engagementId: string,
    body?: { note?: string },
  ) => Promise<EngagementSubmissionCreated>
  getSubmissions: (
    engagementId: string,
  ) => Promise<EngagementSubmissionSummary[]>
  getSubmissionFindings: (submissionId: string) => Promise<SubmissionFindings>
  getSubmissionFindingsStatus: (
    submissionId: string,
  ) => Promise<SubmissionFindingsStatus>
}

export function createCortexClient(config: CortexClientConfig): CortexClient {
  async function doFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await config.getToken()
    // Auth seam: legacy-design-tools plan-review routes are gated by
    // requireServiceTokenOrSession — a PRESENT-but-non-service Authorization
    // header is rejected 401, and the browser path is cookie-session only.
    // So only send the Bearer header when we actually have a token; when the
    // consumer supplies an empty token (the codex-reviewer-qa dev/cookie
    // case), fall through to the same-origin session cookie instead.
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {}
    const res = await fetch(`${config.baseUrl}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) throw new CortexApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  return {
    config,
    fetch: doFetch,

    getQueue(status) {
      const q = status ? `?status=${encodeURIComponent(status)}` : ''
      return doFetch<QueueRow[]>(`/plan-review/queue${q}`)
    },

    getEngagement(id) {
      return doFetch<EngagementDetail>(`/plan-review/engagements/${id}`)
    },

    runReport(engagementId, type) {
      return doFetch<{ generationId: string }>(
        `/plan-review/engagements/${engagementId}/reports/${type}/run`,
        { method: 'POST', body: '{}' },
      )
    },

    getReport<T = unknown>(engagementId: string, type: string) {
      return doFetch<ReportResult<T>>(
        `/plan-review/engagements/${engagementId}/reports/${type}`,
      )
    },

    getLetter(engagementId) {
      return doFetch<LetterDraft>(
        `/plan-review/engagements/${engagementId}/letter`,
      )
    },

    generateLetter(engagementId) {
      return doFetch<LetterDraft>(
        `/plan-review/engagements/${engagementId}/letter/generate`,
        { method: 'POST', body: '{}' },
      )
    },

    patchFinding(engagementId, findingId, patch) {
      return doFetch<unknown>(
        `/plan-review/engagements/${engagementId}/findings/${findingId}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      )
    },

    getSheets(engagementId) {
      return doFetch<{ sheets: Sheet[] }>(
        `/plan-review/engagements/${engagementId}/sheets`,
      )
    },

    extractSheets(engagementId) {
      return doFetch<{ extracted: number; message?: string }>(
        `/plan-review/engagements/${engagementId}/sheets/extract`,
        { method: 'POST', body: '{}' },
      )
    },

    getResponseTasks(engagementId) {
      return doFetch<{ responseTasks: ResponseTask[] }>(
        `/plan-review/engagements/${engagementId}/response-tasks`,
      )
    },

    createEngagement(body) {
      return doFetch<{ engagementId: string }>(`/plan-review/engagements`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    parseIntake(body) {
      return doFetch<IntakeParseResult[]>(`/plan-review/intake`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    runCompliancePass(engagementId, submissionId) {
      return doFetch<ComplianceRunResult>(
        `/plan-review/engagements/${engagementId}/compliance-run`,
        { method: 'POST', body: JSON.stringify({ submissionId }) },
      )
    },

    fetchAdminFunctions() {
      return doFetch<TileDefWire[]>(`/plan-review/admin/functions`)
    },

    requestDocumentUploadUrl(engagementId, body) {
      return doFetch<DocumentUploadUrl>(
        `/plan-review/engagements/${engagementId}/documents/upload-url`,
        { method: 'POST', body: JSON.stringify(body) },
      )
    },

    completeDocumentUpload(engagementId, body) {
      return doFetch<DocumentUploadComplete>(
        `/plan-review/engagements/${engagementId}/documents/complete-upload`,
        { method: 'POST', body: JSON.stringify(body) },
      )
    },

    createSubmission(engagementId, body) {
      return doFetch<EngagementSubmissionCreated>(
        `/plan-review/engagements/${engagementId}/submissions`,
        { method: 'POST', body: JSON.stringify(body ?? {}) },
      )
    },

    getSubmissions(engagementId) {
      return doFetch<EngagementSubmissionSummary[]>(
        `/plan-review/engagements/${engagementId}/submissions`,
      )
    },

    getSubmissionFindings(submissionId) {
      return doFetch<SubmissionFindings>(
        `/plan-review/submissions/${submissionId}/findings`,
      )
    },

    getSubmissionFindingsStatus(submissionId) {
      return doFetch<SubmissionFindingsStatus>(
        `/plan-review/submissions/${submissionId}/findings/status`,
      )
    },
  }
}

export class CortexApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`CortexAPI ${status}: ${message}`)
  }
}
