function apiBase(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return base.endsWith("/") ? `${base}api` : `${base}/api`;
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

import type {
  EngagementPackageRecord,
  PackageFormSnapshot,
  PackageSelection,
  PackageShareComment,
  PackageShareView,
  PackageTemplateId,
} from "./types";

export interface CreateEngagementResult {
  id: string;
  name: string;
}

export async function createEngagement(body: {
  name: string;
  address?: string | null;
  jurisdiction?: string | null;
  projectType?: string | null;
  intakeSource?: string | null;
  applicantFirm?: string | null;
  clientEmail?: string | null;
  clientNotes?: string | null;
  sourceExcerpt?: string | null;
}): Promise<CreateEngagementResult> {
  return apiFetch<CreateEngagementResult>("/engagements", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listEngagementPackages(
  engagementId: string,
): Promise<EngagementPackageRecord[]> {
  return apiFetch<EngagementPackageRecord[]>(
    `/engagements/${engagementId}/packages`,
  );
}

export async function createEngagementPackage(
  engagementId: string,
  body: {
    template: PackageTemplateId;
    title?: string;
    snapshotId?: string | null;
    selection?: PackageSelection;
    formSnapshot?: PackageFormSnapshot | null;
  },
): Promise<EngagementPackageRecord> {
  return apiFetch<EngagementPackageRecord>(
    `/engagements/${engagementId}/packages`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function updateEngagementPackage(
  packageId: string,
  body: Partial<{
    template: PackageTemplateId;
    title: string;
    status: string;
    snapshotId: string | null;
    selection: PackageSelection;
    formSnapshot: PackageFormSnapshot | null;
    clientReviewDeadline: string | null;
    linkedSubmissionId: string | null;
  }>,
): Promise<EngagementPackageRecord> {
  return apiFetch<EngagementPackageRecord>(`/packages/${packageId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function createPackageShare(
  packageId: string,
): Promise<{ token: string; shareUrl: string }> {
  return apiFetch<{ token: string; shareUrl: string }>(
    `/packages/${packageId}/share`,
    { method: "POST", body: "{}" },
  );
}

export async function listPackageComments(
  packageId: string,
): Promise<PackageShareComment[]> {
  return apiFetch<PackageShareComment[]>(`/packages/${packageId}/comments`);
}

export async function fetchPackageShare(
  token: string,
): Promise<PackageShareView> {
  return apiFetch<PackageShareView>(`/package-shares/${token}`);
}

export async function postShareComment(
  token: string,
  body: { authorName: string; body: string; sheetId?: string | null },
): Promise<PackageShareComment> {
  return apiFetch<PackageShareComment>(`/package-shares/${token}/comments`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function absoluteShareUrl(token: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const path = base.endsWith("/") ? `${base}share/${token}` : `${base}/share/${token}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path.startsWith("/") ? "" : "/"}${path.replace(/^\//, "")}`;
}
