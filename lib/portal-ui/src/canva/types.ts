/**
 * Canva Connect integration — frontend contract (stub phase).
 *
 * Expected backend endpoints (for backend agent):
 *   GET  /api/canva/connection
 *   POST /api/canva/oauth/start
 *   GET  /api/engagements/:id/canva/assets
 *   GET  /api/canva/brand-templates
 *   POST /api/engagements/:id/canva/push
 *   GET  /api/canva/push-jobs/:jobId
 */

export type CanvaConnectionStatus =
  | { state: "disconnected" }
  | {
      state: "connected";
      displayName: string;
      avatarUrl?: string;
      connectedAt: string;
    }
  | { state: "expired"; displayName?: string }
  | { state: "enterprise_required"; message: string };

export type CanvaAssetKind =
  | "render"
  | "floorplan"
  | "sheet"
  | "site-context"
  | "metadata";

export type CanvaSelectableAsset = {
  id: string;
  kind: CanvaAssetKind;
  label: string;
  fileType: string;
  thumbnailUrl?: string;
  /** When false, row is visible but not selectable (e.g. DXF/DWG). */
  exportable: boolean;
  disabledReason?: string;
  sourceTab?: string;
};

export type CanvaTemplateSlot =
  | { key: string; type: "text"; label: string; defaultValue?: string }
  | {
      key: string;
      type: "image";
      label: string;
        accepts: ("render" | "floorplan" | "sheet" | "site-context")[];
    };

export type CanvaBrandTemplate = {
  id: string;
  name: string;
  thumbnailUrl: string;
  tags: string[];
  pageCount: number;
  slots: CanvaTemplateSlot[];
};

export type CanvaPushJobStep =
  | "preparing"
  | "uploading"
  | "creating"
  | "ready"
  | "failed";

export type CanvaPushJob = {
  jobId: string;
  step: CanvaPushJobStep;
  progressLabel: string;
  designUrl?: string;
  designThumbnailUrl?: string;
  error?: { code: "upload" | "template" | "auth"; message: string };
};

export type CanvaDesignPushStatus =
  | "uploading"
  | "ready"
  | "failed"
  | "edited_in_canva";

export type CanvaDesignPush = {
  id: string;
  createdAt: string;
  templateName: string;
  status: CanvaDesignPushStatus;
  thumbnailUrl?: string;
  designUrl?: string;
  sourceAssetIds: string[];
};

export type CanvaPushRequest = {
  engagementId: string;
  templateId: string;
  assetIds: string[];
  slotMapping: Record<string, string>;
  textFields: Record<string, string>;
  uploadAssetsOnly?: boolean;
};

export interface CanvaIntegrationService {
  getConnectionStatus(): Promise<CanvaConnectionStatus>;
  listBrandTemplates(): Promise<CanvaBrandTemplate[]>;
  listEngagementAssets(engagementId: string): Promise<CanvaSelectableAsset[]>;
  listEngagementDesigns(engagementId: string): Promise<CanvaDesignPush[]>;
  startPush(request: CanvaPushRequest): Promise<{ jobId: string }>;
  getPushJob(jobId: string): Promise<CanvaPushJob>;
}
