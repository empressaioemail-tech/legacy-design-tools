/**
 * Site-drainage materializer — Phase 2D.2/2D.3.
 *
 * Translates `site-drainage.computed` / `.refreshed` atom events into
 * `materializable_elements` rows (engagement-scoped read model).
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { db, materializableElements } from "@workspace/db";
import type { EventAnchoringService } from "@hauska/atom-contract";
import { logger as defaultLogger } from "./logger";
import type { SiteDrainageEventPayload } from "./siteDrainageIngest";

export type SiteDrainageMaterializeResult =
  | {
      status: "ok";
      materializableElementId: string;
      flowLineCount: number;
      drainageZoneCount: number;
    }
  | { status: "no-event"; reason: string }
  | { status: "error"; reason: string };

interface MaterializeArgs {
  engagementId: string;
  atomEventId: string;
  payload: SiteDrainageEventPayload;
  log?: typeof defaultLogger;
}

export async function materializeSiteDrainageFromEvent(
  args: MaterializeArgs,
): Promise<SiteDrainageMaterializeResult> {
  const log = args.log ?? defaultLogger;
  const { engagementId, atomEventId, payload } = args;

  try {
    const insertedId = await db.transaction(async (tx) => {
      await tx
        .update(materializableElements)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(materializableElements.engagementId, engagementId),
            eq(materializableElements.sourceKind, "site-drainage"),
            isNull(materializableElements.supersededAt),
          ),
        );

      const [row] = await tx
        .insert(materializableElements)
        .values({
          engagementId,
          sourceKind: "site-drainage",
          elementKind: "floodplain",
          briefingId: null,
          briefingSourceId: null,
          label: `Site drainage (${payload.hydrology.library} ${payload.hydrology.routing})`,
          locked: false,
          propertySet: {
            atomEventId,
            schemaVersion: payload.schemaVersion,
            siteTopographyAtomEventId: payload.siteTopography.atomEventId,
            siteTopographyDemRef: payload.siteTopography.demGcsObjectPath,
            hydrologyLibrary: payload.hydrology.library,
            hydrologyLibraryVersion: payload.hydrology.libraryVersion,
            hydrologyRouting: payload.hydrology.routing,
            accumulationThreshold: payload.hydrology.accumulationThreshold,
            drainageZonesGeoJson: payload.outputs.drainageZonesGeoJson,
            flowLinesGeoJson: payload.outputs.flowLinesGeoJson,
            rainfallDepthInches: payload.rainfall?.depthInches ?? null,
            rainfallForcingSource: payload.rainfall?.forcingSource ?? null,
            rainfallResultGeoJson: payload.outputs.rainfallResultGeoJson,
            flowLineCount: payload.hydrology.flowLineCount,
            drainageZoneCount: payload.hydrology.drainageZoneCount,
            workerVersion: payload.workerVersion,
            computedAt: payload.computedAt,
          },
        })
        .returning({ id: materializableElements.id });
      if (!row) throw new Error("insert returned no rows");
      return row.id;
    });

    log.info(
      {
        engagementId,
        atomEventId,
        materializableElementId: insertedId,
      },
      "site-drainage materialized",
    );

    return {
      status: "ok",
      materializableElementId: insertedId,
      flowLineCount: payload.hydrology.flowLineCount,
      drainageZoneCount: payload.hydrology.drainageZoneCount,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err, engagementId, atomEventId }, "site-drainage materialization failed");
    return { status: "error", reason };
  }
}

export async function rematerializeSiteDrainageFromLatestEvent(args: {
  history: EventAnchoringService;
  engagementId: string;
  log?: typeof defaultLogger;
}): Promise<SiteDrainageMaterializeResult> {
  const log = args.log ?? defaultLogger;
  let latest: Awaited<ReturnType<EventAnchoringService["latestEvent"]>>;
  try {
    latest = await args.history.latestEvent({
      kind: "atom",
      entityType: "site-drainage",
      entityId: args.engagementId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "error", reason };
  }
  if (!latest) {
    return {
      status: "no-event",
      reason: `No site-drainage events for engagement ${args.engagementId}.`,
    };
  }
  const payload = latest.payload as unknown as SiteDrainageEventPayload;
  return materializeSiteDrainageFromEvent({
    engagementId: args.engagementId,
    atomEventId: latest.id,
    payload,
    log,
  });
}

export async function loadActiveSiteDrainageRow(engagementId: string): Promise<{
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
        eq(materializableElements.sourceKind, "site-drainage"),
        isNull(materializableElements.supersededAt),
      ),
    )
    .orderBy(desc(materializableElements.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row?.propertySet || typeof row.propertySet !== "object") return null;
  return {
    id: row.id,
    propertySet: row.propertySet as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function __countActiveSiteDrainageRowsForTests(
  engagementId: string,
): Promise<number> {
  const rows = await db
    .select({ id: materializableElements.id })
    .from(materializableElements)
    .where(
      and(
        eq(materializableElements.engagementId, engagementId),
        eq(materializableElements.sourceKind, "site-drainage"),
        isNull(materializableElements.supersededAt),
      ),
    );
  return rows.length;
}
