/**
 * P-85 WDLL item 9 — persist corridor derivations on restriction_clauses rows.
 */

import { eq, inArray } from "drizzle-orm";
import {
  db,
  recordedInstruments,
  recordsRequestJobs,
  restrictionClauses,
  type RecordsRequestJob,
  type RestrictionClause,
} from "@workspace/db";
import { resolveParcelInput } from "./siteTopographyIngest";
import {
  assertCorridorDerivationWritable,
  deriveCorridorFromClause,
  type CorridorConstrainsRef,
  type DeriveCorridorResult,
  type GeoJSONPolygon,
  type Ring,
} from "./recordsRequestCorridorDerive";

export type { CorridorConstrainsRef, DeriveCorridorResult } from "./recordsRequestCorridorDerive";
export {
  assertCorridorDerivationWritable,
  deriveCorridorFromClause,
  RecordsRequestCorridorRefuseError,
} from "./recordsRequestCorridorDerive";

export interface ClauseCorridorDeriveResult {
  clauseId: string;
  clauseDid: string;
  status: "derived" | "not_corridor" | "skipped";
  placement?: "placed" | "unplaceable";
  methodId?: string;
  refuseCode?: string;
}

function parcelRingFromGeojson(geojson: unknown): Ring | null {
  const fc = geojson as { features?: unknown[]; type?: string; coordinates?: unknown } | null;
  if (!fc) return null;

  const features =
    fc.type === "FeatureCollection" && Array.isArray(fc.features)
      ? fc.features
      : fc.type === "Feature"
        ? [fc]
        : fc.type === "Polygon" || fc.type === "MultiPolygon"
          ? [{ geometry: fc }]
          : [];

  for (const f of features) {
    const feat = f as {
      geometry?: { type?: string; coordinates?: unknown };
    };
    const geom = feat?.geometry ?? (f as { type?: string; coordinates?: unknown });
    if (!geom || typeof geom !== "object") continue;
    let ring: unknown = null;
    if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
      ring = geom.coordinates[0];
    } else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
      const first = geom.coordinates[0];
      ring = Array.isArray(first) ? first[0] : null;
    }
    if (!Array.isArray(ring) || ring.length < 4) continue;
    return ring as Ring;
  }
  return null;
}

function structuredFieldsWithConstrains(
  prior: unknown,
  constrains: CorridorConstrainsRef,
): Record<string, unknown> {
  const base =
    prior && typeof prior === "object" && !Array.isArray(prior)
      ? { ...(prior as Record<string, unknown>) }
      : {};
  return {
    ...base,
    constrains,
    ...(constrains.widthFt != null ? { corridorWidthFt: constrains.widthFt } : {}),
  };
}

export async function resolveParcelRingForRecordsRequestJob(
  job: RecordsRequestJob,
): Promise<{ ring: Ring; parcelGeometryRef: string } | null> {
  const parcel = await resolveParcelInput(job.engagementId);
  if (!parcel?.geometry) return null;
  const ring = parcelRingFromGeojson(parcel.geometry);
  if (!ring) return null;
  return {
    ring,
    parcelGeometryRef: job.parcelKey,
  };
}

export function deriveCorridorForClauseRow(input: {
  clause: Pick<RestrictionClause, "id" | "clauseDid" | "bodyText">;
  parcelRing: Ring;
  parcelGeometryRef: string;
}): DeriveCorridorResult {
  return deriveCorridorFromClause({
    clauseDid: input.clause.clauseDid,
    bodyText: input.clause.bodyText,
    parcelRing: input.parcelRing,
    parcelGeometryRef: input.parcelGeometryRef,
  });
}

export async function writeCorridorDerivationForClause(input: {
  clauseId: string;
  priorStructuredFields: unknown;
  constrains: CorridorConstrainsRef;
}): Promise<void> {
  assertCorridorDerivationWritable(input.constrains);
  await db
    .update(restrictionClauses)
    .set({
      structuredFields: structuredFieldsWithConstrains(
        input.priorStructuredFields,
        input.constrains,
      ),
    })
    .where(eq(restrictionClauses.id, input.clauseId));
}

