import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements, snapshots } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { GetEngagementParams, UpdateEngagementBody } from "@workspace/api-zod";
import { geocodeAddress } from "@workspace/site-context/server";
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

type EngagementRow = typeof engagements.$inferSelect;

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildSite(e: EngagementRow) {
  const lat = toNum(e.latitude);
  const lng = toNum(e.longitude);
  const geocode =
    lat !== null && lng !== null
      ? {
          latitude: lat,
          longitude: lng,
          jurisdictionCity: e.jurisdictionCity,
          jurisdictionState: e.jurisdictionState,
          jurisdictionFips: e.jurisdictionFips,
          source: (e.geocodeSource ?? "manual") as "nominatim" | "manual",
          geocodedAt: (e.geocodedAt ?? e.updatedAt).toISOString(),
        }
      : null;

  const projectType = e.projectType as
    | "new_build"
    | "renovation"
    | "addition"
    | "tenant_improvement"
    | "other"
    | null;

  return {
    address: e.address,
    geocode,
    projectType,
    zoningCode: e.zoningCode,
    lotAreaSqft: toNum(e.lotAreaSqft),
  };
}

function toEngagementSummary(
  e: EngagementRow,
  count: number,
  latest: SnapshotSummaryRow | null,
) {
  return {
    id: e.id,
    name: e.name,
    jurisdiction: e.jurisdiction,
    address: e.address,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    snapshotCount: count,
    latestSnapshot: latest,
    site: buildSite(e),
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

        return toEngagementSummary(e, Number(count) || 0, latest);
      }),
    );

    res.json(result);
  } catch (err) {
    logger.error({ err }, "list engagements failed");
    res.status(500).json({ error: "Failed to list engagements" });
  }
});

async function fetchEngagementDetail(id: string) {
  const rows = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, id))
    .limit(1);
  const e = rows[0];
  if (!e) return null;

  const snapshotRows = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.engagementId, e.id))
    .orderBy(desc(snapshots.receivedAt));

  const summaries = snapshotRows.map((s) => toSnapshotSummary(s, e.name));
  const latest = summaries[0] ?? null;

  return {
    e,
    detail: {
      ...toEngagementSummary(e, summaries.length, latest),
      snapshots: summaries,
    },
  };
}

router.get("/engagements/:id", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const out = await fetchEngagementDetail(params.data.id);
    if (!out) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }
    res.json(out.detail);
  } catch (err) {
    logger.error({ err, id: params.data.id }, "get engagement failed");
    res.status(500).json({ error: "Failed to fetch engagement" });
  }
});

router.patch("/engagements/:id", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const bodyParse = UpdateEngagementBody.safeParse(req.body ?? {});
  if (!bodyParse.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const body = bodyParse.data;

  try {
    const existingRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, params.data.id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      update["name"] = body.name;
      update["nameLower"] = body.name.trim().toLowerCase();
    }
    if (body.jurisdiction !== undefined) update["jurisdiction"] = body.jurisdiction;
    if (body.status !== undefined) update["status"] = body.status;
    if (body.projectType !== undefined) update["projectType"] = body.projectType;
    if (body.zoningCode !== undefined) update["zoningCode"] = body.zoningCode;
    if (body.lotAreaSqft !== undefined) {
      update["lotAreaSqft"] =
        body.lotAreaSqft === null ? null : String(body.lotAreaSqft);
    }

    const warnings: string[] = [];

    if (body.address !== undefined) {
      update["address"] = body.address;
      const trimmed = body.address.trim();
      if (trimmed && trimmed !== (existing.address ?? "").trim()) {
        try {
          const geo = await geocodeAddress(trimmed);
          if (geo) {
            update["latitude"] = String(geo.latitude);
            update["longitude"] = String(geo.longitude);
            update["geocodedAt"] = new Date(geo.geocodedAt);
            update["geocodeSource"] = geo.source;
            update["jurisdictionCity"] = geo.jurisdictionCity;
            update["jurisdictionState"] = geo.jurisdictionState;
            update["jurisdictionFips"] = geo.jurisdictionFips;
            update["siteContextRaw"] = geo.raw ?? null;
          } else {
            warnings.push(
              "Geocoding didn't find this address — map view will be unavailable until corrected.",
            );
          }
        } catch (err) {
          logger.warn({ err, address: trimmed }, "geocode failed during PATCH");
          warnings.push(
            "Geocoding service unavailable — saved address without map data.",
          );
        }
      }
    }

    await db
      .update(engagements)
      .set(update)
      .where(eq(engagements.id, existing.id));

    const out = await fetchEngagementDetail(existing.id);
    if (!out) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }
    res.json(warnings.length ? { ...out.detail, warnings } : out.detail);
  } catch (err) {
    logger.error({ err, id: params.data.id }, "patch engagement failed");
    res.status(500).json({ error: "Failed to update engagement" });
  }
});

router.post("/engagements/:id/geocode", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const existingRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, params.data.id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const address = (existing.address ?? "").trim();
    if (!address) {
      res.status(400).json({
        error: "Engagement has no address to geocode",
      });
      return;
    }

    const warnings: string[] = [];
    try {
      const geo = await geocodeAddress(address);
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
            updatedAt: new Date(),
          })
          .where(eq(engagements.id, existing.id));
      } else {
        warnings.push(
          "Geocoding didn't find this address — map view will be unavailable until corrected.",
        );
      }
    } catch (err) {
      logger.warn({ err, address }, "regeocode failed");
      warnings.push("Geocoding service unavailable — try again in a moment.");
    }

    const out = await fetchEngagementDetail(existing.id);
    if (!out) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }
    res.json(warnings.length ? { ...out.detail, warnings } : out.detail);
  } catch (err) {
    logger.error({ err, id: params.data.id }, "regeocode engagement failed");
    res.status(500).json({ error: "Failed to re-geocode engagement" });
  }
});

export default router;
