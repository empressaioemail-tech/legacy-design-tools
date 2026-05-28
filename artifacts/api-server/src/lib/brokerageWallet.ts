/**
 * Brokerage wallet — $5 top-up increments, compute debit, auto-refill.
 * Billing rail is simulated in V1 (no Stripe keys in extension).
 */

import { db, brokerageWallets, brokerageWalletLedger } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const BROKERAGE_TOP_UP_INCREMENT_CENTS = 500;

export function brokerageComputeCostCents(): number {
  const raw = process.env.BROKERAGE_COMPUTE_COST_CENTS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
}

export function brokerageWalletBypassPaywall(): boolean {
  return process.env.BROKERAGE_WALLET_BYPASS === "1";
}

export type WalletSnapshot = {
  installId: string;
  balanceCents: number;
  autoRefillEnabled: boolean;
  autoRefillFailedAt: string | null;
};

async function ensureWallet(installId: string) {
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
    .values({
      installId,
      balanceCents,
      autoRefillEnabled: false,
      updatedAt: new Date(),
    })
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

export async function getWalletSnapshot(
  installId: string,
): Promise<WalletSnapshot> {
  const row = await ensureWallet(installId);
  return {
    installId: row.installId,
    balanceCents: row.balanceCents,
    autoRefillEnabled: row.autoRefillEnabled,
    autoRefillFailedAt: row.autoRefillFailedAt?.toISOString() ?? null,
  };
}

async function appendLedger(input: {
  installId: string;
  amountCents: number;
  kind: "top_up" | "compute_debit" | "auto_refill" | "adjustment";
  reference?: string | null;
  balanceAfterCents: number;
}) {
  await db.insert(brokerageWalletLedger).values({
    installId: input.installId,
    amountCents: input.amountCents,
    kind: input.kind,
    reference: input.reference ?? null,
    balanceAfterCents: input.balanceAfterCents,
  });
}

export async function topUpWallet(
  installId: string,
  amountCents: number = BROKERAGE_TOP_UP_INCREMENT_CENTS,
  kind: "top_up" | "auto_refill" = "top_up",
): Promise<WalletSnapshot> {
  if (amountCents <= 0 || amountCents % BROKERAGE_TOP_UP_INCREMENT_CENTS !== 0) {
    throw new Error(
      `Top-up must be a positive multiple of ${BROKERAGE_TOP_UP_INCREMENT_CENTS} cents`,
    );
  }

  const row = await ensureWallet(installId);
  const balanceAfter = row.balanceCents + amountCents;

  const [updated] = await db
    .update(brokerageWallets)
    .set({
      balanceCents: balanceAfter,
      autoRefillFailedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(brokerageWallets.installId, installId))
    .returning();

  await appendLedger({
    installId,
    amountCents,
    kind,
    balanceAfterCents: balanceAfter,
  });

  return {
    installId,
    balanceCents: updated!.balanceCents,
    autoRefillEnabled: updated!.autoRefillEnabled,
    autoRefillFailedAt: null,
  };
}

export async function setWalletAutoRefill(
  installId: string,
  enabled: boolean,
): Promise<WalletSnapshot> {
  await ensureWallet(installId);
  const [updated] = await db
    .update(brokerageWallets)
    .set({ autoRefillEnabled: enabled, updatedAt: new Date() })
    .where(eq(brokerageWallets.installId, installId))
    .returning();
  return {
    installId,
    balanceCents: updated!.balanceCents,
    autoRefillEnabled: updated!.autoRefillEnabled,
    autoRefillFailedAt: updated!.autoRefillFailedAt?.toISOString() ?? null,
  };
}

async function tryAutoRefill(installId: string): Promise<boolean> {
  const row = await ensureWallet(installId);
  if (!row.autoRefillEnabled || row.autoRefillFailedAt) return false;

  if (process.env.BROKERAGE_WALLET_AUTO_REFILL_FAIL === "1") {
    await db
      .update(brokerageWallets)
      .set({ autoRefillFailedAt: new Date(), updatedAt: new Date() })
      .where(eq(brokerageWallets.installId, installId));
    return false;
  }

  try {
    await topUpWallet(
      installId,
      BROKERAGE_TOP_UP_INCREMENT_CENTS,
      "auto_refill",
    );
    return true;
  } catch (err) {
    logger.warn({ err, installId }, "brokerage: auto-refill failed");
    await db
      .update(brokerageWallets)
      .set({ autoRefillFailedAt: new Date(), updatedAt: new Date() })
      .where(eq(brokerageWallets.installId, installId));
    return false;
  }
}

export type DebitResult =
  | { ok: true; balanceCents: number }
  | { ok: false; reason: "insufficient_balance"; balanceCents: number };

export async function debitCompute(
  installId: string,
  reference?: string,
): Promise<DebitResult> {
  if (brokerageWalletBypassPaywall()) {
    return { ok: true, balanceCents: Number.MAX_SAFE_INTEGER };
  }

  const cost = brokerageComputeCostCents();
  let row = await ensureWallet(installId);

  if (row.balanceCents < cost) {
    const refilled = await tryAutoRefill(installId);
    if (refilled) {
      row = (await db
        .select()
        .from(brokerageWallets)
        .where(eq(brokerageWallets.installId, installId))
        .limit(1))[0]!;
    }
  }

  if (row.balanceCents < cost) {
    return { ok: false, reason: "insufficient_balance", balanceCents: row.balanceCents };
  }

  const balanceAfter = row.balanceCents - cost;
  await db
    .update(brokerageWallets)
    .set({ balanceCents: balanceAfter, updatedAt: new Date() })
    .where(eq(brokerageWallets.installId, installId));

  await appendLedger({
    installId,
    amountCents: -cost,
    kind: "compute_debit",
    reference: reference ?? null,
    balanceAfterCents: balanceAfter,
  });

  if (balanceAfter === 0 && row.autoRefillEnabled && !row.autoRefillFailedAt) {
    void tryAutoRefill(installId);
  }

  return { ok: true, balanceCents: balanceAfter };
}

export async function assertComputeAllowed(
  installId: string | null,
): Promise<DebitResult | { ok: true; skipped: true }> {
  if (!installId || brokerageWalletBypassPaywall()) {
    return { ok: true, skipped: true };
  }
  return debitCompute(installId);
}
