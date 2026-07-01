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
