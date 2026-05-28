import { createHash, randomBytes } from "node:crypto";
import {
  db,
  brokerageWorkspaces,
  brokerageWorkspaceAttachments,
  brokerageWorkspaceShares,
  brokerageBriefRuns,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

export function listingKeyFromAddress(
  address: string,
  mlsId?: string | null,
): string {
  const norm = address.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${norm}|${(mlsId ?? "").trim()}`)
    .digest("hex");
}

export async function upsertWorkspaceFromBrief(input: {
  installId: string;
  listingKey: string;
  address: string;
  sourceListingUrl?: string | null;
  runId?: string | null;
}) {
  const now = new Date();
  const base = {
    installId: input.installId,
    listingKey: input.listingKey,
    address: input.address,
    sourceListingUrl: input.sourceListingUrl ?? null,
    openedAt: now,
    updatedAt: now,
  };

  if (input.runId) {
    await db
      .insert(brokerageWorkspaces)
      .values({ ...base, latestRunId: input.runId })
      .onConflictDoUpdate({
        target: [brokerageWorkspaces.installId, brokerageWorkspaces.listingKey],
        set: {
          address: input.address,
          sourceListingUrl: input.sourceListingUrl ?? null,
          latestRunId: input.runId,
          openedAt: now,
          updatedAt: now,
        },
      });
    return;
  }

  await db
    .insert(brokerageWorkspaces)
    .values(base)
    .onConflictDoUpdate({
      target: [brokerageWorkspaces.installId, brokerageWorkspaces.listingKey],
      set: {
        address: input.address,
        sourceListingUrl: input.sourceListingUrl ?? null,
        openedAt: now,
        updatedAt: now,
      },
    });
}

export async function touchWorkspaceOpen(
  installId: string,
  workspaceId: string,
) {
  const now = new Date();
  await db
    .update(brokerageWorkspaces)
    .set({ openedAt: now, updatedAt: now })
    .where(
      and(
        eq(brokerageWorkspaces.id, workspaceId),
        eq(brokerageWorkspaces.installId, installId),
      ),
    );
}

export async function loadWorkspacePackage(workspaceId: string) {
  const [ws] = await db
    .select()
    .from(brokerageWorkspaces)
    .where(eq(brokerageWorkspaces.id, workspaceId))
    .limit(1);
  if (!ws) return null;

  const attachments = await db
    .select()
    .from(brokerageWorkspaceAttachments)
    .where(eq(brokerageWorkspaceAttachments.workspaceId, workspaceId))
    .orderBy(desc(brokerageWorkspaceAttachments.createdAt));

  let briefRun: (typeof brokerageBriefRuns.$inferSelect) | null = null;
  if (ws.latestRunId) {
    const [run] = await db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.id, ws.latestRunId))
      .limit(1);
    briefRun = run ?? null;
  }

  return { workspace: ws, attachments, briefRun };
}

export function serializeWorkspacePackage(
  pkg: NonNullable<Awaited<ReturnType<typeof loadWorkspacePackage>>>,
) {
  const payload = pkg.briefRun?.payloadJson as
    | Record<string, unknown>
    | undefined;

  return {
    id: pkg.workspace.id,
    listingKey: pkg.workspace.listingKey,
    address: pkg.workspace.address,
    sourceListingUrl: pkg.workspace.sourceListingUrl,
    openedAt: pkg.workspace.openedAt.toISOString(),
    updatedAt: pkg.workspace.updatedAt.toISOString(),
    latestRunId: pkg.workspace.latestRunId,
    brief: payload ?? null,
    attachments: pkg.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      uri: a.uri,
      body: a.body,
      title: a.title,
      createdByInstallId: a.createdByInstallId,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export async function createWorkspaceShare(input: {
  workspaceId: string;
  ownerInstallId: string;
  collaboratorInstallId?: string | null;
}) {
  const shareToken = randomBytes(24).toString("base64url");
  const [share] = await db
    .insert(brokerageWorkspaceShares)
    .values({
      workspaceId: input.workspaceId,
      ownerInstallId: input.ownerInstallId,
      shareToken,
      collaboratorInstallId: input.collaboratorInstallId ?? null,
    })
    .returning();
  return share!;
}

export async function resolveShareByToken(shareToken: string) {
  const [share] = await db
    .select()
    .from(brokerageWorkspaceShares)
    .where(
      and(
        eq(brokerageWorkspaceShares.shareToken, shareToken),
        isNull(brokerageWorkspaceShares.revokedAt),
      ),
    )
    .limit(1);
  if (!share) return null;
  const pkg = await loadWorkspacePackage(share.workspaceId);
  if (!pkg) return null;
  return { share, package: pkg };
}
