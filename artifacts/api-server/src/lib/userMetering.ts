/**
 * Per-user usage metering for self-serve tier (rail-quiet — count only).
 */

import { and, eq, sql } from "drizzle-orm";
import { db, userUsageMetering } from "@workspace/db";

function utcPeriodStart(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function readDailyLimit(): number {
  const raw = process.env["CORTEX_USER_DAILY_API_LIMIT"]?.trim();
  if (!raw) return 5000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

export async function incrementUserMeter(
  ownerUserId: string,
  meterKey: string,
  delta = 1,
): Promise<number> {
  const periodStart = utcPeriodStart();
  const [row] = await db
    .insert(userUsageMetering)
    .values({
      ownerUserId,
      meterKey,
      periodStart,
      count: delta,
    })
    .onConflictDoUpdate({
      target: [
        userUsageMetering.ownerUserId,
        userUsageMetering.meterKey,
        userUsageMetering.periodStart,
      ],
      set: {
        count: sql`${userUsageMetering.count} + ${delta}`,
      },
    })
    .returning({ count: userUsageMetering.count });
  return row?.count ?? delta;
}

export type UserRateLimitResult =
  | { ok: true; used: number; limit: number }
  | { ok: false; used: number; limit: number; error: "rate_limit_exceeded" };

export async function assertUserApiRateAllowed(
  ownerUserId: string,
): Promise<UserRateLimitResult> {
  const limit = readDailyLimit();
  const periodStart = utcPeriodStart();
  const [row] = await db
    .select({ count: userUsageMetering.count })
    .from(userUsageMetering)
    .where(
      and(
        eq(userUsageMetering.ownerUserId, ownerUserId),
        eq(userUsageMetering.meterKey, "api_requests"),
        eq(userUsageMetering.periodStart, periodStart),
      ),
    )
    .limit(1);
  const used = row?.count ?? 0;
  if (used >= limit) {
    return { ok: false, used, limit, error: "rate_limit_exceeded" };
  }
  const next = await incrementUserMeter(ownerUserId, "api_requests", 1);
  return { ok: true, used: next, limit };
}
