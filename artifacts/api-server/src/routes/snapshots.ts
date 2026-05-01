/**
 * /api/snapshots — Revit add-in snapshot ingestion.
 *
 * A04.7 contract change: POST body is a discriminated union.
 *   - { engagementId: uuid, ...sheets }                    → bind to existing
 *   - { createNewEngagement: true, projectName, revitCentralGuid?,
 *       revitDocumentPath?, ...sheets }                    → create new
 *
 * Sticky on rebind: when binding to an existing engagement, we NEVER overwrite
 * its address, jurisdiction, geocode, revitCentralGuid, or revitDocumentPath.
 * The user's chosen identity wins. Edits flow through engagement-edit UI only.
 *
 * Geocode + jurisdiction warmup are kicked off only on the create-new branch.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements, snapshots, sheets } from "@workspace/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  CreateSnapshotBody,
  CreateSnapshotHeader,
  GetSnapshotParams,
} from "@workspace/api-zod";
import { geocodeAddress } from "@workspace/site-context/server";
import {
  keyFromEngagement,
  enqueueWarmupForJurisdiction,
} from "@workspace/codes";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { getSnapshotSecret } from "../lib/snapshotSecret";
import { getHistoryService } from "../atoms/registry";
import type { EngagementEventType } from "../atoms/engagement.atom";

/**
 * Engagement event-type literals used by the producers in this file.
 * Pinning the local constant to {@link EngagementEventType} (the union
 * derived from `ENGAGEMENT_EVENT_TYPES`) keeps the strings here typed
 * against the atom's single source of truth — a rename in the atom
 * makes this assignment fail to compile rather than silently emit a
 * stale name.
 */
const ENGAGEMENT_CREATED_EVENT_TYPE: EngagementEventType = "engagement.created";
const ENGAGEMENT_SNAPSHOT_RECEIVED_EVENT_TYPE: EngagementEventType =
  "engagement.snapshot-received";

const snapshotSecret = getSnapshotSecret();

const router: IRouter = Router();

/** PG unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

interface SnapshotResult {
  id: string;
  receivedAt: string;
  engagementId: string;
  engagementName: string;
  autoCreated: boolean;
}

/**
 * Internal extension of {@link SnapshotResult} carrying the
 * previously-latest snapshot id for the engagement (or `null` if this
 * is the engagement's first snapshot). Used by event emission to fire
 * `snapshot.replaced` against the prior id alongside `snapshot.created`
 * for the new one. Not part of the public HTTP response shape.
 */
interface SnapshotAttachOutcome {
  result: SnapshotResult;
  previousSnapshotId: string | null;
}

/** Stable system actor for snapshot lifecycle events emitted by the ingest path. */
const SNAPSHOT_INGEST_ACTOR = {
  kind: "system" as const,
  id: "snapshot-ingest",
};

/**
 * Best-effort emission of `engagement.created` against a freshly-inserted
 * engagement. Fires only on the create-new branch where the snapshot
 * ingest just inserted the engagement row itself — never on the
 * existing-engagement bind branch, never on the GUID-race rebind (the
 * engagement already exists, somebody else's request already emitted
 * `engagement.created` for it). Failures are swallowed and logged so a
 * history outage cannot roll back the row insert; the event chain is
 * observability, not the source of truth (mirrors the contract used by
 * {@link emitSnapshotLifecycleEvents}).
 */
async function emitEngagementCreatedEvent(
  history: EventAnchoringService,
  outcome: SnapshotAttachOutcome,
  reqLog: typeof logger,
): Promise<void> {
  if (!outcome.result.autoCreated) return;
  try {
    const event = await history.appendEvent({
      entityType: "engagement",
      entityId: outcome.result.engagementId,
      eventType: ENGAGEMENT_CREATED_EVENT_TYPE,
      actor: SNAPSHOT_INGEST_ACTOR,
      payload: {
        engagementName: outcome.result.engagementName,
        firstSnapshotId: outcome.result.id,
      },
    });
    reqLog.info(
      {
        engagementId: outcome.result.engagementId,
        snapshotId: outcome.result.id,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "engagement.created event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        engagementId: outcome.result.engagementId,
        snapshotId: outcome.result.id,
      },
      "engagement.created event append failed — row insert kept",
    );
  }
}

