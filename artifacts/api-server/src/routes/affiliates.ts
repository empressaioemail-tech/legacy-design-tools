/**
 * P-492 3f — Smart Site affiliate pipeline.
 *
 * Public:   POST /property-explorer/v1/affiliates/apply
 *           Unauthenticated, rate-limited. Records (or advances) the partner
 *           to `applied` and emits `affiliate.applied` once per partner.
 * Operator: GET  /property-explorer/v1/internal/affiliates
 *           POST /property-explorer/v1/internal/affiliates
 *           POST /property-explorer/v1/internal/affiliates/:id/stage
 *           Service token only (the Command Center calls these). Setting
 *           `approved` emits `affiliate.approved` once per partner.
 *
 * Affiliates go to their own Resend segment with first name and email only.
 * Nothing here books, calls or sells to a Smart Site subscriber.
 */

import { Router, type Request, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  AFFILIATE_STAGES,
  affiliatePartner,
  db,
  type AffiliateStage,
} from "@workspace/db";
import { requireServiceToken } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";
import { dispatchLifecycleEvent } from "../lib/peLifecycleDispatch";
import {
  affiliateAppliedIdempotencyKey,
  affiliateApprovedIdempotencyKey,
} from "../lib/peLifecycleOutbox";

const router = Router();

const STAGE_AT: Record<AffiliateStage, keyof typeof affiliatePartner.$inferInsert> = {
  identified: "identifiedAt",
  contacted: "contactedAt",
  applied: "appliedAt",
  approved: "approvedAt",
  link_issued: "linkIssuedAt",
  first_conversion: "firstConversionAt",
};

export function affiliateStageIndex(stage: AffiliateStage): number {
  return AFFILIATE_STAGES.indexOf(stage);
}

const EmailSchema = z.string().trim().toLowerCase().email().max(254);
const FirstNameSchema = z.string().trim().min(1).max(60);
const ChannelUrlSchema = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "http(s) only");

const ApplySchema = z
  .object({
    email: EmailSchema,
    firstName: FirstNameSchema,
    channelUrl: ChannelUrlSchema.optional(),
  })
  .strict();

const CreateSchema = z
  .object({
    email: EmailSchema,
    firstName: FirstNameSchema.optional(),
    channelUrl: ChannelUrlSchema.optional(),
    stage: z.enum(["identified", "contacted"]).default("identified"),
  })
  .strict();

const StageSchema = z
  .object({ stage: z.enum(AFFILIATE_STAGES) })
  .strict();

/**
 * In-process fixed-window limiter. Per App Platform instance, so the
 * effective ceiling is this times the instance count (spec max 3).
 */
export function createWindowLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now = Date.now()): boolean => {
    const cur = hits.get(key);
    if (!cur || cur.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      return true;
    }
    if (cur.count >= limit) return false;
    cur.count += 1;
    return true;
  };
}

const perClient = createWindowLimiter(5, 60 * 60 * 1000);
const perEmail = createWindowLimiter(3, 24 * 60 * 60 * 1000);
const global = createWindowLimiter(200, 60 * 60 * 1000);

function clientKey(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

async function emitAffiliateEvent(
  partner: { id: string; email: string },
  event: "affiliate_applied" | "affiliate_approved",
): Promise<void> {
  await dispatchLifecycleEvent({
    affiliatePartnerId: partner.id,
    email: partner.email,
    event,
    idempotencyKey:
      event === "affiliate_applied"
        ? affiliateAppliedIdempotencyKey(partner.id)
        : affiliateApprovedIdempotencyKey(partner.id),
    apply: { event },
  });
}

router.post("/property-explorer/v1/affiliates/apply", async (req: Request, res: Response) => {
  if (!global("all") || !perClient(clientKey(req))) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const parsed = ApplySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_application" });
    return;
  }
  const { email, firstName, channelUrl } = parsed.data;
  if (!perEmail(email)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  try {
    const now = new Date();
    const [existing] = await db
      .select()
      .from(affiliatePartner)
      .where(eq(affiliatePartner.email, email))
      .limit(1);
    let partner: { id: string; email: string };
    if (!existing) {
      const [created] = await db
        .insert(affiliatePartner)
        .values({
          email,
          firstName,
          channelUrl: channelUrl ?? null,
          stage: "applied",
          appliedAt: now,
        })
        .onConflictDoNothing({ target: affiliatePartner.email })
        .returning({ id: affiliatePartner.id, email: affiliatePartner.email });
      if (!created) {
        // Lost a race with a concurrent application for the same email.
        res.status(202).json({ ok: true });
        return;
      }
      partner = created;
    } else {
      partner = existing;
      // Forward only: an application never moves an approved partner back.
      if (affiliateStageIndex(existing.stage) < affiliateStageIndex("applied")) {
        await db
          .update(affiliatePartner)
          .set({
            stage: "applied",
            appliedAt: now,
            firstName: existing.firstName ?? firstName,
            channelUrl: existing.channelUrl ?? channelUrl ?? null,
            updatedAt: now,
          })
          .where(eq(affiliatePartner.id, existing.id));
      }
    }
    await emitAffiliateEvent(partner, "affiliate_applied");
    res.status(202).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "affiliates: application failed");
    res.status(500).json({ error: "application_failed" });
  }
});

router.get(
  "/property-explorer/v1/internal/affiliates",
  requireServiceToken,
  async (_req: Request, res: Response) => {
    const rows = await db
      .select()
      .from(affiliatePartner)
      .orderBy(desc(affiliatePartner.updatedAt))
      .limit(500);
    res.json({ affiliates: rows });
  },
);

router.post(
  "/property-explorer/v1/internal/affiliates",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_affiliate" });
      return;
    }
    const { email, firstName, channelUrl, stage } = parsed.data;
    const now = new Date();
    const [created] = await db
      .insert(affiliatePartner)
      .values({
        email,
        firstName: firstName ?? null,
        channelUrl: channelUrl ?? null,
        stage,
        identifiedAt: now,
        ...(stage === "contacted" ? { contactedAt: now } : {}),
      })
      .onConflictDoNothing({ target: affiliatePartner.email })
      .returning();
    if (!created) {
      res.status(409).json({ error: "affiliate_exists" });
      return;
    }
    res.status(201).json({ affiliate: created });
  },
);

router.post(
  "/property-explorer/v1/internal/affiliates/:id/stage",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!z.string().uuid().safeParse(id).success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = StageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_stage" });
      return;
    }
    const target = parsed.data.stage;
    const [existing] = await db
      .select()
      .from(affiliatePartner)
      .where(eq(affiliatePartner.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (affiliateStageIndex(target) < affiliateStageIndex(existing.stage)) {
      res.status(409).json({ error: "stage_moves_forward_only", stage: existing.stage });
      return;
    }
    const now = new Date();
    const [updated] = await db
      .update(affiliatePartner)
      .set({ stage: target, [STAGE_AT[target]]: now, updatedAt: now })
      .where(eq(affiliatePartner.id, id))
      .returning();
    let lifecycleEventId: string | null = null;
    if (target === "approved") {
      lifecycleEventId = await dispatchLifecycleEvent({
        affiliatePartnerId: existing.id,
        email: existing.email,
        event: "affiliate_approved",
        idempotencyKey: affiliateApprovedIdempotencyKey(existing.id),
        apply: { event: "affiliate_approved" },
      });
    }
    res.json({ affiliate: updated, lifecycleEventId });
  },
);

export default router;
