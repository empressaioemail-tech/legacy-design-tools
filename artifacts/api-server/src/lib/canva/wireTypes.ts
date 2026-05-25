/**
 * Wire shapes aligned with `lib/portal-ui/src/canva/types.ts`.
 * Kept local so api-server does not depend on portal-ui.
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
