/**
 * Investor radar package tiers — Free / Pro / Max (75i, 08).
 */

import { FEDERAL_ADAPTERS } from "@workspace/adapters/registry";
import { isTceqEdwardsEnabled } from "@workspace/adapters/registry";
import type { Adapter } from "@workspace/adapters/types";
import { opportunityZoneAdapter } from "./opportunityZoneAdapter";

export type InvestorPackageTier = "free" | "pro" | "max";

export const INVESTOR_DEPTH_METER_DEFAULTS: Record<
  InvestorPackageTier,
  { maxPaidAdapterCalls: number }
> = {
  free: { maxPaidAdapterCalls: 0 },
  pro: { maxPaidAdapterCalls: 8 },
  max: { maxPaidAdapterCalls: 24 },
};

const FREE_KEYS = new Set([
  "fema:nfhl-flood-zone",
  "cotality:parcels",
  "cotality:zoning",
  "national:opportunity-zone",
]);

const PRO_EXTRA_KEYS = new Set([
  "usgs:ned-elevation",
  "epa:ejscreen",
  "cotality:property",
  "cotality:rent-avm",
  "cotality:liens-mortgage-tax",
  "cotality:permits",
  "cotality:propensity",
  "cotality:owner-occupancy",
]);

const MAX_EXTRA_KEYS = new Set([
  "usda:ssurgo-soils",
  "usgs:geology",
  "usgs:seismic",
  "cotality:climate",
  "cotality:hazards",
  "cotality:replacementcost",
  "cotality:mineral",
  "cotality:utility",
  "cotality:sinkhole",
  "cotality:foundation",
  "tceq:edwards-aquifer",
]);

function federalByKey(): Map<string, Adapter> {
  return new Map(FEDERAL_ADAPTERS.map((a) => [a.adapterKey, a]));
}

function pickKeys(keys: Set<string>): Adapter[] {
  const map = federalByKey();
  const out: Adapter[] = [];
  for (const key of keys) {
    const adapter = map.get(key);
    if (adapter) out.push(adapter);
  }
  return out;
}

export function resolveInvestorPackageTier(input: {
  tier?: InvestorPackageTier | null;
  brokerageAuthTier?: "dev" | "extension_public" | "user" | null;
  profileTier?: InvestorPackageTier | null;
}): InvestorPackageTier {
  if (input.profileTier) return input.profileTier;
  if (input.tier) return input.tier;
  if (input.brokerageAuthTier === "dev") return "max";
  if (input.brokerageAuthTier === "user") return "pro";
  return "free";
}

export function adaptersForInvestorTier(
  tier: InvestorPackageTier,
): readonly Adapter[] {
  const free = [...pickKeys(FREE_KEYS), opportunityZoneAdapter];
  if (tier === "free") return free;

  const proKeys = new Set([...FREE_KEYS, ...PRO_EXTRA_KEYS]);
  const pro = [...pickKeys(proKeys), opportunityZoneAdapter];
  if (tier === "pro") return pro;

  const maxKeys = new Set([...proKeys, ...MAX_EXTRA_KEYS]);
  if (!isTceqEdwardsEnabled()) maxKeys.delete("tceq:edwards-aquifer");
  return [...pickKeys(maxKeys), opportunityZoneAdapter];
}

/** Cotality-backed adapters that count against the depth meter (COGS guard). */
const FREE_COTALITY_BASELINE_KEYS = new Set([
  "cotality:parcels",
  "cotality:zoning",
]);

export function isMeteredCotalityAdapter(adapterKey: string): boolean {
  if (!adapterKey.startsWith("cotality:")) return false;
  return !FREE_COTALITY_BASELINE_KEYS.has(adapterKey);
}

export function depthMeterAllowance(tier: InvestorPackageTier): number {
  return INVESTOR_DEPTH_METER_DEFAULTS[tier].maxPaidAdapterCalls;
}
