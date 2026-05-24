import type { FloorPlanVizJob, FloorPlanVizSource } from "./types";

const LINE_PLAN_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
      <rect fill="#0f1419" width="640" height="480"/>
      <g stroke="#94a3b8" stroke-width="2" fill="none">
        <rect x="80" y="60" width="480" height="360"/>
        <line x1="320" y1="60" x2="320" y2="420"/>
        <line x1="80" y1="240" x2="560" y2="240"/>
        <rect x="100" y="80" width="80" height="60"/>
        <rect x="420" y="280" width="100" height="80"/>
      </g>
      <text x="24" y="32" fill="#64748b" font-size="14" font-family="sans-serif">2D plan</text>
    </svg>`,
  );

const FURNISHED_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
      <rect fill="#1a2332" width="640" height="480"/>
      <rect x="80" y="60" width="480" height="360" fill="#2d3748" rx="4"/>
      <rect x="100" y="90" width="120" height="80" fill="#4a5568" rx="6"/>
      <rect x="280" y="100" width="160" height="100" fill="#718096" rx="8"/>
      <rect x="420" y="280" width="100" height="90" fill="#805ad5" opacity="0.7" rx="6"/>
      <circle cx="200" cy="320" r="36" fill="#38b2ac" opacity="0.5"/>
      <text x="24" y="32" fill="#81e6d9" font-size="14" font-family="sans-serif">3D visualization</text>
    </svg>`,
  );

export const MOCK_FLOOR_PLAN_BEFORE = LINE_PLAN_SVG;
export const MOCK_FLOOR_PLAN_AFTER = FURNISHED_SVG;

export function mockFloorPlanSources(engagementId: string): FloorPlanVizSource[] {
  return [
    {
      id: `${engagementId}-upload-plan`,
      kind: "upload",
      label: "Ground floor — architect upload",
      thumbnailUrl: LINE_PLAN_SVG,
      previewUrl: LINE_PLAN_SVG,
      fileFormat: "png",
      fileSizeLabel: "2.4 MB",
      dimensionsLabel: "2400 × 1800",
    },
    {
      id: `${engagementId}-sheet-a101`,
      kind: "sheet",
      label: "A1.01 Ground floor plan",
      thumbnailUrl: LINE_PLAN_SVG,
      previewUrl: LINE_PLAN_SVG,
      fileFormat: "pdf",
      fileSizeLabel: "890 KB",
      dimensionsLabel: "ARCH D",
    },
    {
      id: `${engagementId}-snapshot-export`,
      kind: "snapshot",
      label: "Snapshot export · Level 1",
      thumbnailUrl: LINE_PLAN_SVG,
      previewUrl: LINE_PLAN_SVG,
      fileFormat: "png",
      fileSizeLabel: "1.1 MB",
    },
    {
      id: `${engagementId}-dwg-source`,
      kind: "upload",
      label: "Level 1 source DWG",
      thumbnailUrl: LINE_PLAN_SVG,
      previewUrl: LINE_PLAN_SVG,
      fileFormat: "dwg",
      disabled: true,
      disabledReason: "Export to PNG or PDF before visualizing",
    },
    {
      id: `${engagementId}-prior-render`,
      kind: "prior-render",
      label: "Prior floor plan viz output",
      thumbnailUrl: FURNISHED_SVG,
      previewUrl: FURNISHED_SVG,
      fileFormat: "png",
      fileSizeLabel: "3.2 MB",
    },
  ];
}

export function mockFloorPlanJobs(engagementId: string): FloorPlanVizJob[] {
  const sheet = mockFloorPlanSources(engagementId).find(
    (s) => s.kind === "sheet",
  )!;
  return [
    {
      id: `${engagementId}-fpviz-ready`,
      status: "ready",
      source: sheet,
      preset: "standard-3d",
      sourcePreviewUrl: LINE_PLAN_SVG,
      outputPreviewUrl: FURNISHED_SVG,
      creditsUsed: 3,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      prompt:
        "Furnished interior floor plan, photoreal top-down 3D visualization, natural lighting",
    },
    {
      id: `${engagementId}-fpviz-generating`,
      status: "generating",
      source: sheet,
      preset: "standard-3d",
      sourcePreviewUrl: LINE_PLAN_SVG,
      createdAt: new Date().toISOString(),
    },
    {
      id: `${engagementId}-fpviz-failed`,
      status: "failed",
      source: sheet,
      preset: "cgi",
      sourcePreviewUrl: LINE_PLAN_SVG,
      error: "Render engine timed out after 90 seconds.",
      errorCode: "timeout",
      createdAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ];
}
