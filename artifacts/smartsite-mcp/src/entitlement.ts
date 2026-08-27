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

/** Export kinds that require Studio or Team (LOCKED 2026-08-10 ladder). */
export const STUDIO_EXPORT_KINDS = ["siteplan", "terrain", "dossier"] as const;
export type StudioExportKind = (typeof STUDIO_EXPORT_KINDS)[number];

export function isStudioExportKind(
  kind: string,
): kind is StudioExportKind {
  return (STUDIO_EXPORT_KINDS as readonly string[]).includes(kind);
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
  reason: "deep_report" | "studio_report";
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
    message: "Studio or Team subscription required for this report.",
  };
}
