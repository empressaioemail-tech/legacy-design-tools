import type {
  CollateralExportJob,
  CollateralExportRecord,
  CollateralExportRequest,
  CollateralIntegrationService,
  CollateralSelectableAsset,
  CollateralTemplatePack,
} from "./types";

const THUMB =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect fill="#1a2332" width="120" height="90"/></svg>`,
  );

const PACKS: CollateralTemplatePack[] = [
  {
    id: "client-presentation",
    name: "Client presentation (PDF)",
    thumbnailUrl: THUMB,
    tags: ["PDF"],
    pageCountEstimate: 6,
    creditsPerPage: 2,
    slots: [
      { key: "headline", type: "text", label: "Headline" },
      { key: "hero_image", type: "image", label: "Hero", accepts: ["render"] },
    ],
  },
];

const MOCK_ASSETS: CollateralSelectableAsset[] = [
  {
    id: "render:mock-1",
    kind: "render",
    label: "Exterior render",
    fileType: "PNG",
    thumbnailUrl: THUMB,
    exportable: true,
    sourceTab: "renders",
  },
];

let jobCounter = 0;

export function createMockCollateralIntegrationService(): CollateralIntegrationService {
  return {
    async listTemplatePacks() {
      return PACKS;
    },
    async listEngagementAssets() {
      return MOCK_ASSETS;
    },
    async listEngagementExports() {
      return [];
    },
    async startExport(req: CollateralExportRequest) {
      jobCounter += 1;
      const jobId = `mock-job-${jobCounter}`;
      setTimeout(() => {
        mockJobs.set(jobId, {
          jobId,
          step: "ready",
          progressLabel: "PDF ready (mock)",
          downloadUrl: "https://example.com/mock-collateral.pdf",
          creditsActual: 12,
        });
      }, 800);
      mockJobs.set(jobId, {
        jobId,
        step: "rendering",
        progressLabel: "Rendering PDF…",
        creditsEstimated: 12,
      });
      return { jobId, creditsEstimated: 12 };
    },
    async getExportJob(jobId: string) {
      return (
        mockJobs.get(jobId) ?? {
          jobId,
          step: "failed",
          progressLabel: "Unknown job",
          error: { code: "config", message: "Mock job not found" },
        }
      );
    },
  };
}

const mockJobs = new Map<string, CollateralExportJob>();

export const mockCollateralIntegrationService =
  createMockCollateralIntegrationService();
