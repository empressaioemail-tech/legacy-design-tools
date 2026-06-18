/**
 * Buy-box teacher — learns from keep/pass verdicts (tenant-private, never pooled).
 */

import { eq } from "drizzle-orm";
import { brokerageInstallClaims, brokerageUserProfiles, db } from "@workspace/db";
import type { Request } from "express";
import { installIdFromRequest } from "./brokerageInstallId";
import {
  getOrCreateBrokerageUserProfile,
  updateBuyBoxProfile,
  type BuyBoxProfile,
} from "./brokerageUserProfile";
import { recordGtmEvent } from "./recordGtmEvent";

export type VerdictAction = "keep" | "pass";

export type DealHistoryEntry = {
  action: VerdictAction;
  parcelId?: string;
  workspaceId?: string;
  address?: string;
  at: string;
};

export type InvestorProfileState = {
  stats: { kept: number; passed: number };
  dealHistory: DealHistoryEntry[];
  thesis?: string | null;
  blindSpots?: string[];
};

const MAX_DEAL_HISTORY = 200;

export async function resolveProfileOwnerId(req: Request): Promise<string | null> {
  const sessionUser = req.session?.requestor?.id?.trim();
  if (sessionUser) return sessionUser;

  const installId = installIdFromRequest(req);
  if (!installId) return null;

  const [claim] = await db
    .select({ ownerUserId: brokerageInstallClaims.ownerUserId })
    .from(brokerageInstallClaims)
    .where(eq(brokerageInstallClaims.installId, installId))
    .limit(1);

  if (claim?.ownerUserId) return claim.ownerUserId;

  return `install:${installId}`;
}

function parseInvestorProfile(raw: unknown): InvestorProfileState {
  const base: InvestorProfileState = {
    stats: { kept: 0, passed: 0 },
    dealHistory: [],
  };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const stats = obj.stats as Record<string, unknown> | undefined;
  if (stats) {
    base.stats = {
      kept: typeof stats.kept === "number" ? stats.kept : 0,
      passed: typeof stats.passed === "number" ? stats.passed : 0,
    };
  }
  if (Array.isArray(obj.dealHistory)) {
    base.dealHistory = obj.dealHistory
      .filter((e) => e && typeof e === "object")
      .map((e) => {
        const row = e as Record<string, unknown>;
        const action = row.action === "pass" ? "pass" : "keep";
        return {
          action,
          parcelId: typeof row.parcelId === "string" ? row.parcelId : undefined,
          workspaceId:
            typeof row.workspaceId === "string" ? row.workspaceId : undefined,
          address: typeof row.address === "string" ? row.address : undefined,
          at: typeof row.at === "string" ? row.at : new Date().toISOString(),
        } satisfies DealHistoryEntry;
      });
  }
  if (typeof obj.thesis === "string") base.thesis = obj.thesis;
  if (Array.isArray(obj.blindSpots)) {
    base.blindSpots = obj.blindSpots.filter((s) => typeof s === "string");
  }
  return base;
}

export function buyBoxFromRow(
  buyBoxJson: unknown,
): Required<Pick<BuyBoxProfile, "capRateFloor" | "rehabPerSf" | "rentSpreadTolerance">> {
  const raw = (buyBoxJson ?? {}) as BuyBoxProfile;
  return {
    capRateFloor: raw.capRateFloor ?? 0.08,
    rehabPerSf: raw.rehabPerSf ?? 35,
    rentSpreadTolerance: raw.rentSpreadTolerance ?? 0.05,
  };
}

export async function readBuyBoxProfile(ownerUserId: string) {
  const row = await getOrCreateBrokerageUserProfile(ownerUserId);
  const investorProfile = parseInvestorProfile(row.investorProfileJson);
  return {
    ownerUserId: row.ownerUserId,
    tenantSlug: row.tenantSlug,
    buyBox: buyBoxFromRow(row.buyBoxJson),
    investorProfile,
    kept: investorProfile.stats.kept,
    passed: investorProfile.stats.passed,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function patchBuyBoxProfile(
  ownerUserId: string,
  buyBox: BuyBoxProfile,
): Promise<void> {
  await updateBuyBoxProfile(ownerUserId, buyBox);
}

export async function recordVerdictAction(input: {
  ownerUserId: string;
  installId: string | null;
  action: VerdictAction;
  parcelId?: string;
  workspaceId?: string;
  address?: string;
}): Promise<{ kept: number; passed: number }> {
  const row = await getOrCreateBrokerageUserProfile(input.ownerUserId);
  const investorProfile = parseInvestorProfile(row.investorProfileJson);

  const entry: DealHistoryEntry = {
    action: input.action,
    parcelId: input.parcelId,
    workspaceId: input.workspaceId,
    address: input.address,
    at: new Date().toISOString(),
  };

  if (input.action === "keep") investorProfile.stats.kept += 1;
  else investorProfile.stats.passed += 1;

  investorProfile.dealHistory = [...investorProfile.dealHistory, entry].slice(
    -MAX_DEAL_HISTORY,
  );

  await db
    .update(brokerageUserProfiles)
    .set({
      investorProfileJson: investorProfile,
      updatedAt: new Date(),
    })
    .where(eq(brokerageUserProfiles.ownerUserId, input.ownerUserId));

  if (input.installId) {
    recordGtmEvent({
      installId: input.installId,
      eventType: input.action === "keep" ? "deal_kept" : "deal_passed",
      sourceSurface: "extension",
      listingKey: input.parcelId ?? input.workspaceId ?? null,
      payload: {
        parcelId: input.parcelId,
        workspaceId: input.workspaceId,
        address: input.address,
      },
    });
  }

  return investorProfile.stats;
}
