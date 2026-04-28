import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
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

  const bodyParse = CreateSnapshotBody.safeParse(req.body);
  if (!bodyParse.success) {
    res.status(400).json({ error: "projectName is required" });
    return;
  }

  const projectName = bodyParse.data.projectName;
  const nameLower = projectName.trim().toLowerCase();
  const payload = (req.body ?? {}) as Record<string, unknown>;
  const counts = deriveCounts(payload);

  // Pull a candidate address out of the Revit payload (projectInformation.address)
  // so newly auto-created engagements arrive pre-populated.
  const projectInfo = payload["projectInformation"];
  const rawAddress =
    projectInfo && typeof projectInfo === "object"
      ? ((projectInfo as Record<string, unknown>)["address"] as
          | string
          | undefined)
      : undefined;
  const incomingAddress =
    typeof rawAddress === "string" && rawAddress.trim().length > 0
      ? rawAddress.trim()
      : null;

  try {
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(engagements)
        .where(eq(engagements.nameLower, nameLower))
        .limit(1);

      let engagement = existing[0];
      let autoCreated = false;

      if (!engagement) {
        // Race-safe: another concurrent transaction may have just inserted
        // the same nameLower. ON CONFLICT DO NOTHING returns no rows in
        // that case; we re-select to grab the row the other tx wrote.
        const inserted = await tx
          .insert(engagements)
          .values({
            name: projectName,
            nameLower,
            status: "active",
            address: incomingAddress,
            jurisdiction: null,
          })
          .onConflictDoNothing({ target: engagements.nameLower })
          .returning();

        if (inserted[0]) {
          engagement = inserted[0];
          autoCreated = true;
        } else {
          const refetch = await tx
            .select()
            .from(engagements)
            .where(eq(engagements.nameLower, nameLower))
            .limit(1);
          engagement = refetch[0];
          autoCreated = false;
        }
      }

      if (!engagement) {
        throw new Error("Engagement lookup failed after insert race");
      }

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
        autoCreated,
      };
    });

    // Best-effort: if we just created an engagement and Revit gave us an
    // address, kick off geocoding outside the transaction. Errors are
    // swallowed; the user can retry via POST /engagements/:id/geocode.
    if (result.autoCreated && incomingAddress) {
      void (async () => {
        try {
          const geo = await geocodeAddress(incomingAddress);
          if (geo) {
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
              .where(eq(engagements.id, result.engagementId));

            // Demand-driven code-atom warmup. If the geocode resolved to a
            // jurisdiction we recognize, kick off TOC discovery so the next
            // chat question has something to retrieve. Fully best-effort —
            // failures don't roll back the snapshot or the engagement.
            const jKey = keyFromEngagement({
              jurisdictionCity: geo.jurisdictionCity,
              jurisdictionState: geo.jurisdictionState,
            });
            if (jKey) {
              try {
                const enq = await enqueueWarmupForJurisdiction(jKey, logger);
                logger.info(
                  {
                    engagementId: result.engagementId,
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
          }
        } catch (err) {
          logger.warn(
            { err, engagementId: result.engagementId, address: incomingAddress },
            "auto-geocode after snapshot create failed",
          );
        }
      })();
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