async function loadJobClausesForRecordsRequest(jobId: string): Promise<
  Array<
    RestrictionClause & {
      recordsRequestArtifactId: string | null;
    }
  >
> {
  const jobRows = await db
    .select()
    .from(recordsRequestJobs)
    .where(eq(recordsRequestJobs.id, jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) return [];

  const instruments = await db
    .select()
    .from(recordedInstruments)
    .where(eq(recordedInstruments.engagementId, job.engagementId));

  const rrInstrumentIds: string[] = [];
  const artifactByInstrument = new Map<string, string>();
  for (const inst of instruments) {
    const meta = inst.extractMetadata as Record<string, unknown> | null;
    const artifactId =
      typeof meta?.recordsRequestArtifactId === "string"
        ? meta.recordsRequestArtifactId
        : null;
    const rrJobId =
      typeof meta?.recordsRequestJobId === "string" ? meta.recordsRequestJobId : null;
    if (rrJobId === jobId && artifactId) {
      rrInstrumentIds.push(inst.id);
      artifactByInstrument.set(inst.id, artifactId);
    }
  }

  if (rrInstrumentIds.length === 0) return [];

  const clauses = await db
    .select()
    .from(restrictionClauses)
    .where(inArray(restrictionClauses.instrumentId, rrInstrumentIds));

  return clauses.map((c) => ({
    ...c,
    recordsRequestArtifactId: artifactByInstrument.get(c.instrumentId) ?? null,
  }));
}

/** Batch corridor derivation for all clauses on a Records Request job. */
export async function processRecordsRequestCorridorDerivations(
  jobId: string,
): Promise<ClauseCorridorDeriveResult[]> {
  const jobRows = await db
    .select()
    .from(recordsRequestJobs)
    .where(eq(recordsRequestJobs.id, jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) {
    throw new Error("records_request_job_not_found");
  }

  const parcelCtx = await resolveParcelRingForRecordsRequestJob(job);
  if (!parcelCtx) {
    throw new Error("records_request_job_missing_parcel_geometry");
  }

  const clauses = await loadJobClausesForRecordsRequest(jobId);
  const results: ClauseCorridorDeriveResult[] = [];

  for (const clause of clauses) {
    const derived = deriveCorridorForClauseRow({
      clause,
      parcelRing: parcelCtx.ring,
      parcelGeometryRef: parcelCtx.parcelGeometryRef,
    });

    if (derived.kind === "not_corridor_clause") {
      results.push({
        clauseId: clause.id,
        clauseDid: clause.clauseDid,
        status: "not_corridor",
      });
      continue;
    }

    try {
      assertCorridorDerivationWritable(derived.constrains);
      await writeCorridorDerivationForClause({
        clauseId: clause.id,
        priorStructuredFields: clause.structuredFields,
        constrains: derived.constrains,
      });
      results.push({
        clauseId: clause.id,
        clauseDid: clause.clauseDid,
        status: "derived",
        placement: derived.constrains.placement,
        methodId: derived.constrains.methodId,
      });
    } catch (err) {
      const refuseCode =
        err instanceof Error && "code" in err && typeof (err as { code: string }).code === "string"
          ? (err as { code: string }).code
          : "corridor_derive_refused";
      results.push({
        clauseId: clause.id,
        clauseDid: clause.clauseDid,
        status: "skipped",
        refuseCode,
      });
    }
  }

  return results;
}

/** @internal test seam — extract constrains from structured_fields json */
export function readCorridorConstrainsFromStructuredFields(
  structuredFields: unknown,
): CorridorConstrainsRef | null {
  if (!structuredFields || typeof structuredFields !== "object" || Array.isArray(structuredFields)) {
    return null;
  }
  const c = (structuredFields as Record<string, unknown>).constrains;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  return c as CorridorConstrainsRef;
}

/** @internal test seam */
export function parcelRingFromGeojsonForTest(geojson: unknown): Ring | null {
  return parcelRingFromGeojson(geojson);
}
