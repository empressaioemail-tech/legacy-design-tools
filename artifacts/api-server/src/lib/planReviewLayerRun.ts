/**
 * Plan-review BFF helpers — run hazard adapters and load briefing layers
 * without looping through owner-scoped L3 routes.
 */
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import {
  db,
  engagements,
  parcelBriefings,
  briefingSources,
  briefingGenerationJobs,
  type BriefingSource,
} from "@workspace/db";
import {
  ALL_ADAPTERS,
  filterApplicableAdapters,
  resolveJurisdiction,
  runAdapters,
  type AdapterRunOutcome,
} from "@workspace/adapters";
import { createAdapterResponseCache } from "./adapterCache";
import { logger } from "./logger";
import { kickoffBriefingGeneration } from "../routes/parcelBriefings";
import { loadEncumbrancesForEngagement } from "./encumbranceService";
import { buildPrivateRestrictionsBriefing } from "./encumbranceWire";

export const HAZARD_ADAPTER_KEYS = [
  "fema:nfhl-flood-zone",
  "cotality:hazards",
] as const;

export const HAZARD_LAYER_KINDS = [
  "fema-nfhl-flood-zone",
  "cotality-hazards",
] as const;

function hazardLayerWire(source: BriefingSource) {
  return {
    layerKind: source.layerKind,
    provider: source.provider,
    snapshotDate: source.snapshotDate.toISOString(),
    payload: source.payload,
    sourceKind: source.sourceKind,
  };
}

async function loadCurrentHazardSources(
  engagementId: string,
): Promise<BriefingSource[]> {
  const [briefing] = await db
    .select({ id: parcelBriefings.id })
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, engagementId))
    .limit(1);
  if (!briefing) return [];
  return db
    .select()
    .from(briefingSources)
    .where(
      and(
        eq(briefingSources.briefingId, briefing.id),
        isNull(briefingSources.supersededAt),
        inArray(briefingSources.layerKind, [...HAZARD_LAYER_KINDS]),
      ),
    );
}

async function persistAdapterOutcomes(
  engagementId: string,
  outcomes: AdapterRunOutcome[],
): Promise<{ quotaExhausted: boolean; persisted: number }> {
  let quotaExhausted = false;
  let persisted = 0;
  await db.transaction(async (tx) => {
    const [briefing] = await tx
      .insert(parcelBriefings)
      .values({ engagementId })
      .onConflictDoUpdate({
        target: parcelBriefings.engagementId,
        set: { updatedAt: new Date() },
      })
      .returning();
    const supersededAt = new Date();
    for (const outcome of outcomes) {
      if (outcome.status !== "ok" || !outcome.result) {
        if (
          outcome.error?.message?.includes("429") ||
          outcome.error?.message?.toLowerCase().includes("quota")
        ) {
          quotaExhausted = true;
        }
        continue;
      }
      const result = outcome.result;
      const priorRows = await tx
        .select({ id: briefingSources.id })
        .from(briefingSources)
        .where(
          and(
            eq(briefingSources.briefingId, briefing.id),
            eq(briefingSources.layerKind, result.layerKind),
            isNull(briefingSources.supersededAt),
          ),
        )
        .limit(1);
      const priorId = priorRows[0]?.id ?? null;
      if (priorId) {
        await tx
          .update(briefingSources)
          .set({ supersededAt })
          .where(eq(briefingSources.id, priorId));
      }
      const [newSource] = await tx
        .insert(briefingSources)
        .values({
          briefingId: briefing.id,
          layerKind: result.layerKind,
          sourceKind: result.sourceKind,
          provider: `${result.adapterKey} (${result.provider})`,
          snapshotDate: new Date(result.snapshotDate),
          note: result.note ?? null,
          payload: result.payload,
          uploadObjectPath: null,
          uploadOriginalFilename: null,
          uploadContentType: null,
          uploadByteSize: null,
          dxfObjectPath: null,
          glbObjectPath: null,
          conversionStatus: null,
          conversionError: null,
        })
        .returning();
      if (priorId) {
        await tx
          .update(briefingSources)
          .set({ supersededById: newSource.id })
          .where(eq(briefingSources.id, priorId));
      }
      persisted++;
    }
  });
  return { quotaExhausted, persisted };
}

export async function runHazardAdaptersForEngagement(args: {
  engagementId: string;
  log: typeof logger;
}): Promise<
  | { ok: true; quotaExhausted: boolean; persisted: number }
  | { ok: false; error: string; status: number }
