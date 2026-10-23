/**
 * T2-WATCH (Smart Site mobile, 2026-10-22) — the Watching tab API.
 *
 *   GET  /api/watching                 -> {items:[{parcelNodeId, address, savedAt, lastCheckedAt, changes:[...]}]}
 *   POST /api/watching/seen            {changeIds}         -> {ok, updated}
 *   GET  /api/watching/push/key        -> {publicKey}
 *   POST /api/watching/push/subscribe  {subscription}      -> {ok}
 *   POST /api/watching/push/unsubscribe {endpoint?}        -> {ok, removed}
 *   POST /api/watching/internal/detect {userId?, force?}   service token only
 *
 * Auth: a live Smart Site session TOKEN (T1-A server-validated sessions: the
 * session middleware verifies it and the revocation middleware checks its
 * row), sent directly as Bearer or through the browser proxy. Anonymous,
 * revoked, or service-impersonation callers get 401
 * {error:"authentication_required"}. Push routes answer 503
 * {error:"push_not_configured"} while the VAPID env is absent.
 *
 * Every saved property is watched: items are the user's saved properties,
 * newest first, each with its changes (every unseen change, plus seen ones from the last 90 days;
 * at most 20 per parcel, newest first). `address` is the saved label, else the reader's
 * situs words from the last snapshot, else null ("Not on record" in the UI).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { isAnonymousOwnerId } from "../lib/anonymousOwnerCookie";
import { requireServiceToken } from "../middlewares/serviceAuth";
import { detectWatchChanges, watchAddress, type WatchFacts } from "../lib/peWatching";
import { webPushConfig } from "../lib/peWebPush";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CHANGE_WINDOW_DAYS = 90;
const CHANGES_PER_PARCEL = 20;

/** The signed-in user's id, or null (and a 401 already sent). */
function sessionUser(req: Request, res: Response): string | null {
  const requestor = req.session?.requestor;
  if (
    !req.peSessionToken ||
    requestor?.kind !== "user" ||
    !requestor.id ||
    isAnonymousOwnerId(requestor.id)
  ) {
    res.status(401).json({ error: "authentication_required" });
    return null;
  }
  return requestor.id;
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return new Date(v).toISOString();
  return null;
}

router.get("/watching", async (req: Request, res: Response) => {
  const userId = sessionUser(req, res);
  if (!userId) return;
  try {
    const saved = await db.execute<{
      parcel_node_id: string;
      label: string | null;
      saved_at: Date;
      last_read_at: Date | null;
      facts: WatchFacts | null;
    }>(sql`
      SELECT sp.parcel_node_id, max(sp.label) AS label, min(sp.created_at) AS saved_at,
             ws.last_read_at, ws.facts
        FROM pe_saved_properties sp
        LEFT JOIN pe_watch_snapshots ws
          ON ws.owner_user_id = sp.owner_user_id AND ws.parcel_node_id = sp.parcel_node_id
       WHERE sp.owner_user_id = ${userId}
       GROUP BY sp.parcel_node_id, ws.last_read_at, ws.facts
       ORDER BY max(sp.updated_at) DESC`);
    const changes = await db.execute<{
      id: string;
      parcel_node_id: string;
      kind: string;
      title: string;
      detected_at: Date;
      seen_at: Date | null;
      source_url: string | null;
      rn: number;
    }>(sql`
      SELECT * FROM (
        SELECT id::text AS id, parcel_node_id, kind, title, detected_at, seen_at, source_url,
               row_number() OVER (PARTITION BY parcel_node_id ORDER BY detected_at DESC, id) AS rn
          FROM pe_watch_changes
         WHERE owner_user_id = ${userId}
           AND (seen_at IS NULL OR detected_at > now() - make_interval(days => ${CHANGE_WINDOW_DAYS}))
      ) c WHERE rn <= ${CHANGES_PER_PARCEL}
      ORDER BY detected_at DESC, id`);
    const byParcel = new Map<string, Array<Record<string, unknown>>>();
    for (const c of changes.rows) {
      const list = byParcel.get(c.parcel_node_id) ?? [];
      list.push({
        id: c.id,
        kind: c.kind,
        title: c.title,
        detectedAt: iso(c.detected_at),
        seen: c.seen_at !== null,
        ...(c.source_url ? { sourceUrl: c.source_url } : {}),
      });
      byParcel.set(c.parcel_node_id, list);
    }
    res.json({
      items: saved.rows.map((r) => ({
        parcelNodeId: r.parcel_node_id,
        address: watchAddress(r.label, r.facts),
        savedAt: iso(r.saved_at),
        lastCheckedAt: iso(r.last_read_at),
        changes: byParcel.get(r.parcel_node_id) ?? [],
      })),
    });
  } catch (err) {
    logger.error({ err }, "watching: list failed");
    res.status(500).json({ error: "watching_failed" });
  }
});

