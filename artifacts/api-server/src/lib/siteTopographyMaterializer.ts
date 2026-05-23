/**
 * Site-topography materializer — Phase 2D.x PR3.
 *
 * Translates a `site-topography.ingested` / `.refreshed` atom event
 * into a `materializable_elements` row (the read model). Two entry
 * points:
 *
 *   1. `materializeSiteTopographyFromEvent` — called inline by the
 *      ingest worker after `appendEvent` succeeds. The payload is
 *      already in hand, so we just supersede the prior row + insert
 *      the new one in a transaction.
 *
 *   2. `rematerializeFromLatestEvent` — called by the read path when
 *      a query for the engagement's site-topography row turns up
 *      empty. Re-reads the latest event from the EventAnchoringService
 *      and materializes; recovers from a manual row deletion or a
 *      partial-failure where the event was appended but the row
 *      insert never landed.
 *
 * Supersession is engagement-scoped per the QA-35 lesson — re-ingest
 * stamps `superseded_at` on every prior active site-topography row
 * for the engagement before inserting the new generation. The
 * `materializable_elements_engagement_source_idx` partial index makes
 * the read path's lookup index-served.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  materializableElements,
  atomEvents as atomEventsTable,
} from "@workspace/db";
import type { EventAnchoringService } from "@hauska/atom-contract";
import { logger as defaultLogger } from "./logger";
import type { SiteTopographyEventPayload } from "./siteTopographyIngest";

export type SiteTopographyMaterializeResult =
  | {
      status: "ok";
      materializableElementId: string;
      chainHash: string;
      demGcsObjectPath: string;
      contourCount: number;
      contourIntervalMeters: number;
    }
  | {
      status: "no-event";
      reason: string;
    }
  | {
      status: "error";
      reason: string;
    };

interface MaterializeArgs {
  engagementId: string;
  atomEventId: string;
  payload: SiteTopographyEventPayload;
  log?: typeof defaultLogger;
}

/**
 * Translate an event payload (held in memory) into the
 * materializable_elements row. Engagement-scoped supersession.
 * Idempotent on `atom_event_id` — re-running with the same event id
 * returns the existing row instead of inserting a duplicate.
 */
export async function materializeSiteTopographyFromEvent(
  args: MaterializeArgs,
): Promise<SiteTopographyMaterializeResult> {
  const log = args.log ?? defaultLogger;
  const { engagementId, atomEventId, payload } = args;

  try {
    // Check whether a row already exists for this exact event — the
    // worker's own re-call after a transient DB blip should be a
    // no-op rather than an insert + supersede race.
    const existing = await db
      .select({
        id: materializableElements.id,
        propertySet: materializableElements.propertySet,
      })
      .from(materializableElements)
      .where(
        and(
          eq(materializableElements.engagementId, engagementId),
          eq(materializableElements.sourceKind, "site-topography"),
          isNull(materializableElements.supersededAt),
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (
      existingRow &&
      existingRow.propertySet &&
      typeof existingRow.propertySet === "object"
    ) {
      const ps = existingRow.propertySet as { atomEventId?: unknown };
      if (ps.atomEventId === atomEventId) {
        // Same event already materialized — short-circuit.
        return {
          status: "ok",
          materializableElementId: existingRow.id,
          chainHash: "",
          demGcsObjectPath: payload.dem.gcsObjectPath,
          contourCount: payload.contours.featureCount,
          contourIntervalMeters: payload.contours.intervalMeters,
        };
      }
    }

    const insertedId = await db.transaction(async (tx) => {
      // 1) Supersede any existing active site-topography row for the
      //    engagement.
      await tx
        .update(materializableElements)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(materializableElements.engagementId, engagementId),
            eq(materializableElements.sourceKind, "site-topography"),
            isNull(materializableElements.supersededAt),
          ),
        );

      // 2) Insert the new row.
      const [row] = await tx
        .insert(materializableElements)
        .values({
          engagementId,
          sourceKind: "site-topography",
          // `terrain` is the existing kind that semantically fits a
          // contour-line / DEM artifact. element_kind is the
          // geometry-payload-shape discriminator; sourceKind is the
          // provenance lens. Pairing terrain + site-topography keeps
          // the per-kind read paths in the C# add-in / future Three.js
          // viewer unchanged.
          elementKind: "terrain",
          briefingId: null,
          briefingSourceId: payload.parcel.briefingSourceId,
          label: `Site topography (USGS 3DEP @ ${payload.dem.resolutionMeters}m, ${payload.contours.intervalMeters}m interval)`,
          locked: false,
          // `propertySet` is the read-model JSON. Carries the GCS ref,
          // the contour FeatureCollection, the parcel + catchment
          // provenance, and the atom-event back-pointer for replay.
          propertySet: {
            atomEventId,
            schemaVersion: payload.schemaVersion,
            demRef: payload.dem.gcsObjectPath,
            demEndpoint: payload.dem.endpoint,
            demFetchedAt: payload.dem.fetchedAt,
            demSource: payload.dem.source,
            demResolutionMeters: payload.dem.resolutionMeters,
            demWidthPx: payload.dem.widthPx,
            demHeightPx: payload.dem.heightPx,
            minElevationMeters: payload.dem.minElevation,
            maxElevationMeters: payload.dem.maxElevation,
            parcelOrigin: payload.parcel.origin,
            parcelBriefingSourceId: payload.parcel.briefingSourceId,
            parcelLayerKind: payload.parcel.layerKind,
            parcelBbox: payload.parcel.parcelBbox,
            catchmentBufferMeters: payload.catchment.bufferMeters,
            catchmentBbox: payload.catchment.bbox,
            contoursGeoJson: payload.contours.featureCollection,
            contourIntervalMeters: payload.contours.intervalMeters,
            contourThresholds: payload.contours.thresholds,
            contourFeatureCount: payload.contours.featureCount,
            workerVersion: payload.workerVersion,
          },
        })
        .returning({ id: materializableElements.id });
      if (!row) {
        throw new Error("materializable_elements insert returned no rows");
      }
      return row.id;
    });

    log.info(
      {
        engagementId,
        atomEventId,
        materializableElementId: insertedId,
        contourCount: payload.contours.featureCount,
      },
      "site-topography materialized",
    );

    return {
      status: "ok",
      materializableElementId: insertedId,
      chainHash: "",
      demGcsObjectPath: payload.dem.gcsObjectPath,
      contourCount: payload.contours.featureCount,
      contourIntervalMeters: payload.contours.intervalMeters,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, engagementId, atomEventId },
      "site-topography materialization failed",
    );
    return { status: "error", reason };
  }
}

