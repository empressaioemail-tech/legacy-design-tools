import type { CollateralExportRequestJson } from "@workspace/db";
import { logger } from "../logger";
import {
  isPlacidConfigured,
  placidTemplateClosing,
  placidTemplateCover,
  placidTemplatePlan,
  placidTestMode,
  MAX_PDF_PAGES,
} from "./config";
import {
  estimateCreditsForRequest,
  templatePackName,
  CLIENT_PRESENTATION_PACK,
} from "./catalog";
import { buildSignedAssetFetchUrl, isSigningConfigured } from "./exportSignedUrl";
import { createPlacidPdf, getPlacidPdf, type PlacidPdfPage } from "./placidClient";
import {
  getExportJobRow,
  insertCollateralExport,
  recordMeteringEvent,
  updateExportJob,
} from "./store";

const POLL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function failJob(
  jobId: string,
  code: "assets" | "placid" | "config",
  message: string,
): Promise<void> {
  await updateExportJob(jobId, {
    step: "failed",
    progressLabel: message,
    errorCode: code,
    errorMessage: message,
  });
}

export function runCollateralExportJob(params: {
  jobId: string;
  tenantId: string;
  baseUrl: string;
}): void {
  void runInner(params).catch((err) => {
    logger.error({ err, jobId: params.jobId }, "collateral export job crashed");
    void failJob(params.jobId, "placid", "Unexpected error during PDF export");
  });
}

async function runInner(params: {
  jobId: string;
  tenantId: string;
  baseUrl: string;
}): Promise<void> {
  const row = await getExportJobRow(params.jobId);
  if (!row) return;

  const req = row.request;

  if (!isSigningConfigured()) {
    await failJob(
      params.jobId,
      "config",
      "COLLATERAL_SIGNING_SECRET is not configured",
    );
    return;
  }

  await updateExportJob(params.jobId, {
    step: "resolving_assets",
    progressLabel: "Resolving assets for Placid…",
  });

  if (!isPlacidConfigured()) {
    await simulateDevExport(
      params.jobId,
      row.engagementId,
      req,
      row.creditsEstimated ?? 0,
      params.tenantId,
    );
    return;
  }

  const coverUuid = placidTemplateCover();
  const planUuid = placidTemplatePlan();
  const closingUuid = placidTemplateClosing();
  if (!coverUuid || !planUuid || !closingUuid) {
    if (!placidTestMode()) {
      await failJob(
        params.jobId,
        "config",
        "PLACID_TEMPLATE_COVER, PLAN, and CLOSING must be set (or use PLACID_TEST_MODE)",
      );
      return;
    }
  }

  let pages: PlacidPdfPage[];
  try {
    pages = await buildPlacidPages({
      jobId: params.jobId,
      baseUrl: params.baseUrl,
      req,
      coverUuid: coverUuid ?? "00000000-0000-0000-0000-000000000001",
      planUuid: planUuid ?? "00000000-0000-0000-0000-000000000002",
      closingUuid: closingUuid ?? "00000000-0000-0000-0000-000000000003",
    });
  } catch (err) {
    await failJob(
      params.jobId,
      "assets",
      err instanceof Error ? err.message : "Failed to resolve assets",
    );
    return;
  }

  if (pages.length > MAX_PDF_PAGES) {
    await failJob(params.jobId, "placid", `Too many pages (max ${MAX_PDF_PAGES})`);
    return;
  }

  await updateExportJob(params.jobId, {
    step: "rendering",
    progressLabel: "Rendering PDF with Placid…",
  });

  const creditsActual = pages.length * CLIENT_PRESENTATION_PACK.creditsPerPage;

  let placidId: string | number;
  try {
    const created = await createPlacidPdf({
      pages,
      passthrough: JSON.stringify({
        jobId: params.jobId,
        engagementId: row.engagementId,
      }),
    });
    placidId = created.id;
    await updateExportJob(params.jobId, {
      placidPdfId: String(placidId),
      creditsActual,
    });
  } catch (err) {
    await failJob(
      params.jobId,
      "placid",
      err instanceof Error ? err.message : "Placid create failed",
    );
    return;
  }

  let downloadUrl: string | null = null;
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_MS);
    try {
      const status = await getPlacidPdf(placidId);
      if (status.status === "finished" && status.pdf_url) {
        downloadUrl = status.pdf_url;
        break;
      }
      if (status.status === "error") {
        await failJob(
          params.jobId,
          "placid",
          status.error ?? "Placid reported an error",
        );
        return;
      }
    } catch (err) {
      await failJob(
        params.jobId,
        "placid",
        err instanceof Error ? err.message : "Placid poll failed",
      );
      return;
    }
  }

  if (!downloadUrl) {
    await failJob(params.jobId, "placid", "Placid PDF generation timed out");
    return;
  }

  const persistedUrl = await maybePersistPdfToGcs(downloadUrl, params.jobId);

  await updateExportJob(params.jobId, {
    step: "ready",
    progressLabel: "PDF ready to download",
    downloadUrl: persistedUrl,
    errorCode: null,
    errorMessage: null,
    creditsActual,
  });

  await insertCollateralExport({
    engagementId: row.engagementId,
    exportJobId: params.jobId,
    templatePackId: req.templatePackId,
    templateName: templatePackName(req.templatePackId),
    status: "ready",
    downloadUrl: persistedUrl,
    thumbnailUrl: CLIENT_PRESENTATION_PACK.thumbnailUrl,
    sourceAssetIds: req.assetIds,
    creditsCharged: creditsActual,
  });

  await recordMeteringEvent({
    tenantId: params.tenantId,
    engagementId: row.engagementId,
    exportJobId: params.jobId,
    units: creditsActual,
  });
}

