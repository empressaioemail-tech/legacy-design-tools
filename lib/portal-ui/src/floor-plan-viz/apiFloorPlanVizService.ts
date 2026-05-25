/**
 * Floor plan viz — live render pipeline via cortex-api / mnml.
 *
 * Uses the same upload → still kickoff path as doc 40e B.2, pinned to
 * `expertName: plan`. Mock mode in dev/CI when `RENDERS_PROD_ENABLED`
 * is off still returns realistic outputs via MockMnmlClient.
 */
import {
  customFetch,
  getRender,
  getSnapshotSheets,
  getUploadRenderSourceUrl,
  kickoffRender,
  listEngagementRenders,
  type RenderDetailResponse,
  type RenderSourceUploadResponse,
  type RenderStatus,
  type SheetSummary,
} from "@workspace/api-client-react";
import type {
  FloorPlanVizJob,
  FloorPlanVizPreset,
  FloorPlanVizService,
  FloorPlanVizSource,
} from "./types";
import {
  floorPlanSheetSourceId,
  floorPlanUploadSourceId,
} from "./sourceIds";

const TRACKED_RENDERS_KEY = "fpviz-tracked-render-ids";
const UPLOAD_SOURCES_KEY = "fpviz-upload-sources";

const PRESET_RENDER_STYLE: Record<
  FloorPlanVizPreset,
  "photoreal" | "cgi_render" | "illustration" | "watercolor"
> = {
  "standard-3d": "photoreal",
  cgi: "cgi_render",
  illustration: "illustration",
  watercolor: "watercolor",
};

type StoredUploadSource = FloorPlanVizSource & { sourceUploadUrl: string };

function sheetThumbUrl(sheetId: string): string {
  return `/api/sheets/${sheetId}/thumbnail.png`;
}

function sheetFullUrl(sheetId: string): string {
  return `/api/sheets/${sheetId}/full.png`;
}

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(key, JSON.stringify(value));
}

function mapRenderStatus(status: RenderStatus): FloorPlanVizJob["status"] {
  switch (status) {
    case "queued":
      return "queued";
    case "rendering":
      return "generating";
    case "ready":
      return "ready";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "generating";
  }
}

function mapErrorCode(code: string | null): FloorPlanVizJob["errorCode"] {
  if (!code) return "engine";
  if (code === "insufficient_credits") return "credits";
  if (code.includes("validation") || code.includes("invalid")) return "invalid";
  if (code.includes("timeout")) return "timeout";
  if (code.includes("upload")) return "upload";
  return "engine";
}

function previewForOutput(
  output: RenderDetailResponse["outputs"][number],
): string | null {
  if (output.previewUrl) return output.previewUrl;
  if (output.mirroredObjectKey) return `/api/render-outputs/${output.id}/file`;
  return null;
}

function downloadForOutput(
  output: RenderDetailResponse["outputs"][number],
): string | null {
  if (output.downloadUrl) return output.downloadUrl;
  if (output.mirroredObjectKey)
    return `/api/render-outputs/${output.id}/file?download=1`;
  return null;
}

function renderDetailToJob(
  detail: RenderDetailResponse,
  sourcesById: Map<string, FloorPlanVizSource>,
): FloorPlanVizJob {
  const primary = detail.outputs.find((o) => o.role === "primary");
  const outputPreviewUrl = primary ? previewForOutput(primary) : undefined;
  const outputDownloadUrl = primary ? downloadForOutput(primary) : undefined;
  const source =
    [...sourcesById.values()].find((s) =>
      detail.sourceUploadUrl
        ? s.sourceUploadUrl === detail.sourceUploadUrl
        : false,
    ) ??
    [...sourcesById.values()].find((s) => s.kind === "sheet") ??
    ({
      id: detail.id,
      kind: "upload" as const,
      label: "Floor plan source",
      thumbnailUrl: detail.sourceUploadUrl ?? "",
      previewUrl: detail.sourceUploadUrl ?? "",
      fileFormat: "png" as const,
    } satisfies FloorPlanVizSource);

  const payload = detail as RenderDetailResponse & {
    requestPayload?: { preset?: FloorPlanVizPreset; prompt?: string };
  };

  return {
    id: detail.id,
    status: mapRenderStatus(detail.status),
    source,
    preset:
      payload.requestPayload?.preset ??
      ("standard-3d" satisfies FloorPlanVizPreset),
    sourcePreviewUrl: detail.sourceUploadUrl ?? source.previewUrl,
    outputPreviewUrl: outputPreviewUrl ?? undefined,
    outputDownloadUrl: outputDownloadUrl ?? undefined,
    error: detail.errorMessage ?? undefined,
    errorCode:
      detail.status === "failed"
        ? mapErrorCode(detail.errorCode)
        : undefined,
    creditsUsed: detail.status === "ready" ? 3 : undefined,
    createdAt: detail.createdAt,
    prompt: payload.requestPayload?.prompt,
  };
}

