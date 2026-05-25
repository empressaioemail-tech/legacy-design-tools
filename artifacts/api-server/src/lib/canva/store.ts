import { and, desc, eq } from "drizzle-orm";
import {
  canvaConnections,
  canvaDesignPushes,
  canvaOauthStates,
  canvaPushJobs,
  db,
  type CanvaPushRequestJson,
} from "@workspace/db";
import type { CanvaConnectionStatus, CanvaDesignPush, CanvaPushJob } from "./wireTypes";

export function sessionOwnerId(requestorId: string | undefined): string {
  return requestorId ?? "default-user";
}

export async function getConnectionForOwner(
  tenantId: string,
  ownerUserId: string,
): Promise<typeof canvaConnections.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(canvaConnections)
    .where(
      and(
        eq(canvaConnections.tenantId, tenantId),
        eq(canvaConnections.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function connectionStatusForOwner(
  tenantId: string,
  ownerUserId: string,
): Promise<CanvaConnectionStatus> {
  const row = await getConnectionForOwner(tenantId, ownerUserId);
  if (!row) {
    return { state: "disconnected" };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { state: "expired", displayName: row.displayName };
  }
  return {
    state: "connected",
    displayName: row.displayName,
    avatarUrl: row.avatarUrl ?? undefined,
    connectedAt: row.connectedAt.toISOString(),
  };
}

export async function upsertConnection(params: {
  tenantId: string;
  ownerUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  displayName: string;
  avatarUrl?: string;
}): Promise<void> {
  const existing = await getConnectionForOwner(params.tenantId, params.ownerUserId);
  if (existing) {
    await db
      .update(canvaConnections)
      .set({
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        expiresAt: params.expiresAt,
        displayName: params.displayName,
        avatarUrl: params.avatarUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(canvaConnections.id, existing.id));
    return;
  }
  await db.insert(canvaConnections).values({
    tenantId: params.tenantId,
    ownerUserId: params.ownerUserId,
    accessToken: params.accessToken,
    refreshToken: params.refreshToken,
    expiresAt: params.expiresAt,
    displayName: params.displayName,
    avatarUrl: params.avatarUrl ?? null,
  });
}

export async function deleteConnection(
  tenantId: string,
  ownerUserId: string,
): Promise<void> {
  await db
    .delete(canvaConnections)
    .where(
      and(
        eq(canvaConnections.tenantId, tenantId),
        eq(canvaConnections.ownerUserId, ownerUserId),
      ),
    );
}

export async function saveOAuthState(params: {
  state: string;
  codeVerifier: string;
  ownerUserId: string;
  tenantId: string;
}): Promise<void> {
  await db.insert(canvaOauthStates).values(params);
}

export async function consumeOAuthState(
  state: string,
): Promise<{ codeVerifier: string; ownerUserId: string; tenantId: string } | null> {
  const [row] = await db
    .select()
    .from(canvaOauthStates)
    .where(eq(canvaOauthStates.state, state))
    .limit(1);
  if (!row) return null;
  await db.delete(canvaOauthStates).where(eq(canvaOauthStates.state, state));
  return {
    codeVerifier: row.codeVerifier,
    ownerUserId: row.ownerUserId,
    tenantId: row.tenantId,
  };
}

export async function updateConnectionTokens(
  connectionId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
): Promise<void> {
  await db
    .update(canvaConnections)
    .set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(canvaConnections.id, connectionId));
}

export function toPushJobWire(row: typeof canvaPushJobs.$inferSelect): CanvaPushJob {
  const job: CanvaPushJob = {
    jobId: row.id,
    step: row.step as CanvaPushJob["step"],
    progressLabel: row.progressLabel,
    designUrl: row.designUrl ?? undefined,
    designThumbnailUrl: row.designThumbnailUrl ?? undefined,
  };
  if (row.errorCode && row.errorMessage) {
    job.error = {
      code: row.errorCode as "upload" | "template" | "auth",
      message: row.errorMessage,
    };
  }
  return job;
}

export async function createPushJob(params: {
  engagementId: string;
  request: CanvaPushRequestJson;
}): Promise<string> {
  const [row] = await db
    .insert(canvaPushJobs)
    .values({
      engagementId: params.engagementId,
      step: "preparing",
      progressLabel: "Preparing assets…",
      request: params.request,
    })
    .returning({ id: canvaPushJobs.id });
  return row!.id;
}

export async function updatePushJob(
  jobId: string,
  patch: Partial<{
    step: string;
    progressLabel: string;
    designUrl: string | null;
    designThumbnailUrl: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    canvaAutofillJobId: string | null;
  }>,
): Promise<void> {
  await db
    .update(canvaPushJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(canvaPushJobs.id, jobId));
}

export async function getPushJobRow(jobId: string) {
  const [row] = await db
    .select()
    .from(canvaPushJobs)
    .where(eq(canvaPushJobs.id, jobId))
    .limit(1);
  return row ?? null;
}

export async function listDesignPushes(
  engagementId: string,
): Promise<CanvaDesignPush[]> {
  const rows = await db
    .select()
    .from(canvaDesignPushes)
    .where(eq(canvaDesignPushes.engagementId, engagementId))
    .orderBy(desc(canvaDesignPushes.createdAt));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    templateName: row.templateName,
    status: row.status as CanvaDesignPush["status"],
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    designUrl: row.designUrl ?? undefined,
    sourceAssetIds: row.sourceAssetIds ?? [],
  }));
}

export async function insertDesignPush(params: {
  engagementId: string;
  pushJobId: string;
  templateId: string;
  templateName: string;
  status: string;
  thumbnailUrl?: string;
  designUrl?: string;
  sourceAssetIds: string[];
}): Promise<void> {
  await db.insert(canvaDesignPushes).values({
    engagementId: params.engagementId,
    pushJobId: params.pushJobId,
    templateId: params.templateId,
    templateName: params.templateName,
    status: params.status,
    thumbnailUrl: params.thumbnailUrl ?? null,
    designUrl: params.designUrl ?? null,
    sourceAssetIds: params.sourceAssetIds,
  });
}
