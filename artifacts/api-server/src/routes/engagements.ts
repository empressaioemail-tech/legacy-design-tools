import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements, snapshots } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { GetEngagementParams } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

interface SnapshotSummaryRow {
  id: string;
  engagementId: string;
  engagementName: string;
  projectName: string;
  sheetCount: number | null;
  roomCount: number | null;
  levelCount: number | null;
  wallCount: number | null;
  receivedAt: string;
}

function toSnapshotSummary(
  row: typeof snapshots.$inferSelect,
  engagementName: string,
): SnapshotSummaryRow {
  return {
    id: row.id,
    engagementId: row.engagementId,
    engagementName,
    projectName: row.projectName,
    sheetCount: row.sheetCount,
    roomCount: row.roomCount,
    levelCount: row.levelCount,
    wallCount: row.wallCount,
    receivedAt: row.receivedAt.toISOString(),
  };
}

router.get("/engagements", async (_req: Request, res: Response) => {
  try {
    const allEngagements = await db
      .select()
      .from(engagements)
      .orderBy(desc(engagements.updatedAt));

    const result = await Promise.all(
      allEngagements.map(async (e) => {
        const [{ count }] = await db
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(snapshots)
          .where(eq(snapshots.engagementId, e.id));

        const latestRows = await db
          .select()
          .from(snapshots)
          .where(eq(snapshots.engagementId, e.id))
          .orderBy(desc(snapshots.receivedAt))
          .limit(1);

        const latest = latestRows[0]
          ? toSnapshotSummary(latestRows[0], e.name)
          : null;

        return {
          id: e.id,
          name: e.name,
          jurisdiction: e.jurisdiction,
          address: e.address,
          status: e.status,
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
          snapshotCount: Number(count) || 0,
          latestSnapshot: latest,
        };
      }),
    );

    res.json(result);
  } catch (err) {
    logger.error({ err }, "list engagements failed");
    res.status(500).json({ error: "Failed to list engagements" });
  }
});

router.get("/engagements/:id", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const rows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, params.data.id))
      .limit(1);

    const e = rows[0];
    if (!e) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const snapshotRows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.engagementId, e.id))
      .orderBy(desc(snapshots.receivedAt));

    const summaries = snapshotRows.map((s) => toSnapshotSummary(s, e.name));
    const latest = summaries[0] ?? null;

    res.json({
      id: e.id,
      name: e.name,
      jurisdiction: e.jurisdiction,
      address: e.address,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      snapshotCount: summaries.length,
      latestSnapshot: latest,
      snapshots: summaries,
    });
  } catch (err) {
    logger.error({ err, id: params.data.id }, "get engagement failed");
    res.status(500).json({ error: "Failed to fetch engagement" });
  }
});

export default router;
