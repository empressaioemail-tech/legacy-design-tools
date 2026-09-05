/**
 * Stripe tier ceiling for Smart Site MCP — mirrors workbench
 * `resolvePeEntitlement` / `subscriptionTierGrantsStudio` in api-server.
 */

import type { PeSubscriptionTier } from "@workspace/db/schema";

import type { SmartsiteAuthContext } from "./request-context.js";

export type SmartsiteEntitlementSnapshot = {
  tier: "free" | "paid";
  /** Ladder rung; null for free. Legacy paid-without-rung reads as solo. */
  subscriptionTier: PeSubscriptionTier | null;
  devRole: boolean;
};

/**
 * Export kinds that require Studio or Team, OR a per-parcel property
 * unlock (P-119, OPS-16 A-103): the operator's final authoritative package
 * table lists site plan CAD and terrain export on BOTH the Studio/Team rows
 * AND the Property Unlock row, so a subscription is not the only door.
 * Property Unlock is a distinct, parcel-scoped entitlement path (a
 * one-time/30-day unlock, not a subscription tier — see A-068); the caller
 * must separately check a property-unlock lookup (hasPropertyUnlock,
 * ../property-unlock.js) when `canRunStudioReport` alone is false, exactly
 * the way the web app's own `isPePropertyEntitled` composes "paid tier OR
 * property unlock". `dossier` does NOT belong in this set — see
 * PROPERTY_EXPORT_KINDS below and the A-103 correction.
 */
export const STUDIO_EXPORT_KINDS = ["siteplan", "terrain"] as const;
export type StudioExportKind = (typeof STUDIO_EXPORT_KINDS)[number];

export function isStudioExportKind(
  kind: string,
): kind is StudioExportKind {
  return (STUDIO_EXPORT_KINDS as readonly string[]).includes(kind);
}

/**
 * Export kinds that require only PAID tier (Solo+) OR a per-parcel
 * property unlock — the weaker "R1 property entitlement" line the web app
 * already uses for the X-ray/dossier PDF (pe-dossier-export-core.ts:
 * `resolveDossierExportAuth`, `tier !== 'paid' && propertyUnlocked !==
 * true`) and for Flood & Drainage.
 *
 * CORRECTED HERE (OPS-16 A-103, P-119 row 1): `dossier` used to live in
 * STUDIO_EXPORT_KINDS above, gating X-ray exports to Studio/Team on this
 * connector while the web app has never required more than Solo (A-068
 * measured this as a "recorded, deliberate divergence" at the time; A-074/
 * A-099 confirmed the connector — not the web app — was the wrong side;
 * the operator's final package table settles it: X-ray is a Solo-tier
 * capability). The web app and the table are ground truth; this was the
 * connector's own bug, not a re-litigation of either.
 */
export const PROPERTY_EXPORT_KINDS = ["dossier"] as const;
export type PropertyExportKind = (typeof PROPERTY_EXPORT_KINDS)[number];

export function isPropertyExportKind(
  kind: string,
): kind is PropertyExportKind {
  return (PROPERTY_EXPORT_KINDS as readonly string[]).includes(kind);
}

export function subscriptionTierGrantsStudio(
  tier: PeSubscriptionTier | null,
): boolean {
  return tier === "studio" || tier === "team";
}

export function resolveEntitlementSnapshot(
  row: Pick<
    SmartsiteAuthContext,
    "accessTier" | "subscriptionTier" | "devRole"
  >,
): SmartsiteEntitlementSnapshot {
  const tier: "free" | "paid" =
    row.accessTier === "paid" || row.devRole ? "paid" : "free";
  const subscriptionTier: PeSubscriptionTier | null = row.devRole
    ? "team"
    : row.accessTier === "paid"
      ? (row.subscriptionTier ?? "solo")
      : null;
  return { tier, subscriptionTier, devRole: row.devRole };
}

export function snapshotFromAuth(
  auth: SmartsiteAuthContext,
): SmartsiteEntitlementSnapshot {
  return resolveEntitlementSnapshot(auth);
}

/** Deep routes (R1 brief, run_report) — paid tier or dev bypass. */
export function canRunDeepReport(
  snap: SmartsiteEntitlementSnapshot,
): boolean {
  return snap.tier === "paid";
}

/** Studio deliverables (CAD, terrain, owner data, records package). */
export function canRunStudioReport(
  snap: SmartsiteEntitlementSnapshot,
): boolean {
  return subscriptionTierGrantsStudio(snap.subscriptionTier);
}

export type EntitlementGateRefusal = {
  status: "upgrade_required";
  /**
   * `studio_screens` is not built by a `refuse*` function here: it is the
   * api-server screens gate's own reason (`peStudioGate.ts`,
   * STUDIO_SCREENS_REFUSAL_REASON), reshaped from its 402 body by
   * `mapScreensGateNonOk` (tool-honesty.ts) into this same envelope. Listed
   * in this union so that reshaped value still type-checks as an
   * EntitlementGateRefusal — one shape for "you need to upgrade" regardless
   * of which gate (local predicate, or upstream route) produced it.
   *
   * `property_export` (P-119, A-103): the X-ray/dossier export refusal —
   * paid tier (Solo+) or a property unlock, neither held. Distinct from
   * `deep_report` (run_report's unchanged paid-tier-only local gate) so the
   * two refusal copies do not drift into meaning the same thing by accident.
   */
  reason: "deep_report" | "studio_report" | "studio_screens" | "property_export";
  tier: "free" | "paid";
  subscriptionTier: PeSubscriptionTier | null;
  message: string;
};

export function refuseDeepReport(
  snap: SmartsiteEntitlementSnapshot,
): EntitlementGateRefusal {
  return {
    status: "upgrade_required",
    reason: "deep_report",
    tier: snap.tier,
    subscriptionTier: snap.subscriptionTier,
    message: "Paid access required to run this report.",
  };
}

export function refuseStudioReport(
  snap: SmartsiteEntitlementSnapshot,
): EntitlementGateRefusal {
  return {
    status: "upgrade_required",
    reason: "studio_report",
    tier: snap.tier,
    subscriptionTier: snap.subscriptionTier,
    message:
      "Studio or Team subscription, or a 30-day property unlock on this parcel, is required for this export.",
  };
}

/**
 * X-ray/dossier export refusal (P-119, A-103): paid tier (Solo+) or a
 * property unlock, neither held. Weaker than {@link refuseStudioReport} —
 * see PROPERTY_EXPORT_KINDS above for why dossier does not share its gate.
 */
export function refusePropertyExport(
  snap: SmartsiteEntitlementSnapshot,
): EntitlementGateRefusal {
  return {
    status: "upgrade_required",
    reason: "property_export",
    tier: snap.tier,
    subscriptionTier: snap.subscriptionTier,
    message:
      "Paid access (Solo or above) or a 30-day property unlock is required to export this document.",
  };
}
