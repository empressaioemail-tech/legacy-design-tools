/**
 * Placid collateral — live API via @workspace/api-client-react.
 */
import {
  getCollateralExportJob,
  listCollateralTemplates,
  listEngagementCollateralAssets,
  listEngagementCollateralExports,
  startEngagementCollateralExport,
  type CollateralExportJob as ApiJob,
  type CollateralExportRecord as ApiRecord,
  type CollateralExportRequest as ApiRequest,
  type CollateralSelectableAsset as ApiAsset,
  type CollateralTemplatePack as ApiPack,
} from "@workspace/api-client-react";
import type {
  CollateralExportJob,
  CollateralExportRecord,
  CollateralExportRequest,
  CollateralIntegrationService,
  CollateralSelectableAsset,
  CollateralTemplatePack,
} from "./types";

function mapAsset(a: ApiAsset): CollateralSelectableAsset {
  return { ...a };
}

function mapPack(p: ApiPack): CollateralTemplatePack {
  return {
    id: p.id,
    name: p.name,
    thumbnailUrl: p.thumbnailUrl,
    tags: p.tags,
    pageCountEstimate: p.pageCountEstimate,
    creditsPerPage: p.creditsPerPage,
    slots: p.slots.map((s) => {
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

function mapRecord(r: ApiRecord): CollateralExportRecord {
  return {
    id: r.id,
    createdAt: r.createdAt,
    templateName: r.templateName,
    status: r.status,
    thumbnailUrl: r.thumbnailUrl,
    downloadUrl: r.downloadUrl,
    sourceAssetIds: r.sourceAssetIds,
    creditsCharged: r.creditsCharged,
  };
}

function mapJob(j: ApiJob): CollateralExportJob {
  return {
    jobId: j.jobId,
    step: j.step,
    progressLabel: j.progressLabel,
    downloadUrl: j.downloadUrl,
    thumbnailUrl: j.thumbnailUrl,
    creditsEstimated: j.creditsEstimated,
    creditsActual: j.creditsActual,
    error: j.error,
  };
}

export function createApiCollateralIntegrationService(): CollateralIntegrationService {
  return {
    async listTemplatePacks() {
      const packs = await listCollateralTemplates();
      return packs.map(mapPack);
    },
    async listEngagementAssets(engagementId: string) {
      const assets = await listEngagementCollateralAssets(engagementId);
      return assets.map(mapAsset);
    },
    async listEngagementExports(engagementId: string) {
      const rows = await listEngagementCollateralExports(engagementId);
      return rows.map(mapRecord);
    },
    async startExport(request: CollateralExportRequest) {
      const body: ApiRequest = {
        engagementId: request.engagementId,
        templatePackId: request.templatePackId,
        assetIds: request.assetIds,
        slotMapping: request.slotMapping,
        textFields: request.textFields,
        sheetAssetIds: request.sheetAssetIds,
      };
      const res = await startEngagementCollateralExport(
        request.engagementId,
        body,
      );
      return {
        jobId: res.jobId,
        creditsEstimated: res.creditsEstimated,
      };
    },
    async getExportJob(jobId: string) {
      const job = await getCollateralExportJob(jobId);
      return mapJob(job);
    },
  };
}
