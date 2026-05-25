/**
 * Canva Connect — live API via @workspace/api-client-react.
 */
import {
  ApiError,
  customFetch,
  disconnectCanva,
  getCanvaConnection,
  getCanvaPushJob,
  listCanvaBrandTemplates,
  listEngagementCanvaAssets,
  listEngagementCanvaDesigns,
  startCanvaOAuth,
  startEngagementCanvaPush,
  type CanvaBrandTemplate as ApiCanvaBrandTemplate,
  type CanvaConnectionStatus as ApiCanvaConnectionStatus,
  type CanvaDesignPush as ApiCanvaDesignPush,
  type CanvaPushJob as ApiCanvaPushJob,
  type CanvaPushRequest as ApiCanvaPushRequest,
  type CanvaSelectableAsset as ApiCanvaSelectableAsset,
} from "@workspace/api-client-react";
import type {
  CanvaBrandTemplate,
  CanvaConnectionStatus,
  CanvaDesignPush,
  CanvaIntegrationService,
  CanvaPushJob,
  CanvaPushRequest,
  CanvaSelectableAsset,
} from "./types";

function mapConnection(status: ApiCanvaConnectionStatus): CanvaConnectionStatus {
  return status as CanvaConnectionStatus;
}

function mapAsset(a: ApiCanvaSelectableAsset): CanvaSelectableAsset {
  return {
    id: a.id,
    kind: a.kind,
    label: a.label,
    fileType: a.fileType,
    thumbnailUrl: a.thumbnailUrl,
    exportable: a.exportable,
    disabledReason: a.disabledReason,
    sourceTab: a.sourceTab,
  };
}

function mapTemplate(t: ApiCanvaBrandTemplate): CanvaBrandTemplate {
  return {
    id: t.id,
    name: t.name,
    thumbnailUrl: t.thumbnailUrl,
    tags: t.tags,
    pageCount: t.pageCount,
    slots: t.slots.map((s) => {
      if (s.type === "text") {
        return {
          key: s.key,
          type: "text" as const,
          label: s.label,
          defaultValue: s.defaultValue,
        };
      }
      return {
        key: s.key,
        type: "image" as const,
        label: s.label,
        accepts: s.accepts,
      };
    }),
  };
}

function mapDesign(d: ApiCanvaDesignPush): CanvaDesignPush {
  return {
    id: d.id,
    createdAt: d.createdAt,
    templateName: d.templateName,
    status: d.status,
    thumbnailUrl: d.thumbnailUrl,
    designUrl: d.designUrl,
    sourceAssetIds: d.sourceAssetIds,
  };
}

function mapJob(j: ApiCanvaPushJob): CanvaPushJob {
  return {
    jobId: j.jobId,
    step: j.step,
    progressLabel: j.progressLabel,
    designUrl: j.designUrl,
    designThumbnailUrl: j.designThumbnailUrl,
    error: j.error,
  };
}

export function createApiCanvaIntegrationService(): CanvaIntegrationService {
  return {
    async getConnectionStatus() {
      const status = await getCanvaConnection();
      return mapConnection(status);
    },

    async listBrandTemplates() {
      const list = await listCanvaBrandTemplates();
      return Array.isArray(list) ? list.map(mapTemplate) : [];
    },

    async listEngagementAssets(engagementId) {
      const list = await listEngagementCanvaAssets(engagementId);
      return Array.isArray(list) ? list.map(mapAsset) : [];
    },

    async listEngagementDesigns(engagementId) {
      const list = await listEngagementCanvaDesigns(engagementId);
      return Array.isArray(list) ? list.map(mapDesign) : [];
    },

    async startPush(request: CanvaPushRequest) {
      const body: ApiCanvaPushRequest = {
        engagementId: request.engagementId,
        templateId: request.templateId,
        assetIds: request.assetIds,
        slotMapping: request.slotMapping,
        textFields: request.textFields,
        uploadAssetsOnly: request.uploadAssetsOnly,
      };
      const res = await startEngagementCanvaPush(request.engagementId, body);
      return { jobId: res.jobId };
    },

    async getPushJob(jobId) {
      const job = await getCanvaPushJob(jobId);
      return mapJob(job);
    },
  };
}

function formatConnectError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return (
        "Canva API not found (HTTP 404). Start local api-server with " +
        "`pnpm --filter @workspace/api-server run dev:local` on port 8080 — " +
        "not `run dev` (Cloud Run proxy)."
      );
    }
    if (err.status === 503) {
      return (
        String(err.data && typeof err.data === "object" && "error" in err.data
          ? (err.data as { error?: string }).error
          : err.message) ||
        "Canva OAuth is not configured on the API server."
      );
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to connect Canva";
}

async function tryDevConnect(): Promise<void> {
  await customFetch<{ state: string; displayName: string; connectedAt: string }>(
    "/api/canva/oauth/dev-connect",
    { method: "POST", responseType: "json" },
  );
}

/**
 * Start Canva OAuth (PKCE). Redirects the browser to Canva authorize URL.
 * Falls back to dev-connect when oauth/start returns 503 (no credentials) or
 * 404 (route missing — usually Cloud Run proxy instead of dev:local).
 */
export async function connectCanvaAccount(): Promise<void> {
  try {
    const { url } = await startCanvaOAuth();
    if (!url) {
      throw new Error("Canva OAuth start returned no redirect URL");
    }
    window.location.assign(url);
    return;
  } catch (err) {
    const status = err instanceof ApiError ? err.status : undefined;
    if (status === 503 || status === 404) {
      try {
        await tryDevConnect();
        return;
      } catch (devErr) {
        throw new Error(
          `${formatConnectError(err)} Dev-connect also failed: ${formatConnectError(devErr)}`,
        );
      }
    }
    throw new Error(formatConnectError(err));
  }
}

export async function disconnectCanvaAccount(): Promise<void> {
  await disconnectCanva();
}