/**
 * Read path / replay helper. Looks up the latest
 * `site-topography.ingested` or `.refreshed` event for the engagement
 * and materializes it. Returns `no-event` (not `error`) when no
 * event has been appended yet — the caller (the GET route or the
 * SiteMap fetch) should treat this as "no topo yet" and prompt the
 * operator to run the refresh.
 */
export async function rematerializeFromLatestEvent(args: {
  history: EventAnchoringService;
  engagementId: string;
  log?: typeof defaultLogger;
}): Promise<SiteTopographyMaterializeResult> {
  const log = args.log ?? defaultLogger;
  let latest: Awaited<ReturnType<EventAnchoringService["latestEvent"]>>;
  try {
    latest = await args.history.latestEvent({
      kind: "atom",
      entityType: "site-topography",
      entityId: args.engagementId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, engagementId: args.engagementId },
      "site-topography read: latestEvent lookup failed",
    );
    return { status: "error", reason };
  }
  if (!latest) {
    return {
      status: "no-event",
      reason: `No site-topography events for engagement ${args.engagementId}; run POST /api/engagements/:id/site-topography/refresh.`,
    };
  }
  const payload = latest.payload as unknown as SiteTopographyEventPayload;
  return materializeSiteTopographyFromEvent({
    engagementId: args.engagementId,
    atomEventId: latest.id,
    payload,
    log,
  });
}

/**
 * Read helper — returns the current active `materializable_elements`
 * row for the engagement's site-topography lens, or null when no
 * row exists. Used by the GET route to short-circuit the
 * `rematerializeFromLatestEvent` call when a fresh row is already
 * present.
 */
export async function loadActiveSiteTopographyRow(
  engagementId: string,
): Promise<{
  id: string;
  propertySet: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const rows = await db
    .select({
      id: materializableElements.id,
      propertySet: materializableElements.propertySet,
      createdAt: materializableElements.createdAt,
      updatedAt: materializableElements.updatedAt,
    })
    .from(materializableElements)
    .where(
      and(
        eq(materializableElements.engagementId, engagementId),
        eq(materializableElements.sourceKind, "site-topography"),
        isNull(materializableElements.supersededAt),
      ),
    )
    .orderBy(desc(materializableElements.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!row.propertySet || typeof row.propertySet !== "object") return null;
  return {
    id: row.id,
    propertySet: row.propertySet as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Test-only helper — count active site-topography rows for an
 * engagement. Useful for the supersession assertion in re-run tests.
 * Exported instead of inlined so the test stays readable.
 */
export async function __countActiveSiteTopographyRowsForTests(
  engagementId: string,
): Promise<number> {
  const rows = await db
    .select({ id: materializableElements.id })
    .from(materializableElements)
    .where(
      and(
        eq(materializableElements.engagementId, engagementId),
        eq(materializableElements.sourceKind, "site-topography"),
        isNull(materializableElements.supersededAt),
      ),
    );
  return rows.length;
}

/** Re-exported for the test suite. Lets us spelunk the atom_events table. */
export const __atomEvents = atomEventsTable;
