/**
 * Vitest setup: offline spine seam for integration tests.
 *
 * C3 routes all reasoning through engine-api in production. Tests keep
 * the pre-C3 offline behavior by delegating spine routing helpers to the
 * local workspace engines / site-context compute (mock mode by default).
 */

import { vi } from "vitest";
import type { EngineHonesty } from "@workspace/engine-core";

if (!process.env.ENGINE_API_URL?.trim()) {
  process.env.ENGINE_API_URL = "http://engine.test.invalid";
}

const offlineHonesty = (producer: string): EngineHonesty => ({
  confidence: {
    value: producer === "mock" ? 0 : 0.85,
    kind: producer === "mock" ? "asserted" : "asserted",
  },
  dataVintage: null,
  coverage: {
    degraded: producer === "mock",
    ...(producer === "mock" ? { reason: "mock_producer" } : {}),
  },
  source: { adapter: "local-engine-test" },
});

vi.mock("../lib/engineSpineRouting", async () => {
  const findingEngine =
    await vi.importActual<typeof import("@workspace/finding-engine")>(
      "@workspace/finding-engine",
    );
  const briefingEngine =
    await vi.importActual<typeof import("@workspace/briefing-engine")>(
      "@workspace/briefing-engine",
    );
  return {
    routeGenerateFindings: async (
      input: Parameters<typeof findingEngine.generateFindings>[0],
      options?: Parameters<typeof findingEngine.generateFindings>[1],
    ) => ({
      result: await findingEngine.generateFindings(input, options),
      honesty: offlineHonesty(options?.mode ?? "mock"),
    }),
    routeGenerateOrchestratedFindings: async (
      input: Parameters<typeof findingEngine.generateOrchestratedFindings>[0],
      options?: Parameters<typeof findingEngine.generateOrchestratedFindings>[1],
    ) => ({
      result: await findingEngine.generateOrchestratedFindings(input, options),
      honesty: offlineHonesty(options?.mode ?? "mock"),
    }),
    routeGenerateBriefing: async (
      args: {
        engagementId: string;
        sources: Parameters<typeof briefingEngine.generateBriefing>[0]["sources"];
        generatedBy: string;
      },
      options?: Parameters<typeof briefingEngine.generateBriefing>[1],
    ) => ({
      result: await briefingEngine.generateBriefing(
        {
          engagementId: args.engagementId,
          sources: args.sources,
          generatedBy: args.generatedBy,
        },
        options,
      ),
      honesty: offlineHonesty(options?.mode ?? "mock"),
    }),
  };
});

vi.mock("../lib/engineSpineHydrology", async () => {
  const siteContext =
    await vi.importActual<typeof import("@workspace/site-context/server")>(
      "@workspace/site-context/server",
    );
  return {
    routeFetchUsgs3depDem: siteContext.fetchUsgs3depDem,
    routeRunHydrologyWorker: siteContext.runHydrologyWorker,
    routeResolveRainfallForcing: siteContext.resolveRainfallForcing,
  };
});