const SeenSchema = z.object({ changeIds: z.array(z.string().uuid()).min(1).max(500) });

router.post("/watching/seen", async (req: Request, res: Response) => {
  const userId = sessionUser(req, res);
  if (!userId) return;
  const parsed = SeenSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const ids = parsed.data.changeIds;
  const r = await db.execute(sql`
    UPDATE pe_watch_changes SET seen_at = now()
     WHERE owner_user_id = ${userId} AND seen_at IS NULL
       AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  res.json({ ok: true, updated: r.rowCount ?? 0 });
});

function pushConfiguredOr503(res: Response): ReturnType<typeof webPushConfig> {
  const config = webPushConfig();
  if (!config) res.status(503).json({ error: "push_not_configured" });
  return config;
}

router.get("/watching/push/key", (req: Request, res: Response) => {
  const userId = sessionUser(req, res);
  if (!userId) return;
  const config = pushConfiguredOr503(res);
  if (!config) return;
  res.json({ publicKey: config.publicKey });
});

const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "https only"),
    keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(256) }),
  }),
});

router.post("/watching/push/subscribe", async (req: Request, res: Response) => {
  const userId = sessionUser(req, res);
  if (!userId) return;
  if (!pushConfiguredOr503(res)) return;
  const parsed = SubscribeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_subscription" });
    return;
  }
  const { endpoint, keys } = parsed.data.subscription;
  await db.execute(sql`
    INSERT INTO pe_push_subscriptions (owner_user_id, endpoint, keys)
    VALUES (${userId}, ${endpoint}, ${JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth })}::jsonb)
    ON CONFLICT (endpoint) DO UPDATE
      SET owner_user_id = EXCLUDED.owner_user_id, keys = EXCLUDED.keys, failures = 0`);
  res.json({ ok: true });
});

const UnsubscribeSchema = z.object({ endpoint: z.string().max(2048).optional() });

router.post("/watching/push/unsubscribe", async (req: Request, res: Response) => {
  const userId = sessionUser(req, res);
  if (!userId) return;
  if (!pushConfiguredOr503(res)) return;
  const parsed = UnsubscribeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const endpoint = parsed.data.endpoint;
  const r = endpoint
    ? await db.execute(sql`
        DELETE FROM pe_push_subscriptions WHERE owner_user_id = ${userId} AND endpoint = ${endpoint}`)
    : await db.execute(sql`DELETE FROM pe_push_subscriptions WHERE owner_user_id = ${userId}`);
  res.json({ ok: true, removed: r.rowCount ?? 0 });
});

const DetectSchema = z.object({ userId: z.string().min(1).max(256).optional(), force: z.boolean().optional() });

/** Manual trigger for the integration seat / operators. Service token only. */
router.post("/watching/internal/detect", requireServiceToken, async (req: Request, res: Response) => {
  const parsed = DetectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const result = await detectWatchChanges(parsed.data.userId, { force: parsed.data.force === true });
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err }, "watching: manual detect failed");
    res.status(500).json({ error: "detect_failed" });
  }
});

export default router;