async function buildPlacidPages(params: {
  jobId: string;
  baseUrl: string;
  req: CollateralExportRequestJson;
  coverUuid: string;
  planUuid: string;
  closingUuid: string;
}): Promise<PlacidPdfPage[]> {
  const signed = (assetKey: string) =>
    buildSignedAssetFetchUrl({
      baseUrl: params.baseUrl,
      jobId: params.jobId,
      assetKey,
    });

  const tf = params.req.textFields;
  const sm = params.req.slotMapping;
  const heroId = sm.hero_image ?? sm.hero ?? params.req.assetIds.find((id) => id.startsWith("render:"));
  const pages: PlacidPdfPage[] = [];

  const coverLayers: PlacidPdfPage["layers"] = {
    headline: { text: tf.headline ?? tf.project_name ?? "Project" },
    address: { text: tf.address ?? "" },
    project_name: { text: tf.project_name ?? "" },
  };
  if (heroId) {
    coverLayers.hero_image = { image: signed(heroId) };
  }
  pages.push({ template_uuid: params.coverUuid, layers: coverLayers });

  const sheetIds =
    params.req.sheetAssetIds?.filter((id) => id.startsWith("sheet:")) ??
    params.req.assetIds.filter((id) => id.startsWith("sheet:"));

  const maxPlan = 12;
  for (const sheetId of sheetIds.slice(0, maxPlan)) {
    const planImageId = sm.floor_plan && sheetIds[0] === sheetId ? sm.floor_plan : sheetId;
    pages.push({
      template_uuid: params.planUuid,
      layers: {
        floor_plan: { image: signed(planImageId) },
        sheet_label: {
          text: sheetId.replace(/^sheet:/, "Sheet "),
        },
      },
    });
  }

  pages.push({
    template_uuid: params.closingUuid,
    layers: {
      talking_points: {
        text: tf.talking_points ?? tf.clientTalkingPoints ?? "",
      },
    },
  });

  return pages;
}

async function simulateDevExport(
  jobId: string,
  engagementId: string,
  req: CollateralExportRequestJson,
  creditsEstimated: number,
  tenantId: string,
): Promise<void> {
  await sleep(300);
  await updateExportJob(jobId, {
    step: "rendering",
    progressLabel: "Rendering PDF (dev stub)…",
  });
  await sleep(500);
  const downloadUrl = "https://placid.app/dev-stub-collateral.pdf";
  const creditsActual =
    creditsEstimated ||
    estimateCreditsForRequest({
      sheetPageCount: (req.sheetAssetIds ?? []).length,
    });
  await updateExportJob(jobId, {
    step: "ready",
    progressLabel: "PDF ready (dev stub — set PLACID_API_TOKEN for live export)",
    downloadUrl,
    thumbnailUrl: CLIENT_PRESENTATION_PACK.thumbnailUrl,
    creditsActual,
    errorCode: null,
    errorMessage: null,
  });
  await insertCollateralExport({
    engagementId,
    exportJobId: jobId,
    templatePackId: req.templatePackId,
    templateName: templatePackName(req.templatePackId),
    status: "ready",
    downloadUrl,
    thumbnailUrl: CLIENT_PRESENTATION_PACK.thumbnailUrl,
    sourceAssetIds: req.assetIds,
    creditsCharged: creditsActual,
  });
  await recordMeteringEvent({
    tenantId,
    engagementId,
    exportJobId: jobId,
    units: creditsActual,
  });
}

async function maybePersistPdfToGcs(
  sourceUrl: string,
  jobId: string,
): Promise<string> {
  try {
    const { persistCollateralPdfFromUrl } = await import("./pdfPersist");
    return await persistCollateralPdfFromUrl(sourceUrl, jobId);
  } catch {
    return sourceUrl;
  }
}
