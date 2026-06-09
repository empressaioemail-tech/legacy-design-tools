export type CoverageStatus =
  | "unknown"
  | "not_in_catalog"
  | "substrate_only"
  | "warming"
  | "ready";

export const COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  unknown: "No geocode yet",
  not_in_catalog: "Not in catalog",
  substrate_only: "Substrate only",
  warming: "Warming up",
  ready: "Code ready",
};

export function coverageStatusLabel(status: string | undefined): string {
  if (status && status in COVERAGE_STATUS_LABEL) {
    return COVERAGE_STATUS_LABEL[status as CoverageStatus];
  }
  return status ?? "Unknown";
}

/** True when jurisdiction resolves — corpus warmup is informational, not a gate. */
export function canRunPlanReview(
  jurisdiction: string | null | undefined,
  _coverageStatus?: string,
): boolean {
  return !!jurisdiction?.trim();
}

/** Coverage status is shown for context; web-grounding runs without a warmed corpus. */
export function isCoverageInformational(coverageStatus?: string): boolean {
  return !!coverageStatus && coverageStatus !== "ready";
}

export function shouldShowRequestCoverage(coverageStatus?: string): boolean {
  return (
    coverageStatus === "not_in_catalog" || coverageStatus === "substrate_only"
  );
}

export async function requestEngagementCoverage(
  engagementId: string,
  note?: string,
): Promise<{ status: string; engagementId: string }> {
  const res = await fetch(`/api/engagements/${engagementId}/request-coverage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as { status: string; engagementId: string };
}
