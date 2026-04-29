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
import { asc, desc, eq } from "drizzle-orm";
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
import { logger } from "../lib/logger";
import { getSnapshotSecret } from "../lib/snapshotSecret";

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

/** Insert a snapshot under an existing engagement and bump updated_at. */
async function attachSnapshot(
  engagement: typeof engagements.$inferSelect,
  projectName: string,
  payload: Record<string, unknown>,
  counts: ReturnType<typeof deriveCounts>,
): Promise<SnapshotResult> {
  return db.transaction(async (tx) => {
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
      id: snap.id,
      receivedAt: snap.receivedAt.toISOString(),
      engagementId: engagement.id,
      engagementName: engagement.name,
      autoCreated: false,
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
      const result = await attachSnapshot(
        engagement,
        engagement.name,
        payload,
        counts,
      );
      res.status(201).json(result);
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
    let result: SnapshotResult;
    try {
      result = await db.transaction(async (tx) => {
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
          id: snap.id,
          receivedAt: snap.receivedAt.toISOString(),
          engagementId: eng.id,
          engagementName: eng.name,
          autoCreated: true,
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
        result = await attachSnapshot(existing, projectName, payload, counts);
      } else {
        throw err;
      }
    }

    // Geocode + warmup only on actual create (not race-resolved bind).
    if (result.autoCreated && incomingAddress) {
      fireGeocodeAndWarmup(result.engagementId, incomingAddress);
    }

    res.status(201).json(result);
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

export default router;
