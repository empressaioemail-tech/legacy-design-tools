import { and, desc, eq } from "drizzle-orm";
import {
  collateralExportJobs,
  collateralExports,
  collateralMeteringEvents,
  db,
  type CollateralExportRequestJson,
} from "@workspace/db";
import type { CollateralExportJob, CollateralExportRecord } from "./wireTypes";

export function toExportJobWire(
  row: typeof collateralExportJobs.$inferSelect,
): CollateralExportJob {
  const job: CollateralExportJob = {
    jobId: row.id,
    step: row.step as CollateralExportJob["step"],
    progressLabel: row.progressLabel,
    downloadUrl: row.downloadUrl ?? undefined,
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    creditsEstimated: row.creditsEstimated ?? undefined,
    creditsActual: row.creditsActual ?? undefined,
  };
  if (row.errorCode && row.errorMessage) {
    job.error = {
      code: row.errorCode as "assets" | "placid" | "config",
      message: row.errorMessage,
    };
  }
  return job;
}

export async function createExportJob(params: {
  engagementId: string;
  tenantId: string;
  request: CollateralExportRequestJson;
  creditsEstimated: number;
}): Promise<string> {
  const [row] = await db
    .insert(collateralExportJobs)
    .values({
      engagementId: params.engagementId,
      tenantId: params.tenantId,
      step: "preparing",
      progressLabel: "Preparing export…",
      request: params.request,
      creditsEstimated: params.creditsEstimated,
      provider: "placid",
    })
    .returning({ id: collateralExportJobs.id });
  return row!.id;
}

export async function updateExportJob(
  jobId: string,
  patch: Partial<{
    step: string;
    progressLabel: string;
    downloadUrl: string | null;
    thumbnailUrl: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    placidPdfId: string | null;
    creditsActual: number | null;
  }>,
): Promise<void> {
  await db
    .update(collateralExportJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(collateralExportJobs.id, jobId));
}

export async function getExportJobRow(jobId: string) {
  const [row] = await db
    .select()
    .from(collateralExportJobs)
    .where(eq(collateralExportJobs.id, jobId))
    .limit(1);
  return row ?? null;
}

export async function listCollateralExports(
  engagementId: string,
): Promise<CollateralExportRecord[]> {
  const rows = await db
    .select()
    .from(collateralExports)
    .where(eq(collateralExports.engagementId, engagementId))
    .orderBy(desc(collateralExports.createdAt));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    templateName: row.templateName,
    status: row.status as CollateralExportRecord["status"],
    thumbnailUrl: row.thumbnailUrl ?? undefined,
    downloadUrl: row.downloadUrl ?? undefined,
    sourceAssetIds: row.sourceAssetIds ?? [],
    creditsCharged: row.creditsCharged ?? undefined,
  }));
}

export async function insertCollateralExport(params: {
  engagementId: string;
  exportJobId: string;
  templatePackId: string;
  templateName: string;
  status: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
  sourceAssetIds: string[];
  creditsCharged?: number;
}): Promise<void> {
  await db.insert(collateralExports).values({
    engagementId: params.engagementId,
    exportJobId: params.exportJobId,
    templatePackId: params.templatePackId,
    templateName: params.templateName,
    status: params.status,
    downloadUrl: params.downloadUrl ?? null,
    thumbnailUrl: params.thumbnailUrl ?? null,
    sourceAssetIds: params.sourceAssetIds,
    creditsCharged: params.creditsCharged ?? null,
  });
}

export async function recordMeteringEvent(params: {
  tenantId: string;
  engagementId: string;
  exportJobId: string;
  units: number;
}): Promise<void> {
  await db.insert(collateralMeteringEvents).values({
    tenantId: params.tenantId,
    engagementId: params.engagementId,
    exportJobId: params.exportJobId,
    units: params.units,
    provider: "placid",
  });
}
