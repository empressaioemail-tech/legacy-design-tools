import { countAtomsForJurisdiction } from "@workspace/codes/retrieval";
import {
  resolveEngagementCoverage,
  type CoverageStatus,
  type ResolvedEngagementCoverage,
} from "@workspace/coverage";
import { getHauskaSubstrateClient } from "./hauskaSubstrateClient";

export type { CoverageStatus, ResolvedEngagementCoverage };

export interface EngagementCoverageInput {
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdictionFips?: string | null;
  jurisdiction?: string | null;
  address?: string | null;
}

export async function computeEngagementCoverage(
  input: EngagementCoverageInput,
): Promise<ResolvedEngagementCoverage> {
  let substrateJurisdictions: { key: string; displayName: string }[] = [];
  try {
    const catalog = await getHauskaSubstrateClient().listJurisdictions();
    substrateJurisdictions = catalog.jurisdictions;
  } catch {
    substrateJurisdictions = [];
  }

  const resolved = resolveEngagementCoverage(input, {
    substrateJurisdictions,
  });

  if (!resolved.cortexJurisdictionKey) {
    return resolved;
  }

  try {
    const atomCount = await countAtomsForJurisdiction(
      resolved.cortexJurisdictionKey,
    );
    return resolveEngagementCoverage(input, {
      substrateJurisdictions,
      cortexAtomCount: atomCount,
    });
  } catch {
    return resolved;
  }
}

export function coverageFieldsFromResolved(resolved: ResolvedEngagementCoverage) {
  return {
    substrateJurisdictionKey: resolved.substrateJurisdictionKey,
    cortexJurisdictionKey: resolved.cortexJurisdictionKey,
    coverageStatus: resolved.coverageStatus,
  };
}
