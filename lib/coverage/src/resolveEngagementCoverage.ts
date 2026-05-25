import { keyFromEngagement } from "@workspace/codes/jurisdictions";
import {
  matchSubstrateJurisdiction,
  normalizeStateCode,
  type JurisdictionLike,
} from "./jurisdictionMatch";

export type CoverageStatus =
  | "unknown"
  | "not_in_catalog"
  | "substrate_only"
  | "warming"
  | "ready";

export interface ResolveEngagementCoverageInput {
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdictionFips?: string | null;
  jurisdiction?: string | null;
  address?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
}

export interface ResolveEngagementCoverageOptions {
  substrateJurisdictions?: ReadonlyArray<JurisdictionLike>;
  cortexAtomCount?: number;
  warmupState?: "idle" | "running" | "completed" | "failed" | null;
}

export interface ResolvedEngagementCoverage {
  substrateJurisdictionKey: string | null;
  cortexJurisdictionKey: string | null;
  coverageStatus: CoverageStatus;
}

function hasGeocode(input: ResolveEngagementCoverageInput): boolean {
  const state = normalizeStateCode(input.jurisdictionState);
  if (state) return true;
  const fromJurisdiction = (input.jurisdiction ?? "").trim();
  if (fromJurisdiction.includes(",")) return true;
  return false;
}

/**
 * Resolve honest code coverage for an engagement after geocode.
 * Heuristic documented in jurisdiction surfacing v2 dispatch.
 */
export function resolveEngagementCoverage(
  input: ResolveEngagementCoverageInput,
  options: ResolveEngagementCoverageOptions = {},
): ResolvedEngagementCoverage {
  if (!hasGeocode(input)) {
    return {
      substrateJurisdictionKey: null,
      cortexJurisdictionKey: null,
      coverageStatus: "unknown",
    };
  }

  const cortexJurisdictionKey = keyFromEngagement({
    jurisdictionCity: input.jurisdictionCity,
    jurisdictionState: input.jurisdictionState,
    jurisdiction: input.jurisdiction,
    address: input.address,
  });

  const substrateJurisdictionKey = options.substrateJurisdictions
    ? matchSubstrateJurisdiction(options.substrateJurisdictions, {
        jurisdictionCity: input.jurisdictionCity,
        jurisdictionState: input.jurisdictionState,
        jurisdictionFips: input.jurisdictionFips,
      })
    : null;

  if (!cortexJurisdictionKey && !substrateJurisdictionKey) {
    return {
      substrateJurisdictionKey: null,
      cortexJurisdictionKey: null,
      coverageStatus: "not_in_catalog",
    };
  }

  if (substrateJurisdictionKey && !cortexJurisdictionKey) {
    return {
      substrateJurisdictionKey,
      cortexJurisdictionKey: null,
      coverageStatus: "substrate_only",
    };
  }

  const atomCount = options.cortexAtomCount ?? 0;
  const warmupRunning = options.warmupState === "running";

  if (atomCount > 0) {
    return {
      substrateJurisdictionKey,
      cortexJurisdictionKey,
      coverageStatus: "ready",
    };
  }

  if (warmupRunning) {
    return {
      substrateJurisdictionKey,
      cortexJurisdictionKey,
      coverageStatus: "warming",
    };
  }

  if (cortexJurisdictionKey) {
    return {
      substrateJurisdictionKey,
      cortexJurisdictionKey,
      coverageStatus: "warming",
    };
  }

  return {
    substrateJurisdictionKey,
    cortexJurisdictionKey: null,
    coverageStatus: "substrate_only",
  };
}

/** Map v2 coverageStatus to QA-23 chat guardrail bucket. */
export function coverageStatusToGuardrail(
  status: CoverageStatus,
): "covered" | "no_atoms" | "unrecognized" {
  if (status === "ready") return "covered";
  if (status === "unknown") return "unrecognized";
  return "no_atoms";
}

export const COVERAGE_STATUS_LABELS: Record<CoverageStatus, string> = {
  unknown: "No site address yet",
  not_in_catalog: "Not in Hauska catalog",
  substrate_only: "On substrate — corpus not warmed",
  warming: "Warming code corpus…",
  ready: "Code corpus ready",
};
