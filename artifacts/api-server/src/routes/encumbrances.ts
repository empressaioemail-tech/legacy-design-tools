/**
 * Phase 1 — engagement-scoped encumbrance upload (R4) per ADR-020.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, engagements, recordedInstruments, restrictionClauses } from "@workspace/db";
import { logger } from "../lib/logger";
import { requireGateEngineServiceAuth } from "../middlewares/gateEngineServiceAuth";
import { assertEngagementServiceTenantScope } from "../lib/gateFrontSeamEngagement";
import { consumePdfUpload } from "../lib/encumbranceMultipart";
import {
  ingestEncumbrancePdfUpload,
  loadEncumbrancesForEngagement,
} from "../lib/encumbranceService";

export { loadEncumbrancesForEngagement } from "../lib/encumbranceService";

const router: IRouter = Router();

router.use(requireGateEngineServiceAuth);

const ENGAGEMENT_PARAMS = z.object({ id: z.string().uuid() });
const CLAUSE_VERIFY_PARAMS = z.object({
  id: z.string().uuid(),
  clauseId: z.string().uuid(),
});

async function loadEngagementOr404(
  engagementId: string,
  res: Response,
): Promise<boolean> {
  const rows = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "engagement_not_found" });
    return false;
  }
  return true;
}

router.post(
  "/engagements/:id/encumbrances/upload",
  async (req: Request, res: Response) => {
    const paramsParse = ENGAGEMENT_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")) {
      res.status(415).json({ error: "expected_multipart" });
      return;
    }

    if (!(await loadEngagementOr404(engagementId, res))) return;

    const tenantScope = await assertEngagementServiceTenantScope(
      req,
      engagementId,
    );
    if (!tenantScope.ok) {
      res.status(tenantScope.status).json(tenantScope.body);
      return;
    }

    const parsed = await consumePdfUpload(req);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }

    try {
      res.status(201).json(
        await ingestEncumbrancePdfUpload({
          upload: parsed.upload,
          scope: { kind: "engagement", engagementId },
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "pdf_too_large") {
        res.status(413).json({ error: "pdf_too_large" });
        return;
      }
      logger.error({ err, engagementId }, "encumbrance upload failed");
      res.status(500).json({ error: "encumbrance_upload_failed" });
    }
  },
);

router.get("/engagements/:id/encumbrances", async (req: Request, res: Response) => {
  const paramsParse = ENGAGEMENT_PARAMS.safeParse(req.params);
  if (!paramsParse.success) {
    res.status(400).json({ error: "invalid_engagement_id" });
    return;
  }
  const engagementId = paramsParse.data.id;
  if (!(await loadEngagementOr404(engagementId, res))) return;

  const tenantScope = await assertEngagementServiceTenantScope(
    req,
    engagementId,
  );
  if (!tenantScope.ok) {
    res.status(tenantScope.status).json(tenantScope.body);
    return;
  }

  try {
    res.json(await loadEncumbrancesForEngagement(engagementId));
  } catch (err) {
    logger.error({ err, engagementId }, "list encumbrances failed");
    res.status(500).json({ error: "encumbrances_list_failed" });
  }
});

router.patch(
  "/engagements/:id/encumbrances/clauses/:clauseId/verify",
  async (req: Request, res: Response) => {
    const paramsParse = CLAUSE_VERIFY_PARAMS.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_params" });
      return;
    }
    const { id: engagementId, clauseId } = paramsParse.data;
    if (!(await loadEngagementOr404(engagementId, res))) return;

    const verifiedAt = new Date();
    const actorDid =
      req.session?.requestor?.id != null
        ? `did:hauska:actor:user:${req.session.requestor.id}`
        : "did:hauska:actor:system:encumbrance-verify";

    const updated = await db
      .update(restrictionClauses)
      .set({ humanVerifiedAt: verifiedAt, verifiedByActorDid: actorDid })
      .where(eq(restrictionClauses.id, clauseId))
      .returning();

    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "clause_not_found" });
      return;
    }

    const owner = await db
      .select({ engagementId: recordedInstruments.engagementId })
      .from(recordedInstruments)
      .where(
        and(
          eq(recordedInstruments.id, row.instrumentId),
          eq(recordedInstruments.engagementId, engagementId),
        ),
      )
      .limit(1);

    if (!owner[0]) {
      res.status(404).json({ error: "clause_not_found" });
      return;
    }

    try {
      res.json(await loadEncumbrancesForEngagement(engagementId));
    } catch (err) {
      logger.error({ err, engagementId, clauseId }, "verify encumbrance clause failed");
      res.status(500).json({ error: "encumbrance_verify_failed" });
    }
  },
);

export default router;
