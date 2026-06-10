import { createHash, randomBytes } from "node:crypto";
import {
  db,
  brokerageWorkspaces,
  brokerageWorkspaceAttachments,
  brokerageWorkspaceShares,
  brokerageBriefRuns,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { stripBriefPayloadForClient } from "./brokerageSiteContext";

export function listingKeyFromAddress(
  address: string,
  mlsId?: string | null,
): string {
  const norm = address.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${norm}|${(mlsId ?? "").trim()}`)
    .digest("hex");
}

function formatCoordOptional(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(6);
}

export async function upsertWorkspaceFromBrief(input: {
  installId: string;
  listingKey: string;
  address: string;
  sourceListingUrl?: string | null;
  runId?: string | null;
  llUuid?: string | null;
  latitude?: number;
  longitude?: number;
  ownerUserId?: string | null;
}) {
  const now = new Date();
  const geo = {
    llUuid: input.llUuid ?? null,
    latitude: formatCoordOptional(input.latitude),
    longitude: formatCoordOptional(input.longitude),
  };
  const base = {
    installId: input.installId,
    listingKey: input.listingKey,
    address: input.address,
    sourceListingUrl: input.sourceListingUrl ?? null,
    ...geo,
    openedAt: now,
    updatedAt: now,
  };

  const conflictSet: Record<string, unknown> = {
    address: input.address,
    sourceListingUrl: input.sourceListingUrl ?? null,
    openedAt: now,
    updatedAt: now,
  };
  if (input.runId) conflictSet.latestRunId = input.runId;
  if (input.llUuid != null) conflictSet.llUuid = input.llUuid;
  if (geo.latitude != null) conflictSet.latitude = geo.latitude;
  if (geo.longitude != null) conflictSet.longitude = geo.longitude;
  if (input.ownerUserId) conflictSet.ownerUserId = input.ownerUserId;

  const insertValues = {
    ...base,
    ...(input.runId ? { latestRunId: input.runId } : {}),
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
  };

  await db
    .insert(brokerageWorkspaces)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [brokerageWorkspaces.installId, brokerageWorkspaces.listingKey],
      set: conflictSet,
    });
}

export async function findWorkspaceByListingKey(
  installId: string,
  listingKey: string,
) {
  const [ws] = await db
    .select({ id: brokerageWorkspaces.id })
    .from(brokerageWorkspaces)
    .where(
      and(
        eq(brokerageWorkspaces.installId, installId),
        eq(brokerageWorkspaces.listingKey, listingKey),
      ),
    )
    .limit(1);
  return ws ?? null;
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
    llUuid: pkg.workspace.llUuid,
    latitude: pkg.workspace.latitude,
    longitude: pkg.workspace.longitude,
    brief: payload ? stripBriefPayloadForClient(payload) : null,
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
