import {
  MOCK_FLOOR_PLAN_AFTER,
  mockFloorPlanJobs,
  mockFloorPlanSources,
} from "./mockFixtures";
import type {
  FloorPlanVizJob,
  FloorPlanVizService,
  FloorPlanVizSource,
} from "./types";

const jobStore = new Map<string, FloorPlanVizJob>();
const extraSources = new Map<string, FloorPlanVizSource>();

export function registerMockFloorPlanSource(source: FloorPlanVizSource): void {
  extraSources.set(source.id, source);
}

export function createMockFloorPlanVizService(): FloorPlanVizService {
  return {
    async listSources(engagementId) {
      const base = mockFloorPlanSources(engagementId);
      const extras = [...extraSources.values()].filter((s) =>
        s.id.startsWith(engagementId),
      );
      return [...extras, ...base];
    },

    async listJobs(engagementId) {
      const seeded = mockFloorPlanJobs(engagementId);
      const dynamic = [...jobStore.values()].filter((j) =>
        j.id.startsWith(engagementId),
      );
      return [...dynamic, ...seeded];
    },

    async startVisualization({ engagementId, sourceId, preset, prompt }) {
      const sources = await this.listSources(engagementId);
      const source = sources.find((s) => s.id === sourceId);
      if (!source || source.disabled) {
        throw new Error("Invalid source");
      }
      const jobId = `${engagementId}-fpviz-${Date.now()}`;
      const job: FloorPlanVizJob = {
        id: jobId,
        status: "queued",
        source,
        preset,
        sourcePreviewUrl: source.previewUrl,
        prompt,
        createdAt: new Date().toISOString(),
      };
      jobStore.set(jobId, job);
      advanceMockJob(jobId);
      return { jobId };
    },

    async getJob(jobId) {
      const dynamic = jobStore.get(jobId);
      if (dynamic) return { ...dynamic };

      const prefixMatch = jobId.match(/^(.+)-fpviz-/);
      if (prefixMatch) {
        const engagementId = prefixMatch[1]!;
        const seeded = mockFloorPlanJobs(engagementId).find((j) => j.id === jobId);
        if (seeded) return { ...seeded };
      }
      throw new Error("Job not found");
    },
  };
}

function advanceMockJob(jobId: string) {
  const sequence: FloorPlanVizJob["status"][] = [
    "queued",
    "uploading",
    "generating",
    "ready",
  ];
  const delays = [0, 500, 1200, 2500];
  sequence.forEach((status, i) => {
    window.setTimeout(() => {
      const current = jobStore.get(jobId);
      if (!current || current.status === "failed") return;
      jobStore.set(jobId, {
        ...current,
        status,
        ...(status === "ready"
          ? {
              outputPreviewUrl: MOCK_FLOOR_PLAN_AFTER,
              creditsUsed: 3,
            }
          : {}),
      });
    }, delays[i] ?? 500);
  });
}

export const mockFloorPlanVizService = createMockFloorPlanVizService();
