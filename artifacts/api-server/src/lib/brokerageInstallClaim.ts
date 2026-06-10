/**
 * Attach anonymous extension install history to exactly one user on sign-in.
 * ADR-005/017: never pool into shared/public assets.
 */

import { and, eq, isNull } from "drizzle-orm";
import {
  brokerageBriefRuns,
  brokerageInstallClaims,
  brokerageWorkspaces,
  db,
} from "@workspace/db";
import { logger } from "./logger";

export type ClaimInstallResult =
  | { ok: true; claimed: boolean; installId: string; ownerUserId: string }
  | { ok: false; error: "install_already_claimed"; claimedBy: string };

export async function claimInstallHistoryForUser(
  installId: string,
  ownerUserId: string,
): Promise<ClaimInstallResult> {
  const trimmed = installId.trim();
  if (!trimmed) {
    return { ok: true, claimed: false, installId: trimmed, ownerUserId };
  }

  const [existing] = await db
    .select()
    .from(brokerageInstallClaims)
    .where(eq(brokerageInstallClaims.installId, trimmed))
    .limit(1);

  if (existing) {
    if (existing.ownerUserId === ownerUserId) {
      return {
        ok: true,
        claimed: false,
        installId: trimmed,
        ownerUserId,
      };
    }
    return {
      ok: false,
      error: "install_already_claimed",
      claimedBy: existing.ownerUserId,
    };
  }

  await db.transaction(async (tx) => {
    await tx.insert(brokerageInstallClaims).values({
      installId: trimmed,
      ownerUserId,
    });

    await tx
      .update(brokerageWorkspaces)
      .set({ ownerUserId })
      .where(
        and(
          eq(brokerageWorkspaces.installId, trimmed),
          isNull(brokerageWorkspaces.ownerUserId),
        ),
      );

    await tx
      .update(brokerageBriefRuns)
      .set({ ownerUserId })
      .where(
        and(
          eq(brokerageBriefRuns.installId, trimmed),
          isNull(brokerageBriefRuns.ownerUserId),
        ),
      );
  });

  logger.info(
    { installId: trimmed, ownerUserId },
    "brokerage install history claimed for user",
  );

  return { ok: true, claimed: true, installId: trimmed, ownerUserId };
}

export async function listBriefRunsForUser(ownerUserId: string) {
  return db
    .select()
    .from(brokerageBriefRuns)
    .where(eq(brokerageBriefRuns.ownerUserId, ownerUserId));
}
