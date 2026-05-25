/**
 * POST /api/engagements/:id/request-coverage — queue operator coverage request (v2).
 * cc-agent-E consumes `coverage_requests` rows (QA-20); no ingest here.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements, coverageRequests } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ note: z.string().max(2000).optional() }).optional();

router.use(requireServiceTokenOrSession);

router.post(
  "/engagements/:id/request-coverage",
  async (req: Request, res: Response) => {
    const params = Params.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const bodyParsed = Body.safeParse(req.body ?? {});
    const note = bodyParsed.success ? bodyParsed.data?.note : undefined;

    try {
      const [row] = await db
        .select()
        .from(engagements)
        .where(eq(engagements.id, params.data.id))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "Engagement not found" });
        return;
      }

      const now = new Date();
      if (
        row.coverageRequestedAt &&
        now.getTime() - row.coverageRequestedAt.getTime() < COOLDOWN_MS
      ) {
        res.status(202).json({
          status: "queued",
          engagementId: row.id,
          coverageRequestedAt: row.coverageRequestedAt.toISOString(),
          idempotent: true,
        });
        return;
      }

      await db.insert(coverageRequests).values({
        engagementId: row.id,
        jurisdictionState: row.jurisdictionState,
        jurisdictionCity: row.jurisdictionCity,
        jurisdictionFips: row.jurisdictionFips,
        note: note ?? null,
        status: "open",
      });

      await db
        .update(engagements)
        .set({ coverageRequestedAt: now, updatedAt: now })
        .where(eq(engagements.id, row.id));

      logger.info(
        {
          engagementId: row.id,
          jurisdictionState: row.jurisdictionState,
          coverageStatus: row.coverageStatus,
        },
        "coverage_request.queued",
      );

      res.status(202).json({
        status: "queued",
        engagementId: row.id,
        coverageRequestedAt: now.toISOString(),
      });
    } catch (err) {
      logger.error({ err }, "request-coverage failed");
      res.status(500).json({ error: "Failed to queue coverage request" });
    }
  },
);

export default router;