/**
 * Best-effort emission of `engagement.snapshot-received` against the
 * parent engagement on every accepted snapshot ingest. Fires on both
 * branches (existing-engagement bind and create-new), and on the
 * GUID-race rebind path — the engagement just received a snapshot in
 * each of those cases. Failures are swallowed and logged so a history
 * outage cannot roll back the snapshot insert; the event chain is
 * observability, not the source of truth (mirrors the contract used by
 * {@link emitSnapshotLifecycleEvents} and {@link emitEngagementCreatedEvent}).
 */
async function emitEngagementSnapshotReceivedEvent(
  history: EventAnchoringService,
  outcome: SnapshotAttachOutcome,
  reqLog: typeof logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "engagement",
      entityId: outcome.result.engagementId,
      eventType: ENGAGEMENT_SNAPSHOT_RECEIVED_EVENT_TYPE,
      actor: SNAPSHOT_INGEST_ACTOR,
      payload: {
        snapshotId: outcome.result.id,
        projectName: outcome.result.engagementName,
      },
    });
    reqLog.info(
      {
        engagementId: outcome.result.engagementId,
        snapshotId: outcome.result.id,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "engagement.snapshot-received event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        engagementId: outcome.result.engagementId,
        snapshotId: outcome.result.id,
      },
      "engagement.snapshot-received event append failed — row insert kept",
    );
  }
}

/**
 * Best-effort emission of `snapshot.replaced` (against the prior latest
 * snapshot, when one exists) followed by `snapshot.created` for the new
 * snapshot. Failures are swallowed and logged so a history outage cannot
 * roll back or fail the snapshot ingest — the snapshot row is the source
 * of truth, events are observability (mirrors the contract used by the
 * sheet ingest path in `routes/sheets.ts`).
 */