async function uploadImageBlob(
  engagementId: string,
  blob: Blob,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("image", blob, filename);
  const res = await customFetch<RenderSourceUploadResponse>(
    getUploadRenderSourceUrl(engagementId),
    { method: "POST", body: form, responseType: "json" },
  );
  return res.sourceUploadUrl;
}

export function createApiFloorPlanVizService(opts: {
  engagementId: string;
  snapshotId?: string | null;
  /** When set, only floor-plan heuristic sheets are listed (QA-54). */
  filterSheets?: (sheet: SheetSummary) => boolean;
}): FloorPlanVizService {
  const { engagementId, snapshotId, filterSheets } = opts;

  function trackedIds(): Set<string> {
    const key = engagementId;
    const all = readJson<Record<string, string[]>>(TRACKED_RENDERS_KEY) ?? {};
    return new Set(all[key] ?? []);
  }

  function trackRenderId(renderId: string): void {
    const all = readJson<Record<string, string[]>>(TRACKED_RENDERS_KEY) ?? {};
    const key = engagementId;
    const next = new Set(all[key] ?? []);
    next.add(renderId);
    all[key] = [...next];
    writeJson(TRACKED_RENDERS_KEY, all);
  }

  function readUploadSources(): StoredUploadSource[] {
    const all =
      readJson<Record<string, StoredUploadSource[]>>(UPLOAD_SOURCES_KEY) ?? {};
    return all[engagementId] ?? [];
  }

  function persistUploadSource(source: StoredUploadSource): void {
    const all =
      readJson<Record<string, StoredUploadSource[]>>(UPLOAD_SOURCES_KEY) ?? {};
    const existing = all[engagementId] ?? [];
    all[engagementId] = [
      source,
      ...existing.filter((s) => s.id !== source.id),
    ];
    writeJson(UPLOAD_SOURCES_KEY, all);
  }

  async function buildSourcesMap(): Promise<Map<string, FloorPlanVizSource>> {
    const map = new Map<string, FloorPlanVizSource>();

    for (const upload of readUploadSources()) {
      map.set(upload.id, upload);
    }

    if (snapshotId) {
      const sheets = await getSnapshotSheets(snapshotId);
      for (const sheet of sheets) {
        if (filterSheets && !filterSheets(sheet)) continue;
        const id = floorPlanSheetSourceId(engagementId, sheet.id);
        map.set(id, {
          id,
          kind: "sheet",
          label: `${sheet.sheetNumber} ${sheet.sheetName}`.trim(),
          thumbnailUrl: sheetThumbUrl(sheet.id),
          previewUrl: sheetFullUrl(sheet.id),
          fileFormat: "png",
          dimensionsLabel: `${sheet.fullWidth} × ${sheet.fullHeight}`,
          sheetId: sheet.id,
        });
      }
    }

    return map;
  }

  return {
    async listSources() {
      return [...(await buildSourcesMap()).values()];
    },

    async listJobs() {
      const sources = await buildSourcesMap();
      const ids = trackedIds();
      if (ids.size === 0) return [];

      const { items } = await listEngagementRenders(engagementId);
      const candidates = items.filter((item) => ids.has(item.id));
      const jobs = await Promise.all(
        candidates.map(async (item) => {
          const detail = await getRender(item.id);
          return renderDetailToJob(detail, sources);
        }),
      );
      return jobs.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },

    async uploadSource(engId, file) {
      const sourceUploadUrl = await uploadImageBlob(
        engagementId,
        file,
        file.name || "floor-plan.png",
      );
      const source: StoredUploadSource = {
        id: floorPlanUploadSourceId(engId),
        kind: "upload",
        label: file.name || "Uploaded floor plan",
        thumbnailUrl: sourceUploadUrl,
        previewUrl: sourceUploadUrl,
        fileFormat: file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "png",
        fileSizeLabel: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
        sourceUploadUrl,
      };
      persistUploadSource(source);
      return source;
    },

    async startVisualization({ sourceId, preset, prompt }) {
      const sources = await buildSourcesMap();
      const source = sources.get(sourceId);
      if (!source) throw new Error("Invalid source");

      let sourceUploadUrl = source.sourceUploadUrl;
      if (!sourceUploadUrl && source.sheetId) {
        const res = await fetch(sheetFullUrl(source.sheetId));
        if (!res.ok) throw new Error("Sheet fetch failed");
        const blob = await res.blob();
        sourceUploadUrl = await uploadImageBlob(
          engagementId,
          blob,
          `sheet-${source.sheetId}.png`,
        );
      }
      if (!sourceUploadUrl) throw new Error("Missing source upload");

      const kickoff = await kickoffRender(engagementId, {
        kind: "still",
        sourceUploadUrl,
        prompt: prompt?.trim() || "Furnished interior floor plan visualization",
        expertName: "plan",
        renderStyle: PRESET_RENDER_STYLE[preset],
      });

      trackRenderId(kickoff.renderId);
      return { jobId: kickoff.renderId };
    },

    async getJob(jobId) {
      const sources = await buildSourcesMap();
      const detail = await getRender(jobId);
      return renderDetailToJob(detail, sources);
    },
  };
}
