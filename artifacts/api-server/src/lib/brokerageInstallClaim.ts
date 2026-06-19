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

export async function listClaimedInstallIdsForUser(
  ownerUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({ installId: brokerageInstallClaims.installId })
    .from(brokerageInstallClaims)
    .where(eq(brokerageInstallClaims.ownerUserId, ownerUserId));
  return rows.map((row) => row.installId);
}

/** Whether a stored brief run may be used by the current caller. */
export function briefRunAccessibleToCaller(input: {
  run: { installId: string | null; ownerUserId: string | null };
  requestInstallId: string | null;
  serviceCaller: boolean;
  ownerUserId: string | null;
  claimedInstallIds: ReadonlySet<string>;
}): boolean {
  if (input.serviceCaller) return true;

  if (input.ownerUserId) {
    if (input.run.ownerUserId === input.ownerUserId) return true;
    if (input.run.installId && input.claimedInstallIds.has(input.run.installId)) {
      return true;
    }
    if (
      input.requestInstallId &&
      input.run.installId === input.requestInstallId
    ) {
      return true;
    }
    return false;
  }

  if (
    input.requestInstallId &&
    input.run.installId &&
    input.run.installId !== input.requestInstallId
  ) {
    return false;
  }
  return true;
}
