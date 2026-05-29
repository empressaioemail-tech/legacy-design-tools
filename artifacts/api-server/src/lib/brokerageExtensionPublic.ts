/**
 * Chrome Web Store extension public client — rate limits and Layer-1 access.
 *
 * Public installs use BROKERAGE_EXTENSION_PUBLIC_KEY with no wallet; limits
 * are enforced per X-Hauska-Install-Id via gtm_events counts.
 */

import type { NextFunction, Request, Response } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { getPilotCoverageTier } from "@workspace/codes";
import { db, gtmEvents } from "@workspace/db";
import { isExtensionPublicClient } from "../middlewares/brokerageAuth";

export const EXTENSION_PUBLIC_CLIENT_TIER = "extension_public";

/** Neon-warmed Central TX pilots (code_atoms in LDT) beyond JURISDICTIONS registry. */
export const EXTENSION_PUBLIC_PILOT_JURISDICTION_KEYS = [
  "round_rock_tx",
  "austin_tx",
  "hutto_tx",
  "georgetown_tx",
  "new_braunfels_tx",
  "leander_tx",
] as const;

export function extensionPublicBriefsPerDay(): number {
  return readPositiveIntEnv("BROKERAGE_EXTENSION_PUBLIC_BRIEFS_PER_DAY", 5);
}

export function extensionPublicResearchTurnsPerDay(): number {
  return readPositiveIntEnv("BROKERAGE_EXTENSION_PUBLIC_RESEARCH_TURNS_PER_DAY", 20);
}

export function extensionPublicGlobalBriefsPerDay(): number {
  return readPositiveIntEnv("BROKERAGE_EXTENSION_PUBLIC_GLOBAL_BRIEFS_PER_DAY", 10000);
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function countGtmEventsSince(
  eventType: string,
  since: Date,
  filter?: { installId?: string; clientTier?: string },
): Promise<number> {
  const conditions = [
    eq(gtmEvents.eventType, eventType),
    gte(gtmEvents.createdAt, since),
  ];
  if (filter?.installId) {
    conditions.push(eq(gtmEvents.installId, filter.installId));
  }
  if (filter?.clientTier) {
    conditions.push(
      sql`${gtmEvents.payloadJson} ->> 'clientTier' = ${filter.clientTier}`,
    );
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gtmEvents)
    .where(and(...conditions));
  return row?.count ?? 0;
}

export type ExtensionPublicRateLimitResult =
  | { ok: true }
  | {
      ok: false;
      scope: "install" | "global";
      limit: number;
      used: number;
      eventType: string;
    };

export async function assertExtensionPublicBriefAllowed(
  installId: string,
): Promise<ExtensionPublicRateLimitResult> {
  const since = startOfUtcDay();
  const perInstallLimit = extensionPublicBriefsPerDay();
  const globalLimit = extensionPublicGlobalBriefsPerDay();

  const installCount = await countGtmEventsSince("brief_completed", since, {
    installId,
    clientTier: EXTENSION_PUBLIC_CLIENT_TIER,
  });
  if (installCount >= perInstallLimit) {
    return {
      ok: false,
      scope: "install",
      limit: perInstallLimit,
      used: installCount,
      eventType: "brief_completed",
    };
  }

  const globalCount = await countGtmEventsSince("brief_completed", since, {
    clientTier: EXTENSION_PUBLIC_CLIENT_TIER,
  });
  if (globalCount >= globalLimit) {
    return {
      ok: false,
      scope: "global",
      limit: globalLimit,
      used: globalCount,
      eventType: "brief_completed",
    };
  }

  return { ok: true };
}

export async function assertExtensionPublicResearchChatAllowed(
  installId: string,
): Promise<ExtensionPublicRateLimitResult> {
  const since = startOfUtcDay();
  const limit = extensionPublicResearchTurnsPerDay();
  const used = await countGtmEventsSince("research_chat_turn", since, {
    installId,
    clientTier: EXTENSION_PUBLIC_CLIENT_TIER,
  });
  if (used >= limit) {
    return {
      ok: false,
      scope: "install",
      limit,
      used,
      eventType: "research_chat_turn",
    };
  }
  return { ok: true };
}

export function assertExtensionPublicJurisdictionAllowed(
  jurisdictionKey: string | null,
): { ok: true } | { ok: false; message: string; jurisdiction: string | null } {
  if (!jurisdictionKey) {
    return {
      ok: false,
      message:
        "This address is outside the free Property Brief pilot. Create an account for full coverage.",
      jurisdiction: null,
    };
  }

  const tier = getPilotCoverageTier(jurisdictionKey);
  const inPilotList = (
    EXTENSION_PUBLIC_PILOT_JURISDICTION_KEYS as readonly string[]
  ).includes(jurisdictionKey);

  if (tier === "neon" || inPilotList) {
    return { ok: true };
  }

  if (tier === "blocked_partnership") {
    return {
      ok: false,
      message:
        "Municipal code for this city is not yet available in Property Brief.",
      jurisdiction: jurisdictionKey,
    };
  }

  return {
    ok: false,
    message:
      "Free Property Brief covers selected Central Texas cities with loaded code data. This jurisdiction is not in the free pilot yet.",
    jurisdiction: jurisdictionKey,
  };
}

export function gtmPayloadWithClientTier(
  req: Request,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!isExtensionPublicClient(req)) return payload;
  return { ...payload, clientTier: EXTENSION_PUBLIC_CLIENT_TIER };
}

export function sendExtensionPublicRateLimitResponse(
  res: Response,
  limit: ExtensionPublicRateLimitResult & { ok: false },
): void {
  const noun =
    limit.eventType === "research_chat_turn" ? "research chat turns" : "briefs";
  const scopeMsg =
    limit.scope === "global"
      ? "Public Property Brief daily capacity reached. Try again tomorrow."
      : `Daily limit of ${limit.limit} ${noun} reached for this install. Try again tomorrow or create an account for unlimited access.`;

  res.status(429).json({
    error: "rate_limit_exceeded",
    message: scopeMsg,
    clientTier: EXTENSION_PUBLIC_CLIENT_TIER,
    limit: limit.limit,
    used: limit.used,
    scope: limit.scope,
    eventType: limit.eventType,
  });
}

export function sendAccountUpgradeRequired(res: Response): void {
  res.status(403).json({
    error: "account_upgrade_required",
    message:
      "This feature requires a Hauska account. Install the extension with an operator key or sign up when accounts launch.",
    clientTier: EXTENSION_PUBLIC_CLIENT_TIER,
  });
}

/** Blocks wallet, workspace (except shared read), share, and encumbrance routes. */
export function requireBrokerageDevClient(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isExtensionPublicClient(req)) {
    sendAccountUpgradeRequired(res);
    return;
  }
  next();
}
