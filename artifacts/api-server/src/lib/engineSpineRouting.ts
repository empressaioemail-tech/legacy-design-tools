/**
 * Route-layer helpers: delegate engine calls to spine engine-api (C3 BFF).
 * All reasoning paths are unconditional — no local lib/*-engine fallback.
 */

import type { Request } from "express";
import type {
  GenerateFindingsInput,
  GenerateFindingsOptions,
  GenerateFindingsResult,
  GenerateOrchestratedFindingsInput,
  GenerateOrchestratedFindingsResult,
} from "@workspace/finding-engine";
import type {
  BriefingSourceInput,
  GenerateBriefingResult,
} from "@workspace/briefing-engine";
import type { EngineHonesty } from "@workspace/engine-core";
import {
  buildSpineGateFrontContext,
  buildSpineGateFrontContextFromTenant,
  postEngineSpine,
} from "./engineSpineClient";
import { unwrapSpineResponse } from "./engineSpineEnvelope";
import {
  rehydrateSpineBriefingResult,
  rehydrateSpineFindingsResult,
} from "./engineSpineDeserialize";

export type SpineRoutedFindingsResult<T> = {
  result: T;
  honesty: EngineHonesty;
};

type BriefingEngineOptions = { mode?: string };
type FindingEngineOptions = GenerateFindingsOptions;

export interface SpineRoutingContext {
  jurisdictionTenant: string | null;
  subjectId?: string;
}

function resolveGateFront(
  req: Request | null,
  ctx: SpineRoutingContext,
  packageId: Parameters<typeof buildSpineGateFrontContextFromTenant>[0]["packageId"],
) {
  if (req) {
    return buildSpineGateFrontContext(req, {
      packageId,
      jurisdictionTenant: ctx.jurisdictionTenant,
    });
  }
  return buildSpineGateFrontContextFromTenant({
    packageId,
    jurisdictionTenant: ctx.jurisdictionTenant,
    subjectId: ctx.subjectId,
  });
}

export async function routeGenerateFindings(
  input: GenerateFindingsInput,
  options: FindingEngineOptions,
  ctx: SpineRoutingContext,
  req: Request | null = null,
): Promise<SpineRoutedFindingsResult<GenerateFindingsResult>> {
  const gateFront = resolveGateFront(req, ctx, "plan-review");

  const raw = await postEngineSpine<unknown>({
    path: "/v1/findings/generate",
    body: { input, mode: options.mode },
    gateFront,
  });

  const { payload, honesty } = unwrapSpineResponse<{
    result: GenerateFindingsResult;
    mode: string;
  }>(raw, { legacyProducer: options.mode });

  return {
    result: rehydrateSpineFindingsResult(payload.result),
    honesty,
  };
}

export async function routeGenerateOrchestratedFindings(
  input: GenerateOrchestratedFindingsInput,
  options: FindingEngineOptions,
  ctx: SpineRoutingContext,
  req: Request | null = null,
): Promise<SpineRoutedFindingsResult<GenerateOrchestratedFindingsResult>> {
  const gateFront = resolveGateFront(req, ctx, "plan-review");

  const raw = await postEngineSpine<unknown>({
    path: "/v1/findings/generate-orchestrated",
    body: { input, mode: options.mode },
    gateFront,
  });

  const { payload, honesty } = unwrapSpineResponse<{
    result: GenerateOrchestratedFindingsResult;
    mode: string;
  }>(raw, { legacyProducer: options.mode });

  return {
    result: rehydrateSpineFindingsResult(payload.result),
    honesty,
  };
}

export async function routeGenerateBriefing(
  args: {
    engagementId: string;
    sources: BriefingSourceInput[];
    generatedBy: string;
    jurisdictionTenant: string | null;
  },
  options: BriefingEngineOptions,
  req: Request | null = null,
  subjectId?: string,
): Promise<SpineRoutedFindingsResult<GenerateBriefingResult>> {
  const gateFront = req
    ? buildSpineGateFrontContext(req, {
        packageId: "briefing",
        jurisdictionTenant: args.jurisdictionTenant,
      })
    : buildSpineGateFrontContextFromTenant({
        packageId: "briefing",
        jurisdictionTenant: args.jurisdictionTenant,
        subjectId,
      });

  const raw = await postEngineSpine<unknown>({
    path: "/v1/briefing/generate",
    body: {
      input: {
        engagementId: args.engagementId,
        sources: args.sources,
        generatedBy: args.generatedBy,
      },
      mode: options?.mode,
    },
    gateFront,
  });

  const { payload, honesty } = unwrapSpineResponse<{
    result: GenerateBriefingResult;
    mode: string;
  }>(raw, { legacyProducer: options?.mode });

  return {
    result: rehydrateSpineBriefingResult(payload.result),
    honesty,
  };
}