> {
  const { engagementId, log } = args;
  const [engRow] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!engRow) {
    return { ok: false, error: "engagement_not_found", status: 404 };
  }
  const lat = engRow.latitude ? Number(engRow.latitude) : NaN;
  const lng = engRow.longitude ? Number(engRow.longitude) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "engagement_not_geocoded", status: 422 };
  }
  const jurisdiction = resolveJurisdiction({
    jurisdictionCity: engRow.jurisdictionCity,
    jurisdictionState: engRow.jurisdictionState,
    jurisdiction: engRow.jurisdiction,
    address: engRow.address,
  });
  const ctx = {
    parcel: {
      latitude: lat,
      longitude: lng,
      address: engRow.address ?? null,
      city: engRow.jurisdictionCity ?? null,
      state: engRow.jurisdictionState ?? null,
    },
    jurisdiction,
    subjectId: `parcel_${engagementId}`,
    timeoutMs: 15_000,
  };
  const applicable = filterApplicableAdapters(ctx, ALL_ADAPTERS).filter((a) =>
    (HAZARD_ADAPTER_KEYS as readonly string[]).includes(a.adapterKey),
  );
  if (applicable.length === 0) {
    return { ok: false, error: "no_applicable_hazard_adapters", status: 422 };
  }
  const cache = createAdapterResponseCache({ log });
  const outcomes = await runAdapters({
    adapters: applicable,
    context: ctx,
    cache,
    forceRefresh: false,
  });
  const { quotaExhausted, persisted } = await persistAdapterOutcomes(
    engagementId,
    outcomes,
  );
  log.info({ engagementId, persisted, quotaExhausted }, "plan-review hazard run finished");
  return { ok: true, quotaExhausted, persisted };
}

export async function loadHazardReportResult(engagementId: string) {
  const sources = await loadCurrentHazardSources(engagementId);
  if (sources.length === 0) {
    return { status: "not-run" as const };
  }
  return {
    status: "ok" as const,
    result: {
      layers: sources.map(hazardLayerWire),
    },
  };
}

export async function runBriefReportForEngagement(args: {
  engagementId: string;
  log: typeof logger;
}): Promise<
  | { ok: true; generationId: string }
  | { ok: false; error: string; status: number; generationId?: string | null }
> {
  const hazardRun = await runHazardAdaptersForEngagement(args);
  if (!hazardRun.ok && hazardRun.error !== "engagement_not_geocoded") {
    // Best-effort layer fetch — briefing may already have sources.
    if (hazardRun.status === 404) {
      return { ok: false, error: hazardRun.error, status: hazardRun.status };
    }
  }
  const outcome = await kickoffBriefingGeneration({
    engagementId: args.engagementId,
    reqLog: args.log,
  });
  if (outcome.kind === "engagement_not_found") {
    return { ok: false, error: "engagement_not_found", status: 404 };
  }
  if (outcome.kind === "no_briefing_sources_for_engagement") {
    return { ok: false, error: "no_briefing_sources_for_engagement", status: 422 };
  }
  if (outcome.kind === "already_in_flight") {
    return {
      ok: false,
      error: "briefing_generation_already_in_flight",
      status: 409,
      generationId: outcome.generationId,
    };
  }
  return { ok: true, generationId: outcome.generationId };
}

export async function loadBriefReportResult(engagementId: string) {
  const [job] = await db
    .select()
    .from(briefingGenerationJobs)
    .where(eq(briefingGenerationJobs.engagementId, engagementId))
    .orderBy(desc(briefingGenerationJobs.startedAt))
    .limit(1);
  if (job?.state === "pending") {
    return { status: "running" as const, generationId: job.id };
  }
  const [briefing] = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, engagementId))
    .limit(1);
  if (!briefing) {
    return { status: "not-run" as const };
  }
  const sources = await db
    .select()
    .from(briefingSources)
    .where(
      and(
        eq(briefingSources.briefingId, briefing.id),
        isNull(briefingSources.supersededAt),
      ),
    );
  const narrative = {
    sectionA: briefing.sectionA,
    sectionB: briefing.sectionB,
    sectionC: briefing.sectionC,
    sectionD: briefing.sectionD,
    sectionE: briefing.sectionE,
    sectionF: briefing.sectionF,
    sectionG: briefing.sectionG,
    generatedAt: briefing.generatedAt?.toISOString() ?? null,
    generationId: briefing.generationId,
  };
  const hasNarrative = Object.values(narrative).some(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
  if (job?.state === "failed") {
    return {
      status: "error" as const,
      error: job.error ?? "briefing_generation_failed",
      result: { sources: sources.map(hazardLayerWire), narrative, jobState: job.state },
    };
  }
  if (!hasNarrative && sources.length === 0) {
    return { status: "not-run" as const };
  }
  return {
    status: "ok" as const,
    result: {
      sources: sources.map((s) => ({
        layerKind: s.layerKind,
        provider: s.provider,
        snapshotDate: s.snapshotDate.toISOString(),
        payload: s.payload,
        sourceKind: s.sourceKind,
      })),
      narrative,
      generation: job
        ? {
            generationId: job.id,
            state: job.state,
            error: job.error,
          }
        : null,
    },
  };
}

export async function loadEncumbrancesReportResult(engagementId: string) {
  const enc = await loadEncumbrancesForEngagement(engagementId);
  if (enc.instruments.length === 0 && enc.clauses.length === 0) {
    return { status: "not-run" as const };
  }
  return {
    status: "ok" as const,
    result: {
      instruments: enc.instruments,
      clauses: enc.clauses,
      privateRestrictions: buildPrivateRestrictionsBriefing(
        enc.instruments,
        enc.clauses,
      ),
    },
  };
}
