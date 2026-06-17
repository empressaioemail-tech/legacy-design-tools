/**
 * Tenant-private investor profile keyed by ownerUserId (75i task 6/9).
 */

import { db, brokerageUserProfiles, type BrokeragePackageTier } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  depthMeterAllowance,
  type InvestorPackageTier,
} from "./brokerageTierGate";

export interface BuyBoxProfile {
  capRateFloor?: number;
  rehabPerSf?: number;
  rentSpreadTolerance?: number;
}

export async function getOrCreateBrokerageUserProfile(
  ownerUserId: string,
  tenantSlug = "default",
): Promise<typeof brokerageUserProfiles.$inferSelect> {
  const existing = await db
    .select()
    .from(brokerageUserProfiles)
    .where(eq(brokerageUserProfiles.ownerUserId, ownerUserId))
    .limit(1);

  if (existing[0]) return existing[0];

  const tier: BrokeragePackageTier = "pro";
  const [created] = await db
    .insert(brokerageUserProfiles)
    .values({
      ownerUserId,
      tenantSlug,
      packageTier: tier,
      depthMeterRemaining: depthMeterAllowance(tier),
      buyBoxJson: {
        capRateFloor: 0.08,
        rehabPerSf: 35,
        rentSpreadTolerance: 0.05,
      },
    })
    .returning();

  return created!;
}

export async function updateBuyBoxProfile(
  ownerUserId: string,
  buyBox: BuyBoxProfile,
): Promise<void> {
  const row = await getOrCreateBrokerageUserProfile(ownerUserId);
  await db
    .update(brokerageUserProfiles)
    .set({
      buyBoxJson: { ...(row.buyBoxJson as object), ...buyBox },
      updatedAt: new Date(),
    })
    .where(eq(brokerageUserProfiles.ownerUserId, ownerUserId));
}

export async function appendDialogueTurn(
  ownerUserId: string,
  clip: string,
  turn: { role: "user" | "assistant"; content: string; at: string },
): Promise<void> {
  const row = await getOrCreateBrokerageUserProfile(ownerUserId);
  const dialogue = {
    ...((row.dialogueByClipJson as Record<string, unknown>) ?? {}),
  };
  const thread = Array.isArray(dialogue[clip])
    ? [...(dialogue[clip] as unknown[])]
    : [];
  thread.push(turn);
  dialogue[clip] = thread.slice(-40);
  await db
    .update(brokerageUserProfiles)
    .set({ dialogueByClipJson: dialogue, updatedAt: new Date() })
    .where(eq(brokerageUserProfiles.ownerUserId, ownerUserId));
}

export function packageTierFromProfile(
  row: typeof brokerageUserProfiles.$inferSelect | null,
): InvestorPackageTier | null {
  if (!row?.packageTier) return null;
  const t = row.packageTier as InvestorPackageTier;
  if (t === "free" || t === "pro" || t === "max") return t;
  return null;
}

export async function debitDepthMeter(
  ownerUserId: string,
  units: number,
): Promise<{ ok: boolean; remaining: number }> {
  const row = await getOrCreateBrokerageUserProfile(ownerUserId);
  const remaining = Math.max(0, row.depthMeterRemaining - units);
  await db
    .update(brokerageUserProfiles)
    .set({ depthMeterRemaining: remaining, updatedAt: new Date() })
    .where(eq(brokerageUserProfiles.ownerUserId, ownerUserId));
  return { ok: remaining >= 0, remaining };
}
