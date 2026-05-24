import {
  MOCK_BRAND_TEMPLATES,
  mockEngagementAssets,
  mockEngagementDesigns,
} from "./mockFixtures";
import type {
  CanvaConnectionStatus,
  CanvaIntegrationService,
  CanvaPushJob,
  CanvaPushRequest,
} from "./types";

/** Stub: flip to simulate connected / enterprise gate in Storybook or demo. */
export type MockCanvaOptions = {
  connected?: boolean;
  enterpriseRequired?: boolean;
  displayName?: string;
};

const jobStore = new Map<string, CanvaPushJob>();

export function createMockCanvaIntegrationService(
  options: MockCanvaOptions = {},
): CanvaIntegrationService {
  const {
    connected = true,
    enterpriseRequired = false,
    displayName = "Studio Canva (demo)",
  } = options;

  return {
    async getConnectionStatus(): Promise<CanvaConnectionStatus> {
      if (enterpriseRequired) {
        return {
          state: "enterprise_required",
          message:
            "Brand template autofill requires Canva Enterprise. You can still upload assets only.",
        };
      }
      if (!connected) {
        return { state: "disconnected" };
      }
      return {
        state: "connected",
        displayName,
        connectedAt: "Connected · demo mode",
      };
    },

    async listBrandTemplates() {
      return MOCK_BRAND_TEMPLATES;
    },

    async listEngagementAssets(engagementId) {
      return mockEngagementAssets(engagementId);
    },

    async listEngagementDesigns(engagementId) {
      return mockEngagementDesigns(engagementId);
    },

    async startPush(request: CanvaPushRequest) {
      const jobId = `job-${Date.now()}`;
      jobStore.set(jobId, {
        jobId,
        step: "preparing",
        progressLabel: "Preparing assets…",
      });
      advanceMockJob(jobId, request.uploadAssetsOnly ?? false);
      return { jobId };
    },

    async getPushJob(jobId) {
      const job = jobStore.get(jobId);
      if (!job) {
        return {
          jobId,
          step: "failed",
          progressLabel: "Job not found",
          error: { code: "upload", message: "Unknown job id (stub)" },
        };
      }
      return { ...job };
    },
  };
}

function advanceMockJob(jobId: string, uploadOnly: boolean) {
  const sequence: Omit<CanvaPushJob, "jobId">[] = [
    { step: "preparing", progressLabel: "Preparing assets…" },
    { step: "uploading", progressLabel: "Uploading to Canva…" },
    {
      step: "creating",
      progressLabel: uploadOnly
        ? "Adding files to your Canva library…"
        : "Creating design from template…",
    },
    {
      step: "ready",
      progressLabel: "Ready to edit in Canva",
      designUrl: "https://www.canva.com/design/stub-demo",
      designThumbnailUrl: MOCK_BRAND_TEMPLATES[0]?.thumbnailUrl,
    },
  ];
  const delays = [0, 450, 650, 750];
  let idx = 0;
  const run = () => {
    const item = sequence[idx];
    if (!item) return;
    jobStore.set(jobId, { jobId, ...item });
    idx += 1;
    if (idx < sequence.length) {
      window.setTimeout(run, delays[idx] ?? 500);
    }
  };
  run();
}

/** Default singleton for design-tools dev shell. */
export const mockCanvaIntegrationService = createMockCanvaIntegrationService();
