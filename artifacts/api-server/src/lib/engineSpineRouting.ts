/**
 * Route-layer helpers: delegate engine calls to spine engine-api when flags on.
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
import {
  generateFindings,
  generateOrchestratedFindings,
} from "@workspace/finding-engine";
import { generateBriefing } from "@workspace/briefing-engine";
import {
  buildSpineGateFrontContext,
  buildSpineGateFrontContextFromTenant,
  postEngineSpine,
} from "./engineSpineClient";
import {
  useSpineBriefing,
  useSpineFindings,
  useSpineFindingsOrchestrated,
} from "./engineSpineFlags";

type BriefingEngineOptions = Parameters<typeof generateBriefing>[1];
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
): Promise<GenerateFindingsResult> {
  if (!useSpineFindings()) {
    return generateFindings(input, options);
  }

  const gateFront = resolveGateFront(req, ctx, "plan-review");

  const payload = await postEngineSpine<{
    result: GenerateFindingsResult;
    mode: string;
  }>({
    path: "/v1/findings/generate",
    body: { input, mode: options.mode },
    gateFront,
  });

  return payload.result;
}

export async function routeGenerateOrchestratedFindings(
  input: GenerateOrchestratedFindingsInput,
  options: FindingEngineOptions,
  ctx: SpineRoutingContext,
  req: Request | null = null,
): Promise<GenerateOrchestratedFindingsResult> {
  if (!useSpineFindingsOrchestrated()) {
    return generateOrchestratedFindings(input, options);
  }

  const gateFront = resolveGateFront(req, ctx, "plan-review");

  const payload = await postEngineSpine<{
    result: GenerateOrchestratedFindingsResult;
    mode: string;
  }>({
    path: "/v1/findings/generate-orchestrated",
    body: { input, mode: options.mode },
    gateFront,
  });

  return payload.result;
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
): Promise<GenerateBriefingResult> {
  if (!useSpineBriefing()) {
    return generateBriefing(
      {
        engagementId: args.engagementId,
        sources: args.sources,
        generatedBy: args.generatedBy,
      },
      options,
    );
  }

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

  const payload = await postEngineSpine<{
    result: GenerateBriefingResult;
    mode: string;
  }>({
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

  return payload.result;
}
