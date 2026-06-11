/**
 * Vitest setup: offline spine seam for integration tests.
 *
 * C3 routes all reasoning through engine-api in production. Tests keep
 * the pre-C3 offline behavior by delegating spine routing helpers to the
 * local workspace engines / site-context compute (mock mode by default).
 */

import { vi } from "vitest";

if (!process.env.ENGINE_API_URL?.trim()) {
  process.env.ENGINE_API_URL = "http://engine.test.invalid";
}

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
    routeGenerateFindings: findingEngine.generateFindings,
    routeGenerateOrchestratedFindings: findingEngine.generateOrchestratedFindings,
    routeGenerateBriefing: (
      args: {
        engagementId: string;
        sources: Parameters<typeof briefingEngine.generateBriefing>[0]["sources"];
        generatedBy: string;
      },
      options?: Parameters<typeof briefingEngine.generateBriefing>[1],
    ) =>
      briefingEngine.generateBriefing(
        {
          engagementId: args.engagementId,
          sources: args.sources,
          generatedBy: args.generatedBy,
        },
        options,
      ),
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
