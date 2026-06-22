/**
 * Architecture-homes phase 1 — atom conformance assembly (Track A).
 *
 * Mutable / tenant families cannot be re-minted; wire and export surfaces
 * derive readContract at read time. Calibrated axis stays at asserted
 * fallback until earned fuel exists (M1 / tenant leg).
 */

import {
  ATOM_CONFORMANCE_TARGET_VERSION,
  validateAtomConformance,
  type AtomConformanceTarget,
  type AtomTier,
  type VerifyChainResult,
  ACCESS_POLICY_VALUES,
} from "@hauska/atom-contract/conformance";
import type { AtomEvent } from "@hauska/atom-contract";

type AccessPolicy = (typeof ACCESS_POLICY_VALUES)[number];
import type { ReadContract } from "@hauska/atom-contract/read-contract";
import {
  createReadContract,
  createThreeAxisConfidence,
  createWidthedConfidence,
} from "@hauska/atom-contract/read-contract";
import { intervalWidthFromSignalCount, routineConsequenceAxis } from "./readContractDerive.js";

/** ADR-017 five-value union — target accessPolicy per mutable family. */
export const FAMILY_ACCESS_POLICY = {
  encumbrances: "tenant-private",
  workspace: "tenant-private",
  reasoning: "platform-internal",
  finding: "tenant-private",
  submissionClassification: "tenant-private",
  siteTopography: "tenant-private",
  siteDrainage: "tenant-private",
  userGenerated: "tenant-private",
} as const satisfies Record<string, AccessPolicy>;

export type MutableAtomFamily = keyof typeof FAMILY_ACCESS_POLICY;

const VALID_ACCESS_POLICIES = new Set<AccessPolicy>([
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
]);

/** Map legacy / pre-ADR-017 values to the five-value union. */
export function normalizeAccessPolicy(
  raw: string | null | undefined,
  fallback: AccessPolicy,
): AccessPolicy {
  const value = (raw ?? "").trim();
  if (value === "tenant-scoped") return "tenant-private";
  if (VALID_ACCESS_POLICIES.has(value as AccessPolicy)) {
    return value as AccessPolicy;
  }
  return fallback;
}

export function accessPolicyForFamily(
  family: MutableAtomFamily,
  raw?: string | null,
): AccessPolicy {
  return normalizeAccessPolicy(raw, FAMILY_ACCESS_POLICY[family]);
}

/**
 * Pre-earned read-contract: both accuracy axes at asserted provenance;
 * consequence at conservative routine default until F2 thickens.
 */
export function buildAssertedFallbackReadContract(args?: {
  estimate?: number;
  n?: number;
  assembledAt?: string;
}): ReadContract {
  const assembledAt = args?.assembledAt ?? new Date().toISOString();
  const n = args?.n ?? 0;
  const estimate = Math.max(
    0,
    Math.min(1, args?.estimate ?? 0.65),
  );
  const width = intervalWidthFromSignalCount(n);
  const axis = createWidthedConfidence({
    estimate,
    n,
    intervalWidth: width,
    provenance: "asserted",
  });

  return createReadContract({
    axes: createThreeAxisConfidence({
      calibratedConfidence: axis,
      assertedConfidence: axis,
      consequence: routineConsequenceAxis(assembledAt),
    }),
    assembledAt,
  });
}

export function assembleAtomConformanceTarget(input: {
  tier: AtomTier;
  family: MutableAtomFamily;
  readContract: ReadContract;
  accessPolicyRaw?: string | null;
  signedHistory?: {
    events: ReadonlyArray<AtomEvent>;
    verifyChain: VerifyChainResult;
  };
}): AtomConformanceTarget {
  const accessPolicy = accessPolicyForFamily(input.family, input.accessPolicyRaw);
  return {
    conformanceTargetVersion: ATOM_CONFORMANCE_TARGET_VERSION,
    tier: input.tier,
    readContract: input.readContract,
    accessPolicy,
    ...(input.signedHistory ? { signedHistory: input.signedHistory } : {}),
  };
}

export function validateFamilyConformance(
  input: Parameters<typeof assembleAtomConformanceTarget>[0],
) {
  const accessPolicy = accessPolicyForFamily(input.family, input.accessPolicyRaw);
  return validateAtomConformance({
    tier: input.tier,
    readContract: input.readContract,
    accessPolicy,
    ...(input.signedHistory
      ? { signedHistory: { events: input.signedHistory.events } }
      : {}),
  });
}
