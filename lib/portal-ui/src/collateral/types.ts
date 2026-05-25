export type CollateralSelectableAsset = {
  id: string;
  kind: "render" | "floorplan" | "sheet" | "site-context" | "metadata";
  label: string;
  fileType: string;
  thumbnailUrl?: string;
  exportable: boolean;
  disabledReason?: string;
  sourceTab?: string;
};

export type CollateralTemplateSlot =
  | { key: string; type: "text"; label: string; defaultValue?: string }
  | {
      key: string;
      type: "image";
      label: string;
      accepts: ("render" | "floorplan" | "sheet" | "site-context")[];
    };

export type CollateralTemplatePack = {
  id: string;
  name: string;
  thumbnailUrl: string;
  tags: string[];
  pageCountEstimate: number;
  creditsPerPage: number;
  slots: CollateralTemplateSlot[];
};

export type CollateralExportJobStep =
  | "preparing"
  | "resolving_assets"
  | "rendering"
  | "ready"
  | "failed";

export type CollateralExportJob = {
  jobId: string;
  step: CollateralExportJobStep;
  progressLabel: string;
  downloadUrl?: string;
  thumbnailUrl?: string;
  creditsEstimated?: number;
  creditsActual?: number;
  error?: { code: "assets" | "placid" | "config"; message: string };
};

export type CollateralExportRecord = {
  id: string;
  createdAt: string;
  templateName: string;
  status: "rendering" | "ready" | "failed";
  thumbnailUrl?: string;
  downloadUrl?: string;
  sourceAssetIds: string[];
  creditsCharged?: number;
};

export type CollateralExportRequest = {
  engagementId: string;
  templatePackId: string;
  assetIds: string[];
  slotMapping: Record<string, string>;
  textFields: Record<string, string>;
  sheetAssetIds?: string[];
};

export interface CollateralIntegrationService {
  listTemplatePacks(): Promise<CollateralTemplatePack[]>;
  listEngagementAssets(engagementId: string): Promise<CollateralSelectableAsset[]>;
  listEngagementExports(engagementId: string): Promise<CollateralExportRecord[]>;
  startExport(request: CollateralExportRequest): Promise<{
    jobId: string;
    creditsEstimated?: number;
  }>;
  getExportJob(jobId: string): Promise<CollateralExportJob>;
}