async function emitSnapshotLifecycleEvents(
  history: EventAnchoringService,
  outcome: SnapshotAttachOutcome,
  reqLog: typeof logger,
): Promise<void> {
  const { result, previousSnapshotId } = outcome;
  if (previousSnapshotId) {
    try {
      const event = await history.appendEvent({
        entityType: "snapshot",
        entityId: previousSnapshotId,
        eventType: "snapshot.replaced",
        actor: SNAPSHOT_INGEST_ACTOR,
        payload: {
          replacedBySnapshotId: result.id,
          engagementId: result.engagementId,
        },
      });
      reqLog.info(
        {
          previousSnapshotId,
          newSnapshotId: result.id,
          engagementId: result.engagementId,
          eventId: event.id,
          chainHash: event.chainHash,
        },
        "snapshot.replaced event appended",
      );
    } catch (err) {
      reqLog.error(
        { err, previousSnapshotId, newSnapshotId: result.id },
        "snapshot.replaced event append failed — row insert kept",
      );
    }
  }
  try {
    const event = await history.appendEvent({
      entityType: "snapshot",
      entityId: result.id,
      eventType: "snapshot.created",
      actor: SNAPSHOT_INGEST_ACTOR,
      payload: {
        engagementId: result.engagementId,
        engagementName: result.engagementName,
        autoCreated: result.autoCreated,
        replacedSnapshotId: previousSnapshotId,
      },
    });
    reqLog.info(
      {
        snapshotId: result.id,
        engagementId: result.engagementId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "snapshot.created event appended",
    );
  } catch (err) {
    reqLog.error(
      { err, snapshotId: result.id, engagementId: result.engagementId },
      "snapshot.created event append failed — row insert kept",
    );
  }
}

function deriveCounts(body: Record<string, unknown>) {
  const sheets = body["sheets"];
  const rooms = body["rooms"];
  const levels = body["levels"];
  const walls = body["walls"];

  const sheetCount = Array.isArray(sheets) ? sheets.length : null;
  const roomCount = Array.isArray(rooms) ? rooms.length : null;
  const levelCount = Array.isArray(levels) ? levels.length : null;

  let wallCount: number | null = null;
  if (Array.isArray(walls)) {
    wallCount = walls.length;
  } else if (walls && typeof walls === "object") {
    const wObj = walls as Record<string, unknown>;
    if (typeof wObj["count"] === "number") {
      wallCount = wObj["count"] as number;
    } else if (Array.isArray(wObj["items"])) {
      wallCount = (wObj["items"] as unknown[]).length;
    }
  }

  return { sheetCount, roomCount, levelCount, wallCount };
}

/** Pull a candidate address out of the Revit payload. */
function extractIncomingAddress(payload: Record<string, unknown>): string | null {
  const projectInfo = payload["projectInformation"];
  const rawAddress =
    projectInfo && typeof projectInfo === "object"
      ? ((projectInfo as Record<string, unknown>)["address"] as
          | string
          | undefined)
      : undefined;
  return typeof rawAddress === "string" && rawAddress.trim().length > 0
    ? rawAddress.trim()
    : null;
}

/**
 * PG unique-violation typeguard for the GUID race. Drizzle wraps pg errors in
 * DrizzleQueryError with the underlying pg error on `.cause`, so we check both
 * the top level and `.cause`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: string }).code;
  const cause = (err as { cause?: { code?: string } }).cause?.code;
  return direct === PG_UNIQUE_VIOLATION || cause === PG_UNIQUE_VIOLATION;
}

/**
 * Insert a snapshot under an existing engagement and bump updated_at.
 * Also captures the previously-latest snapshot id for the engagement
 * (looked up inside the same transaction so the read is consistent with
 * the write) so the caller can emit `snapshot.replaced` against it.
 */
async function attachSnapshot(
  engagement: typeof engagements.$inferSelect,
  projectName: string,
  payload: Record<string, unknown>,
  counts: ReturnType<typeof deriveCounts>,
): Promise<SnapshotAttachOutcome> {
  return db.transaction(async (tx) => {
    // Read the previously-latest snapshot for this engagement BEFORE the
    // insert so we know which row is being superseded. Ordered by
    // receivedAt DESC to match every other "latest snapshot" query in
    // the codebase. Empty result means this is the engagement's first
    // snapshot — no `snapshot.replaced` event will be emitted later.
    const priorRows = await tx
      .select({ id: snapshots.id })
      .from(snapshots)
      .where(eq(snapshots.engagementId, engagement.id))
      .orderBy(desc(snapshots.receivedAt))
      .limit(1);
    const previousSnapshotId = priorRows[0]?.id ?? null;

    const [snap] = await tx
      .insert(snapshots)
      .values({
        engagementId: engagement.id,
        projectName,
        payload,
        ...counts,
      })
      .returning();
    await tx
      .update(engagements)
      .set({ updatedAt: new Date() })
      .where(eq(engagements.id, engagement.id));
    return {
      result: {
        id: snap.id,
        receivedAt: snap.receivedAt.toISOString(),
        engagementId: engagement.id,
        engagementName: engagement.name,
        autoCreated: false,
      },
      previousSnapshotId,
    };
  });
}

/**
 * Best-effort: geocode the address (if any) and enqueue jurisdiction
 * warmup. Errors swallowed — user can retry via POST /engagements/:id/geocode.
 * Only ever called on the create-new branch.
 */
function fireGeocodeAndWarmup(
  engagementId: string,
  incomingAddress: string,
): void {
  void (async () => {
    try {
      const geo = await geocodeAddress(incomingAddress);
      if (!geo) return;
      await db
        .update(engagements)
        .set({
          latitude: String(geo.latitude),
          longitude: String(geo.longitude),
          geocodedAt: new Date(geo.geocodedAt),
          geocodeSource: geo.source,
          jurisdictionCity: geo.jurisdictionCity,
          jurisdictionState: geo.jurisdictionState,
          jurisdictionFips: geo.jurisdictionFips,
          siteContextRaw: geo.raw ?? null,
        })
        .where(eq(engagements.id, engagementId));

      const jKey = keyFromEngagement({
        jurisdictionCity: geo.jurisdictionCity,
        jurisdictionState: geo.jurisdictionState,
      });
      if (jKey) {
        try {
          const enq = await enqueueWarmupForJurisdiction(jKey, logger);
          logger.info(
            {
              engagementId,
              jurisdictionKey: jKey,
              enqueued: enq.enqueued,
              skipped: enq.skipped,
            },
            "auto-warmup: enqueued for engagement jurisdiction",
          );
        } catch (warmErr) {
          logger.warn(
            { warmErr, jurisdictionKey: jKey },
            "auto-warmup enqueue failed (non-fatal)",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, engagementId, address: incomingAddress },
        "auto-geocode after snapshot create failed",
      );
    }
  })();
}

router.get("/snapshots", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: snapshots.id,
        engagementId: snapshots.engagementId,
        engagementName: engagements.name,
        projectName: snapshots.projectName,
        sheetCount: snapshots.sheetCount,
        roomCount: snapshots.roomCount,
        levelCount: snapshots.levelCount,
        wallCount: snapshots.wallCount,
        receivedAt: snapshots.receivedAt,
      })
      .from(snapshots)
      .innerJoin(engagements, eq(engagements.id, snapshots.engagementId))
      .orderBy(desc(snapshots.receivedAt));

    res.json(
      rows.map((r) => ({
        ...r,
        receivedAt: r.receivedAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "list snapshots failed");
    res.status(500).json({ error: "Failed to list snapshots" });
  }
});

router.post("/snapshots", async (req: Request, res: Response) => {
  // 1. Auth.
  const headerParse = CreateSnapshotHeader.safeParse({
    "x-snapshot-secret": req.header("x-snapshot-secret"),
  });
  if (
    !headerParse.success ||
    headerParse.data["x-snapshot-secret"] !== snapshotSecret
  ) {
    res.status(401).json({ error: "Invalid snapshot secret" });
    return;
  }

  // 2. Body discrimination via the new union schema.
  const bodyParse = CreateSnapshotBody.safeParse(req.body);
  if (!bodyParse.success) {
    res.status(400).json({ error: "invalid_snapshot_body" });
    return;
  }

  const payload = (req.body ?? {}) as Record<string, unknown>;
  const counts = deriveCounts(payload);

  // Per-request logger (carries pino-http's request id when wired) so
  // event-emission log lines correlate with the originating request.
  const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
  const history = getHistoryService();

  // 3a. Existing-engagement branch.
  if ("engagementId" in bodyParse.data) {
    const engagementId = bodyParse.data.engagementId;
    try {
      const found = await db
        .select()
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      const engagement = found[0];
      if (!engagement) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      // Sticky: address/jurisdiction/GUID/path are NOT touched here.
      const outcome = await attachSnapshot(
        engagement,
        engagement.name,
        payload,
        counts,
      );
      // Best-effort lifecycle events (`snapshot.replaced` for the prior
      // latest snapshot when one exists, `snapshot.created` for the new
      // row). Awaited but never throw — see emitSnapshotLifecycleEvents.
      await emitSnapshotLifecycleEvents(history, outcome, reqLog);
      // Mirror the snapshot lifecycle on the parent engagement so its
      // history endpoint reflects every snapshot landing without
      // consumers cross-joining snapshot history with engagement id.
      await emitEngagementSnapshotReceivedEvent(history, outcome, reqLog);
      res.status(201).json(outcome.result);
    } catch (err) {
      logger.error({ err, engagementId }, "attach snapshot failed");
      res.status(500).json({ error: "Failed to store snapshot" });
    }
    return;
  }

  // 3b. New-engagement branch.
  const { projectName, revitCentralGuid, revitDocumentPath } = bodyParse.data;
  const nameLower = projectName.trim().toLowerCase();
  const guid =
    typeof revitCentralGuid === "string" && revitCentralGuid.trim().length > 0
      ? revitCentralGuid.trim()
      : null;
  const path =
    typeof revitDocumentPath === "string" && revitDocumentPath.trim().length > 0
      ? revitDocumentPath.trim()
      : null;
  const incomingAddress = extractIncomingAddress(payload);

  try {
    // `outcome` carries the new snapshot result + the prior latest
    // snapshot id (always null on the clean create-new branch since the
    // engagement is fresh; populated when the GUID-race fallback rebinds
    // to a pre-existing engagement that already had snapshots).
    let outcome: SnapshotAttachOutcome;
    try {
      outcome = await db.transaction(async (tx) => {
        const [eng] = await tx
          .insert(engagements)
          .values({
            name: projectName,
            nameLower,
            status: "active",
            address: incomingAddress,
            jurisdiction: null,
            revitCentralGuid: guid,
            revitDocumentPath: path,
          })
          .returning();
        const [snap] = await tx
          .insert(snapshots)
          .values({
            engagementId: eng.id,
            projectName,
            payload,
            ...counts,
          })
          .returning();
        return {
          result: {
            id: snap.id,
            receivedAt: snap.receivedAt.toISOString(),
            engagementId: eng.id,
            engagementName: eng.name,
            autoCreated: true,
          },
          previousSnapshotId: null,
        };
      });
    } catch (err) {
      // GUID race: another client raced past /match and created the engagement
      // first. The partial unique index on revit_central_guid rejects our
      // INSERT with 23505. Idempotent fallback: refetch and bind to that row.
      if (guid && isUniqueViolation(err)) {
        const refetch = await db
          .select()
          .from(engagements)
          .where(eq(engagements.revitCentralGuid, guid))
          .limit(1);
        const existing = refetch[0];
        if (!existing) throw err;
        logger.info(
          { engagementId: existing.id, guid },
          "snapshots: GUID race resolved by refetch",
        );
        outcome = await attachSnapshot(existing, projectName, payload, counts);
      } else {
        throw err;
      }
    }

    // Geocode + warmup only on actual create (not race-resolved bind).
    if (outcome.result.autoCreated && incomingAddress) {
      fireGeocodeAndWarmup(outcome.result.engagementId, incomingAddress);
    }

    // Best-effort lifecycle events. Same contract as the existing
    // branch above — `snapshot.replaced` only fires on the GUID-race
    // rebind where the existing engagement already carried snapshots.
    // `engagement.created` only fires when this branch actually inserted
    // a fresh engagement row (autoCreated=true); the GUID-race rebind
    // bound to an existing engagement and must NOT re-emit it.
    await emitSnapshotLifecycleEvents(history, outcome, reqLog);
    await emitEngagementCreatedEvent(history, outcome, reqLog);
    // Always emit `engagement.snapshot-received` against the parent —
    // applies equally to a freshly-inserted engagement (its first
    // snapshot is still a snapshot landing) and to the GUID-race
    // rebind path (engagement existed, just received a new snapshot).
    await emitEngagementSnapshotReceivedEvent(history, outcome, reqLog);

    res.status(201).json(outcome.result);
  } catch (err) {
    logger.error({ err, projectName }, "create snapshot failed");
    res.status(500).json({ error: "Failed to store snapshot" });
  }
});

router.get("/snapshots/:id", async (req: Request, res: Response) => {
  const params = GetSnapshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const rows = await db
      .select({
        id: snapshots.id,
        engagementId: snapshots.engagementId,
        engagementName: engagements.name,
        projectName: snapshots.projectName,
        sheetCount: snapshots.sheetCount,
        roomCount: snapshots.roomCount,
        levelCount: snapshots.levelCount,
        wallCount: snapshots.wallCount,
        receivedAt: snapshots.receivedAt,
        payload: snapshots.payload,
      })
      .from(snapshots)
      .innerJoin(engagements, eq(engagements.id, snapshots.engagementId))
      .where(eq(snapshots.id, params.data.id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }

    const sheetRows = await db
      .select({
        id: sheets.id,
        snapshotId: sheets.snapshotId,
        engagementId: sheets.engagementId,
        sheetNumber: sheets.sheetNumber,
        sheetName: sheets.sheetName,
        viewCount: sheets.viewCount,
        revisionNumber: sheets.revisionNumber,
        revisionDate: sheets.revisionDate,
        thumbnailWidth: sheets.thumbnailWidth,
        thumbnailHeight: sheets.thumbnailHeight,
        fullWidth: sheets.fullWidth,
        fullHeight: sheets.fullHeight,
        sortOrder: sheets.sortOrder,
        createdAt: sheets.createdAt,
      })
      .from(sheets)
      .where(eq(sheets.snapshotId, row.id))
      .orderBy(asc(sheets.sortOrder));

    res.json({
      ...row,
      receivedAt: row.receivedAt.toISOString(),
      sheets: sheetRows.map((s) => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error({ err, id: params.data.id }, "get snapshot failed");
    res.status(500).json({ error: "Failed to fetch snapshot" });
  }
});

/**
 * GET /api/snapshots/:id/sheet-history?limit=N — batch variant of the
 * per-sheet history endpoint that returns the most-recent events for
 * every sheet in a snapshot in a single round trip.
 *
 * The plan-review /sheets page renders one card per sheet and used to
 * issue an `/atoms/sheet/{id}/history` request per card; on a snapshot
 * with dozens of sheets that fan-out hammered the API server with N
 * extra calls per page render. This route collapses the fan-out to one
 * SQL query — a `ROW_NUMBER() OVER (PARTITION BY entity_id ...)` window
 * filtered to the snapshot's sheet ids — and returns a per-sheet list
 * (always present, possibly empty) so the FE can render a stable shape
 * without a second lookup.
 *
 * Limit handling mirrors the per-atom history endpoint: invalid input
 * silently falls back to the default rather than 400ing.
 */
const SHEET_HISTORY_DEFAULT_LIMIT = 5;
const SHEET_HISTORY_MAX_LIMIT = 50;

interface SheetHistoryRow extends Record<string, unknown> {
  entity_id: string;
  event_id: string;
  event_type: string;
  actor: { kind: "user" | "agent" | "system"; id: string };
  occurred_at: string | Date;
  recorded_at: string | Date;
}

router.get(
  "/snapshots/:id/sheet-history",
  async (req: Request, res: Response) => {
    const params = GetSnapshotParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    let limit = SHEET_HISTORY_DEFAULT_LIMIT;
    const rawLimit = req.query["limit"];
    if (typeof rawLimit === "string" && rawLimit.length > 0) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        limit = Math.min(parsed, SHEET_HISTORY_MAX_LIMIT);
      }
    }

    try {
      // 1. Confirm the snapshot exists and collect its sheet ids in one
      //    cheap query. We could collapse this into the window query
      //    below by JOINing on `sheets`, but that would conflate "no
      //    such snapshot" with "snapshot has zero sheets" — distinguishing
      //    the two lets us return a proper 404 for the former.
      const snapshotRow = await db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(eq(snapshots.id, params.data.id))
        .limit(1);
      if (snapshotRow.length === 0) {
        res.status(404).json({ error: "Snapshot not found" });
        return;
      }
      const sheetRows = await db
        .select({ id: sheets.id })
        .from(sheets)
        .where(eq(sheets.snapshotId, params.data.id));
      const sheetIds = sheetRows.map((r) => r.id);

      // Snapshot with no sheets — short-circuit, no need to hit
      // atom_events at all.
      if (sheetIds.length === 0) {
        res.json({ histories: [] });
        return;
      }

      // 2. One SQL query, top-N per sheetId via window function. The
      //    ORDER BY mirrors `PostgresEventAnchoringService.readHistory`
      //    so a single sheet's slice here is byte-identical to the
      //    per-atom endpoint's output (modulo the `entity_id` column).
      const result = await db.execute<SheetHistoryRow>(sql`
        SELECT entity_id, event_id, event_type, actor, occurred_at, recorded_at
          FROM (
            SELECT
              entity_id,
              id AS event_id,
              event_type,
              actor,
              occurred_at,
              recorded_at,
              ROW_NUMBER() OVER (
                PARTITION BY entity_id
                ORDER BY occurred_at DESC, recorded_at DESC, id DESC
              ) AS rn
            FROM atom_events
            WHERE entity_type = 'sheet'
              AND entity_id IN (${sql.join(sheetIds, sql`, `)})
          ) ranked
          WHERE rn <= ${limit}
          ORDER BY entity_id, occurred_at DESC, recorded_at DESC, event_id DESC
      `);

      const eventsBySheet = new Map<
        string,
        Array<{
          id: string;
          eventType: string;
          actor: { kind: string; id: string };
          occurredAt: string;
          recordedAt: string;
        }>
      >();
      for (const id of sheetIds) eventsBySheet.set(id, []);
      for (const row of result.rows) {
        const list = eventsBySheet.get(row.entity_id);
        if (!list) continue;
        list.push({
          id: row.event_id,
          eventType: row.event_type,
          actor: row.actor,
          occurredAt: new Date(row.occurred_at).toISOString(),
          recordedAt: new Date(row.recorded_at).toISOString(),
        });
      }

      res.json({
        histories: sheetIds.map((id) => ({
          sheetId: id,
          events: eventsBySheet.get(id) ?? [],
        })),
      });
    } catch (err) {
      logger.error(
        { err, id: params.data.id },
        "snapshot sheet-history batch read failed",
      );
      res.status(500).json({ error: "history_failed" });
    }
  },
);

export default router;
