/**
 * Thin fetch client for the plan-review BFF (`/api/plan-review/*`).
 * Browser-side only — no server package imports.
 */
import type {
  EngagementDetail,
  EngagementQueueItem,
  IntakeParseResult,
  PrecedenceResultWire,
} from "../tile-shell/types";

const BASE = "/api/plan-review";

async function bffJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`,
    );
  }
  return res.json() as Promise<T>;
}

export type TileDefWire = {
  id: string;
  label: string;
  category: string;
  status: string;
  degradedReason?: string;
};

export function parseIntake(body: {
  mode: "link" | "file" | "paste" | "email";
  content: string | string[];
}): Promise<IntakeParseResult[]> {
  return bffJson("/intake", { method: "POST", body: JSON.stringify(body) });
}

export function fetchQueue(status?: string): Promise<EngagementQueueItem[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return bffJson(`/queue${q}`);
}

export function createEngagement(body: {
  name: string;
  address?: string;
  jurisdiction?: string;
}): Promise<{ engagementId: string }> {
  return bffJson("/engagements", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function requestDocumentUploadUrl(
  engagementId: string,
  body: { filename: string; contentType: string },
): Promise<{ uploadUrl: string; gcsPath: string; objectPath: string }> {
  return bffJson(`/engagements/${engagementId}/documents/upload-url`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function completeDocumentUpload(
  engagementId: string,
  body: {
    objectPath: string;
    filename: string;
    contentType: string;
    size: number;
  },
): Promise<{ documentId: string | null; objectPath: string }> {
  return bffJson(`/engagements/${engagementId}/documents/complete-upload`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function createEngagementSubmission(
  engagementId: string,
  body?: { note?: string },
): Promise<{ submissionId: string; engagementId: string; submittedAt: string }> {
  return bffJson(`/engagements/${engagementId}/submissions`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function fetchEngagementLetter(
  engagementId: string,
): Promise<{ draft: string | null; generatedAt: string | null }> {
  return bffJson(`/engagements/${engagementId}/letter`);
}

export function generateEngagementLetter(
  engagementId: string,
): Promise<{ draft: string; generatedAt: string }> {
  return bffJson(`/engagements/${engagementId}/letter/generate`, {
    method: "POST",
    body: "{}",
  });
}

export function fetchEngagement(id: string): Promise<EngagementDetail> {
  return bffJson(`/engagements/${id}`);
}

export function runReport(
  engagementId: string,
  type: string,
): Promise<{ generationId: string }> {
  return bffJson(`/engagements/${engagementId}/reports/${type}/run`, {
    method: "POST",
    body: "{}",
  });
}

export function getReport(
  engagementId: string,
  type: string,
): Promise<{ status: string; result?: unknown; error?: string }> {
  return bffJson(`/engagements/${engagementId}/reports/${type}`);
}

export function patchFinding(
  engagementId: string,
  findingId: string,
  body: {
    action: "accept" | "override" | "flag";
    reason?: string;
    overrideText?: string;
  },
): Promise<unknown> {
  return bffJson(`/engagements/${engagementId}/findings/${findingId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export type LetterDraft = {
  letterId: string;
  sections: Array<{ kind: string; heading: string; content: string }>;
};

export function draftLetter(
  engagementId: string,
  body: { reviewerTier: "junior" | "senior"; tenantId: string },
): Promise<LetterDraft> {
  return bffJson(`/engagements/${engagementId}/letter`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function renderLetter(
  engagementId: string,
  letterheadTemplateId: string,
): Promise<{ pdfUrl: string }> {
  return bffJson(`/engagements/${engagementId}/letter/render`, {
    method: "POST",
    body: JSON.stringify({ letterheadTemplateId }),
  });
}

export function sendLetter(
  engagementId: string,
  body: { to: string; subject: string },
): Promise<{ status: string }> {
  return bffJson(`/engagements/${engagementId}/letter/send`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchAdminFunctions(): Promise<TileDefWire[]> {
  return bffJson("/admin/functions");
}

export type ComplianceRunResult = {
  generationId: string;
  precedenceResult?: PrecedenceResultWire[];
};

export function runCompliancePass(
  engagementId: string,
  submissionId: string,
): Promise<ComplianceRunResult> {
  return bffJson(`/engagements/${engagementId}/compliance-run`, {
    method: "POST",
    body: JSON.stringify({ submissionId }),
  });
}

export type EngagementSubmissionSummaryWire = Awaited<
  ReturnType<typeof fetchEngagementSubmissions>
>;

export function fetchEngagementSubmissions(
  engagementId: string,
): Promise<
  Array<{
    id: string;
    submittedAt: string;
    jurisdiction: string | null;
    note: string | null;
    discipline: string | null;
    status: string;
    reviewerComment: string | null;
    respondedAt: string | null;
    responseRecordedAt: string | null;
    findingGenerationState: string;
    findingGenerationError: string | null;
    openFindingCount: number;
  }>
> {
  return bffJson(`/engagements/${engagementId}/submissions`);
}

export function fetchSubmissionFindings(submissionId: string): Promise<{
  findings: unknown[];
}> {
  return bffJson(`/submissions/${submissionId}/findings`);
}

export function fetchSubmissionFindingsStatus(submissionId: string): Promise<{
  generationId: string | null;
  state: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  invalidCitationCount: number | null;
  invalidCitations: unknown;
  discardedFindingCount: number | null;
}> {
  return bffJson(`/submissions/${submissionId}/findings/status`);
}
