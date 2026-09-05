import { describe, expect, it } from "vitest";

import {
  canRunDeepReport,
  canRunStudioReport,
  isPropertyExportKind,
  isStudioExportKind,
  refusePropertyExport,
  refuseStudioReport,
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

  it("studio export kinds are siteplan and terrain only (P-119, A-103)", () => {
    expect(isStudioExportKind("siteplan")).toBe(true);
    expect(isStudioExportKind("terrain")).toBe(true);
    expect(isStudioExportKind("dossier")).toBe(false);
    expect(isStudioExportKind("feasibility")).toBe(false);
    expect(isStudioExportKind("brief")).toBe(false);
  });

  it("property export kinds (paid tier or property unlock, never Studio-only) are dossier alone", () => {
    expect(isPropertyExportKind("dossier")).toBe(true);
    expect(isPropertyExportKind("siteplan")).toBe(false);
    expect(isPropertyExportKind("terrain")).toBe(false);
    expect(isPropertyExportKind("feasibility")).toBe(false);
    expect(isPropertyExportKind("brief")).toBe(false);
  });
});

describe("export gate refusals carry a distinct reason per gate (P-119, A-103)", () => {
  it("refuseStudioReport names studio_report and mentions the property-unlock alternative", () => {
    const solo = resolveEntitlementSnapshot({
      accessTier: "paid",
      subscriptionTier: "solo",
      devRole: false,
    });
    const refusal = refuseStudioReport(solo);
    expect(refusal.reason).toBe("studio_report");
    expect(refusal.message).toMatch(/property unlock/i);
  });

  it("refusePropertyExport names property_export and mentions both alternatives", () => {
    const free = resolveEntitlementSnapshot({
      accessTier: "free",
      subscriptionTier: null,
      devRole: false,
    });
    const refusal = refusePropertyExport(free);
    expect(refusal.reason).toBe("property_export");
    expect(refusal.message).toMatch(/property unlock/i);
    expect(refusal.message).toMatch(/solo/i);
  });
});
