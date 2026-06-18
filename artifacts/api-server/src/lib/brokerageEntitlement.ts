/**
 * Install-level entitlements — free brief cap + Pro subscription (08, 75g).
 * Reuses brokerage_wallets as the entitlement store; wallet balance is legacy metering.
 */

import { db, brokerageWallets, brokerageWalletLedger } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { InvestorPackageTier } from "./brokerageTierGate";

export function brokerageFreeBriefsCap(): number {
  const raw = process.env.BROKERAGE_FREE_BRIEFS_CAP?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 3;
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export type EntitlementSnapshot = {
  installId: string;
  freeBriefsUsed: number;
  freeBriefsCap: number;
  freeBriefsRemaining: number;
  subscriptionTier: "free" | "pro" | null;
  subscriptionStatus: "active" | "trialing" | "churned" | null;
  subscriptionPeriodEnd: string | null;
  proActive: boolean;
  balanceCents: number;
};

export function isProSubscriptionActive(row: {
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  subscriptionPeriodEnd: Date | null;
}): boolean {
  if (row.subscriptionTier !== "pro") return false;
  if (row.subscriptionStatus !== "active" && row.subscriptionStatus !== "trialing") {
    return false;
  }
  if (row.subscriptionPeriodEnd && row.subscriptionPeriodEnd.getTime() < Date.now()) {
    return false;
  }
  return true;
}

export function entitlementPackageTier(
  ent: Pick<EntitlementSnapshot, "proActive">,
): InvestorPackageTier | null {
  return ent.proActive ? "pro" : null;
}

async function ensureWalletRow(installId: string) {
  const [existing] = await db
    .select()
    .from(brokerageWallets)
    .where(eq(brokerageWallets.installId, installId))
    .limit(1);
  if (existing) return existing;

  const startRaw = process.env.BROKERAGE_WALLET_START_BALANCE_CENTS?.trim();
  const startCents = startRaw ? Number.parseInt(startRaw, 10) : 0;
  const balanceCents =
    Number.isFinite(startCents) && startCents >= 0 ? startCents : 0;

  const [created] = await db
    .insert(brokerageWallets)
    .values({ installId, balanceCents, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [row] = await db
    .select()
    .from(brokerageWallets)
    .where(eq(brokerageWallets.installId, installId))
    .limit(1);
  return row!;
}

export async function getEntitlementSnapshot(
  installId: string,
): Promise<EntitlementSnapshot> {
  const row = await ensureWalletRow(installId);
  const cap = brokerageFreeBriefsCap();
  const used = row.freeBriefsUsed ?? 0;
  const proActive = isProSubscriptionActive(row);

  return {
    installId,
    freeBriefsUsed: used,
    freeBriefsCap: cap,
    freeBriefsRemaining: Math.max(0, cap - used),
    subscriptionTier: (row.subscriptionTier as "free" | "pro" | null) ?? null,
    subscriptionStatus:
      (row.subscriptionStatus as EntitlementSnapshot["subscriptionStatus"]) ?? null,
    subscriptionPeriodEnd: row.subscriptionPeriodEnd?.toISOString() ?? null,
    proActive,
    balanceCents: row.balanceCents,
  };
}

export type ComputeGateResult =
  | { ok: true; skipped: true; reason: "bypass" }
  | { ok: true; consumed: "free_brief"; freeBriefsRemaining: number }
  | { ok: true; consumed: "wallet"; balanceCents: number }
  | { ok: true; consumed: "pro_subscription" }
  | {
      ok: false;
      reason: "paywall_hit";
      freeBriefsUsed: number;
      freeBriefsCap: number;
      balanceCents: number;
      upgradeCta: "pro_subscription";
    };

export async function assertBriefComputeEntitled(
  installId: string,
  reference?: string,
): Promise<ComputeGateResult> {
  if (process.env.BROKERAGE_WALLET_BYPASS === "1") {
    return { ok: true, skipped: true, reason: "bypass" };
  }

  const row = await ensureWalletRow(installId);
  const cap = brokerageFreeBriefsCap();
  const used = row.freeBriefsUsed ?? 0;

  if (isProSubscriptionActive(row)) {
    return { ok: true, consumed: "pro_subscription" };
  }

  if (used < cap) {
    const nextUsed = used + 1;
    await db
      .update(brokerageWallets)
      .set({ freeBriefsUsed: nextUsed, updatedAt: new Date() })
      .where(eq(brokerageWallets.installId, installId));

    await db.insert(brokerageWalletLedger).values({
      installId,
      amountCents: 0,
      kind: "free_brief",
      reference: reference ?? null,
      balanceAfterCents: row.balanceCents,
    });

    return {
      ok: true,
      consumed: "free_brief",
      freeBriefsRemaining: Math.max(0, cap - nextUsed),
    };
  }

  const costRaw = process.env.BROKERAGE_COMPUTE_COST_CENTS?.trim();
  const cost = costRaw ? Number.parseInt(costRaw, 10) : 100;
  const costCents = Number.isFinite(cost) && cost > 0 ? cost : 100;

  if (row.balanceCents >= costCents) {
    const balanceAfter = row.balanceCents - costCents;
    await db
      .update(brokerageWallets)
      .set({ balanceCents: balanceAfter, updatedAt: new Date() })
      .where(eq(brokerageWallets.installId, installId));

    await db.insert(brokerageWalletLedger).values({
      installId,
      amountCents: -costCents,
      kind: "compute_debit",
      reference: reference ?? null,
      balanceAfterCents: balanceAfter,
    });

    return { ok: true, consumed: "wallet", balanceCents: balanceAfter };
  }

  return {
    ok: false,
    reason: "paywall_hit",
    freeBriefsUsed: used,
    freeBriefsCap: cap,
    balanceCents: row.balanceCents,
    upgradeCta: "pro_subscription",
  };
}

export async function setSubscriptionEntitlement(input: {
  installId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionTier: "free" | "pro";
  subscriptionStatus: "active" | "trialing" | "churned";
  subscriptionPeriodEnd?: Date | null;
}): Promise<EntitlementSnapshot> {
  await ensureWalletRow(input.installId);
  await db
    .update(brokerageWallets)
    .set({
      subscriptionTier: input.subscriptionTier,
      subscriptionStatus: input.subscriptionStatus,
      subscriptionPeriodEnd: input.subscriptionPeriodEnd ?? null,
      stripeCustomerId: input.stripeCustomerId ?? undefined,
      stripeSubscriptionId: input.stripeSubscriptionId ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(brokerageWallets.installId, input.installId));

  return getEntitlementSnapshot(input.installId);
}
