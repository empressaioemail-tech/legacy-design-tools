import { keyFromEngagement } from "@workspace/codes/jurisdictions";

export type EngagementTenantFields = {
  cortexJurisdictionKey?: string | null;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdiction?: string | null;
  address?: string | null;
};

/** Same partition key as atomAdjudicationEvidenceLedger / engine-core signals. */
export function resolveJurisdictionTenant(
  engagement: EngagementTenantFields,
): string | null {
  const stored = (engagement.cortexJurisdictionKey ?? "").trim();
  if (stored) return stored;
  return keyFromEngagement({
    jurisdictionCity: engagement.jurisdictionCity ?? null,
    jurisdictionState: engagement.jurisdictionState ?? null,
    jurisdiction: engagement.jurisdiction ?? null,
    address: engagement.address ?? null,
  });
}
