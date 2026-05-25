import { eq } from "drizzle-orm";
import { canvaConnections, db } from "@workspace/db";
import { logger } from "../logger";
import { isCanvaConfigured } from "./config";
import { FALLBACK_BRAND_TEMPLATES, fallbackTemplateName } from "./catalog";
import {
  createAutofillJob,
  getAutofillJob,
  uploadAssetFromUrl,
  type CanvaConnectionRow,
} from "./client";
import { resolveRenderableAssetUrl } from "./assets";
import {
  getConnectionForOwner,
  getPushJobRow,
  insertDesignPush,
  updateConnectionTokens,
  updatePushJob,
} from "./store";

const POLL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 90;

function connectionRowToClient(
  row: typeof canvaConnections.$inferSelect,
): CanvaConnectionRow {
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
  };
}

async function failJob(
  jobId: string,
  code: "upload" | "template" | "auth",
  message: string,
): Promise<void> {
  await updatePushJob(jobId, {
    step: "failed",
    progressLabel: message,
    errorCode: code,
    errorMessage: message,
  });
}

export function runCanvaPushJob(params: {
  jobId: string;
  tenantId: string;
  ownerUserId: string;
  baseUrl: string;
}): void {
  void runCanvaPushJobInner(params).catch((err) => {
    logger.error({ err, jobId: params.jobId }, "canva push job crashed");
    void failJob(params.jobId, "upload", "Unexpected error during Canva push");
  });
}

async function runCanvaPushJobInner(params: {
  jobId: string;
  tenantId: string;
  ownerUserId: string;
  baseUrl: string;
}): Promise<void> {
  const row = await getPushJobRow(params.jobId);
  if (!row) return;

  const req = row.request;
  const uploadOnly = req.uploadAssetsOnly ?? false;

  await updatePushJob(params.jobId, {
    step: "uploading",
    progressLabel: "Uploading to Canva…",
  });

  if (!isCanvaConfigured()) {
    await simulateDevPush(params.jobId, row.engagementId, req, uploadOnly);
    return;
  }

  const connRow = await getConnectionForOwner(params.tenantId, params.ownerUserId);
  if (!connRow) {
    await failJob(params.jobId, "auth", "Connect Canva before generating designs");
    return;
  }

  const connection = connectionRowToClient(connRow);
  const onRefresh = async (tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }) => {
    await updateConnectionTokens(connRow.id, tokens);
  };

  const assetIdToCanva = new Map<string, string>();
  try {
    for (const assetId of req.assetIds) {
      const url = await resolveRenderableAssetUrl(assetId, params.baseUrl);
      if (!url) continue;
      const canvaAssetId = await uploadAssetFromUrl(
        connection,
        assetId,
        url,
        onRefresh,
      );
      assetIdToCanva.set(assetId, canvaAssetId);
    }
  } catch (err) {
    await failJob(
      params.jobId,
      "upload",
      err instanceof Error ? err.message : "Asset upload failed",
    );
    return;
  }

  if (uploadOnly) {
    const designUrl = "https://www.canva.com/projects";
    await updatePushJob(params.jobId, {
      step: "ready",
      progressLabel: "Ready — assets in your Canva library",
      designUrl,
      designThumbnailUrl: FALLBACK_BRAND_TEMPLATES[0]?.thumbnailUrl ?? null,
      errorCode: null,
      errorMessage: null,
    });
    await insertDesignPush({
      engagementId: row.engagementId,
      pushJobId: params.jobId,
      templateId: req.templateId,
      templateName: "Upload only",
      status: "ready",
      designUrl,
      sourceAssetIds: req.assetIds,
    });
    return;
  }

  await updatePushJob(params.jobId, {
    step: "creating",
    progressLabel: "Creating design from template…",
  });

  const autofillData: Record<string, unknown> = {};
  for (const [slotKey, value] of Object.entries(req.textFields)) {
    autofillData[slotKey] = { type: "text", text: value };
  }
  for (const [slotKey, assetId] of Object.entries(req.slotMapping)) {
    const canvaId = assetIdToCanva.get(assetId);
    if (canvaId) {
      autofillData[slotKey] = { type: "image", asset_id: canvaId };
    }
  }

  let canvaJobId: string;
  try {
    canvaJobId = await createAutofillJob(
      connection,
      {
        brandTemplateId: req.templateId,
        title: req.textFields.project_name ?? "Client materials",
        data: autofillData,
      },
      onRefresh,
    );
    await updatePushJob(params.jobId, {
      canvaAutofillJobId: canvaJobId,
    });
  } catch (err) {
    await failJob(
      params.jobId,
      "template",
      err instanceof Error ? err.message : "Template autofill failed",
    );
    return;
  }

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_MS);
    const [freshConn] = await db
      .select()
      .from(canvaConnections)
      .where(eq(canvaConnections.id, connRow.id))
      .limit(1);
    if (!freshConn) break;
    const freshClient = connectionRowToClient(freshConn);
    const status = await getAutofillJob(freshClient, canvaJobId, onRefresh);
    if (status.status === "success" && status.designUrl) {
      await updatePushJob(params.jobId, {
        step: "ready",
        progressLabel: "Ready to edit in Canva",
        designUrl: status.designUrl,
        designThumbnailUrl: status.thumbnailUrl ?? null,
        errorCode: null,
        errorMessage: null,
      });
      await insertDesignPush({
        engagementId: row.engagementId,
        pushJobId: params.jobId,
        templateId: req.templateId,
        templateName: fallbackTemplateName(req.templateId),
        status: "ready",
        designUrl: status.designUrl,
        thumbnailUrl: status.thumbnailUrl,
        sourceAssetIds: req.assetIds,
      });
      return;
    }
    if (status.status === "failed") {
      await failJob(
        params.jobId,
        "template",
        status.error ?? "Canva autofill failed",
      );
      return;
    }
  }

  await failJob(params.jobId, "template", "Canva autofill timed out");
}

async function simulateDevPush(
  jobId: string,
  engagementId: string,
  req: {
    templateId: string;
    assetIds: string[];
    uploadAssetsOnly?: boolean;
  },
  uploadOnly: boolean,
): Promise<void> {
  await sleep(400);
  await updatePushJob(jobId, {
    step: "creating",
    progressLabel: uploadOnly
      ? "Adding files to your Canva library…"
      : "Creating design from template…",
  });
  await sleep(500);
  const designUrl = "https://www.canva.com/design/dev-stub";
  await updatePushJob(jobId, {
    step: "ready",
    progressLabel: "Ready to edit in Canva",
    designUrl,
    designThumbnailUrl: FALLBACK_BRAND_TEMPLATES[0]?.thumbnailUrl ?? null,
    errorCode: null,
    errorMessage: null,
  });
  await insertDesignPush({
    engagementId,
    pushJobId: jobId,
    templateId: req.templateId,
    templateName: fallbackTemplateName(req.templateId),
    status: "ready",
    designUrl,
    thumbnailUrl: FALLBACK_BRAND_TEMPLATES[0]?.thumbnailUrl,
    sourceAssetIds: req.assetIds,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
