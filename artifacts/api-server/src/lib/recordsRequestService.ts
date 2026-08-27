/**
 * P-85 — shared Records Request job orchestration for engagement and PE routes.
 */

import { logger as defaultLogger } from "./logger";
import { isP85CountyFips } from "./p85ClerkPortalRegistry";
import { assertCountyPortalsAllowAutomatedSearch } from "./clerkPortalSearchGate";
import { queryLiveEasementGisForParcel } from "./liveEasementGisQuery";
import { resolveParcelInput } from "./siteTopographyIngest";
import {
  enqueueRecordsRequestJob,
  listRecordsRequestJobsForEngagement,
  recordsRequestJobToWire,
} from "./recordsRequestJobWorker";
import { resolveRecordsSearchTerms } from "./recordsSearchTerms";

export function parcelKeyCountyFips(parcelKey: string): string | null {
  if (!parcelKey.startsWith("apn:")) return null;
  const parts = parcelKey.split(":");
  const fips = parts[1]?.trim();
  return fips && /^\d{5}$/.test(fips) ? fips : null;
}

export type CreateRecordsRequestJobInput = {
  engagementId: string;
  userId: string;
  userEmail?: string | null;
  parcelKey: string;
  countyFips: string;
  placeKey?: string | null;
  log?: typeof defaultLogger;
};

export type CreateRecordsRequestJobResult =
  | {
      ok: true;
      status: 202;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

export async function createRecordsRequestJob(
  input: CreateRecordsRequestJobInput,
): Promise<CreateRecordsRequestJobResult> {
  const log = input.log ?? defaultLogger;
  const { engagementId, userId, parcelKey, countyFips } = input;

  if (!isP85CountyFips(countyFips)) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "county_out_of_scope",
        countyFips,
        message:
          "Records Request is limited to the six P-85 Central Texas counties",
      },
    };
  }

  const keyCounty = parcelKeyCountyFips(parcelKey);
  if (keyCounty && keyCounty !== countyFips) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "parcel_key_county_mismatch",
        parcelKey,
        countyFips,
        keyCounty,
      },
    };
  }

  const portalGate = await assertCountyPortalsAllowAutomatedSearch(countyFips);
  if (!portalGate.ok) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "portal_automated_search_refused",
        code: portalGate.code,
        portalId: portalGate.portalId,
        message: portalGate.message,
      },
    };
  }

  const parcel = await resolveParcelInput(engagementId);
  if (!parcel?.geometry) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "no_parcel_geometry",
        message:
          "Engagement has no derivable parcel polygon; run Generate Layers first",
      },
    };
  }

  let liveInstantGis;
  try {
    liveInstantGis = await queryLiveEasementGisForParcel({
      parcelKey,
      countyFips,
      parcelGeometryGeojson: parcel.geometry,
    });
  } catch (err) {
    log.error(
      { err, engagementId, parcelKey, countyFips },
      "records request: live GIS query failed",
    );
    return {
      ok: false,
      status: 502,
      body: {
        error: "live_gis_query_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  try {
    const searchTerms = await resolveRecordsSearchTerms({
      parcelKey,
      countyFips,
    });

    const enqueued = await enqueueRecordsRequestJob({
      engagementId,
      userId,
      userEmail: input.userEmail ?? null,
      parcelKey,
      countyFips,
      placeKey: input.placeKey ?? null,
      liveInstantGis,
      requestPayload: {
        parcelOrigin: parcel.origin,
        briefingSourceId: parcel.briefingSourceId,
        layerKind: parcel.layerKind,
        ...(searchTerms ? { searchTerms } : {}),
      },
      log,
    });
    return {
      ok: true,
      status: 202,
      body: {
        status: enqueued.alreadyInFlight ? "in-progress" : "accepted",
        jobId: enqueued.jobId,
        jobStatus: enqueued.alreadyInFlight ? "running" : "queued",
        engagementId,
        liveInstantGis,
      },
    };
  } catch (err) {
    log.error(
      { err, engagementId, parcelKey, countyFips },
      "records request: enqueue failed",
    );
    return {
      ok: false,
      status: 500,
      body: {
        error: "internal_worker_error",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function listRecordsRequestJobsWire(
  engagementId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const jobs = await listRecordsRequestJobsForEngagement(engagementId, userId);
  return {
    engagementId,
    jobs: jobs.map(recordsRequestJobToWire),
  };
}
