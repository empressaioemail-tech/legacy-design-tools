/**
 * Floor plan → 3D visualization — frontend contract (stub phase).
 *
 * Expected backend endpoints (for backend agent):
 *   POST /api/engagements/:id/renders/source-upload
 *   POST /api/engagements/:id/renders (expertName: plan)
 *   GET  /api/renders/:id
 *   GET  /api/engagements/:id/renders
 */

export type FloorPlanVizSourceKind =
  | "upload"
  | "sheet"
  | "snapshot"
  | "prior-render";

export type FloorPlanFileFormat = "png" | "jpeg" | "webp" | "pdf" | "dwg" | "dxf";

export type FloorPlanVizSource = {
  id: string;
  kind: FloorPlanVizSourceKind;
  label: string;
  thumbnailUrl: string;
  previewUrl: string;
  fileFormat: FloorPlanFileFormat;
  fileSizeLabel?: string;
  dimensionsLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Set after `POST .../renders/source-upload` (upload kind). */
  sourceUploadUrl?: string;
  /** Snapshot sheet row id (sheet kind). */
  sheetId?: string;
};

export type FloorPlanVizPreset =
  | "standard-3d"
  | "cgi"
  | "illustration"
  | "watercolor";

export type FloorPlanVizJobStatus =
  | "queued"
  | "uploading"
  | "generating"
  | "ready"
  | "failed";

export type FloorPlanVizJob = {
  id: string;
  status: FloorPlanVizJobStatus;
  source: FloorPlanVizSource;
  preset: FloorPlanVizPreset;
  sourcePreviewUrl: string;
  outputPreviewUrl?: string;
  /** Durable download URL (`?download=1` when mirrored). */
  outputDownloadUrl?: string;
  error?: string;
  errorCode?: "upload" | "invalid" | "credits" | "engine" | "timeout";
  creditsUsed?: number;
  createdAt: string;
  prompt?: string;
};

export interface FloorPlanVizService {
  listSources(engagementId: string): Promise<FloorPlanVizSource[]>;
  listJobs(engagementId: string): Promise<FloorPlanVizJob[]>;
  /** Optional — real API service uploads via source-upload. */
  uploadSource?(engagementId: string, file: File): Promise<FloorPlanVizSource>;
  startVisualization(req: {
    engagementId: string;
    sourceId: string;
    preset: FloorPlanVizPreset;
    prompt?: string;
  }): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<FloorPlanVizJob>;
}

export const FLOOR_PLAN_PRESET_META: Record<
  FloorPlanVizPreset,
  { label: string; description: string }
> = {
  "standard-3d": {
    label: "Standard 3D floor plan",
    description:
      "Turn a 2D plan into a furnished top-down 3D visualization.",
  },
  cgi: { label: "CGI", description: "Clean CGI staging with soft shadows." },
  illustration: {
    label: "Illustration",
    description: "Stylized interior illustration from the plan.",
  },
  watercolor: {
    label: "Watercolor",
    description: "Soft watercolor presentation style.",
  },
};
