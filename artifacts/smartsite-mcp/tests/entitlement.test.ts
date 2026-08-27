import { describe, expect, it } from "vitest";

import {
  canRunDeepReport,
  canRunStudioReport,
  isStudioExportKind,
  resolveEntitlementSnapshot,
  subscriptionTierGrantsStudio,
} from "../src/entitlement.js";

/** Four-tier matrix fixtures aligned with workbench peEntitlement snapshots. */
const TIER_FIXTURES = [
  {
    label: "free",
    row: { accessTier: "free" as const, subscriptionTier: null, devRole: false },
    tier: "free" as const,
    subscriptionTier: null,
    deep: false,
    studio: false,
  },
  {
    label: "solo",
    row: {
      accessTier: "paid" as const,
      subscriptionTier: "solo" as const,
      devRole: false,
    },
    tier: "paid" as const,
    subscriptionTier: "solo" as const,
    deep: true,
    studio: false,
  },
  {
    label: "solo-legacy-null-rung",
    row: {
      accessTier: "paid" as const,
      subscriptionTier: null,
      devRole: false,
    },
    tier: "paid" as const,
    subscriptionTier: "solo" as const,
    deep: true,
    studio: false,
  },
  {
    label: "studio",
    row: {
      accessTier: "paid" as const,
      subscriptionTier: "studio" as const,
      devRole: false,
    },
    tier: "paid" as const,
    subscriptionTier: "studio" as const,
    deep: true,
    studio: true,
  },
  {
    label: "team",
    row: {
      accessTier: "paid" as const,
      subscriptionTier: "team" as const,
      devRole: false,
    },
    tier: "paid" as const,
    subscriptionTier: "team" as const,
    deep: true,
    studio: true,
  },
  {
    label: "dev-role-free-row",
    row: { accessTier: "free" as const, subscriptionTier: null, devRole: true },
    tier: "paid" as const,
    subscriptionTier: "team" as const,
    deep: true,
    studio: true,
  },
] as const;

describe("four-tier entitlement matrix (workbench parity)", () => {
  it.each(TIER_FIXTURES)(
    "$label ceiling matches workbench snapshot",
    ({ row, tier, subscriptionTier, deep, studio }) => {
      const snap = resolveEntitlementSnapshot(row);
      expect(snap.tier).toBe(tier);
      expect(snap.subscriptionTier).toBe(subscriptionTier);
      expect(canRunDeepReport(snap)).toBe(deep);
      expect(canRunStudioReport(snap)).toBe(studio);
    },
  );

  it("free session cannot run a Studio report; Studio session can", () => {
    const free = resolveEntitlementSnapshot(TIER_FIXTURES[0].row);
    const solo = resolveEntitlementSnapshot(TIER_FIXTURES[1].row);
    const studio = resolveEntitlementSnapshot(TIER_FIXTURES[3].row);

    expect(canRunStudioReport(free)).toBe(false);
    expect(canRunStudioReport(solo)).toBe(false);
    expect(canRunStudioReport(studio)).toBe(true);
  });

  it("subscriptionTierGrantsStudio matches api-server predicate", () => {
    expect(subscriptionTierGrantsStudio(null)).toBe(false);
    expect(subscriptionTierGrantsStudio("solo")).toBe(false);
    expect(subscriptionTierGrantsStudio("studio")).toBe(true);
    expect(subscriptionTierGrantsStudio("team")).toBe(true);
  });

  it("studio export kinds are siteplan, terrain, dossier only", () => {
    expect(isStudioExportKind("siteplan")).toBe(true);
    expect(isStudioExportKind("terrain")).toBe(true);
    expect(isStudioExportKind("dossier")).toBe(true);
    expect(isStudioExportKind("brief")).toBe(false);
  });
});
