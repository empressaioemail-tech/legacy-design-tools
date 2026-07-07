/**
 * M1-C lambda seam — amendment hazard from code-amendment atoms (dispatch E).
 *
 * Consumes the post-ingest corpus snapshot and computes jurisdiction x code-family
 * edition-bump hazard rates. Compatible with hauska-engine tools/f8-hazard-report.mjs output.
 */

import { AMENDMENT_HAZARD_COLD_START_PRIOR } from "./constants.js";
import { sectionFamilyFromSectionNumber } from "./corpusLoader.js";

export type AmendmentAtom = {
  entityType?: string;
  jurisdictionTenant?: string;
  sectionNumber?: string;
  editionLabel?: string;
  effectiveDate?: string;
  sourceType?: string;
};

export type AmendmentHazardResult = {
  /** Jurisdiction x code-family grain (e.g., "austin_tx:25-2"). */
  group: string;
  /** Amendments per year. */
  rate: number;
  /** Count of amendment events in this group. */
  amendmentCount: number;
  /** Observation window in years. */
  observationYears: number;
  /** "amendment-history" when computed from real atoms; "cold-start-prior" when zero amendments. */
  source: "amendment-history" | "cold-start-prior";
};

/**
 * Compute jurisdiction x code-family amendment hazard from code-amendment atoms.
 *
 * Returns cold-start prior (0.02/yr) when zero amendments are found.
 * When amendments exist, computes rate = amendmentCount / observationYears.
 */
export function lambdaFromAmendments(args: {
  snapshot: { atoms?: Record<string, AmendmentAtom> };
  jurisdictionTenant: string;
  /** Override observation window; defaults to inferring from amendment effectiveDate range. */
  observationYears?: number;
}): Map<string, AmendmentHazardResult> {
  const amendmentAtoms = Object.values(args.snapshot.atoms ?? {}).filter(
    (a) =>
      a?.entityType === "code-amendment" &&
      a.jurisdictionTenant === args.jurisdictionTenant,
  );

  if (amendmentAtoms.length === 0) {
    // No amendments — return cold-start prior for the jurisdiction at global grain.
    const result = new Map<string, AmendmentHazardResult>();
    result.set(args.jurisdictionTenant, {
      group: args.jurisdictionTenant,
      rate: AMENDMENT_HAZARD_COLD_START_PRIOR,
      amendmentCount: 0,
      observationYears: 0,
      source: "cold-start-prior",
    });
    return result;
  }

  // Group amendments by section family.
  const byFamily = new Map<string, AmendmentAtom[]>();
  for (const atom of amendmentAtoms) {
    const sectionNumber = atom.sectionNumber ?? "";
    const family = sectionFamilyFromSectionNumber(sectionNumber);
    const groupKey = `${args.jurisdictionTenant}:${family}`;
    if (!byFamily.has(groupKey)) {
      byFamily.set(groupKey, []);
    }
    byFamily.get(groupKey)!.push(atom);
  }

  const results = new Map<string, AmendmentHazardResult>();

  // Compute rate per family.
  for (const [groupKey, atoms] of byFamily) {
    const dates = atoms
      .map((a) => a.effectiveDate)
      .filter((d): d is string => !!d && Date.parse(d) > 0)
      .map((d) => new Date(d).getTime())
      .sort();

    let observationYears = args.observationYears;
    if (observationYears === undefined && dates.length > 0) {
      // Infer observation window from min/max dates.
      const minDate = dates[0]!;
      const maxDate = dates[dates.length - 1]!;
      const spanMs = maxDate - minDate;
      observationYears = Math.max(1, spanMs / (365.25 * 24 * 60 * 60 * 1000));
    }
    observationYears = observationYears ?? 1;

    const rate = atoms.length / observationYears;

    results.set(groupKey, {
      group: groupKey,
      rate,
      amendmentCount: atoms.length,
      observationYears,
      source: "amendment-history",
    });
  }

  // If no family-level results computed, fall back to jurisdiction-level cold-start.
  if (results.size === 0) {
    results.set(args.jurisdictionTenant, {
      group: args.jurisdictionTenant,
      rate: AMENDMENT_HAZARD_COLD_START_PRIOR,
      amendmentCount: 0,
      observationYears: 0,
      source: "cold-start-prior",
    });
  }

  return results;
}

/**
 * Resolve effective lambda for a given jurisdiction x section-family.
 * Falls back to cold-start prior if no amendment history exists for the family.
 */
export function resolveEffectiveLambda(
  amendmentHazards: ReadonlyMap<string, AmendmentHazardResult>,
  jurisdictionTenant: string,
  sectionFamily: string,
): { lambda: number; source: "amendment-history" | "cold-start-prior" } {
  const familyKey = `${jurisdictionTenant}:${sectionFamily}`;
  const familyResult = amendmentHazards.get(familyKey);
  if (familyResult && familyResult.source === "amendment-history") {
    return { lambda: familyResult.rate, source: "amendment-history" };
  }

  // Fall back to jurisdiction-level if available.
  const jurisdictionResult = amendmentHazards.get(jurisdictionTenant);
  if (jurisdictionResult) {
    return { lambda: jurisdictionResult.rate, source: jurisdictionResult.source };
  }

  // Ultimate fallback: cold-start prior.
  return {
    lambda: AMENDMENT_HAZARD_COLD_START_PRIOR,
    source: "cold-start-prior",
  };
}
