/**
 * T2-WATCH (2026-10-22) — Web Push for the Watching tab, via `web-push`
 * (VAPID). Keys come from env and are never logged:
 *   WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY, WEB_PUSH_SUBJECT
 * (`scripts/generate-vapid-keys.mjs` prints a fresh pair for the secret store).
 *
 * When any of the three is absent, push is "not configured": the push routes
 * answer 503 {error:"push_not_configured"} and detection still runs, it just
 * sends nothing.
 *
 * One notification per user per detection run, summarising that run's
 * changes ("Sturgeon Dr: FEMA flood map change", "+N more"), with
 * data.url "/?parcel=<id>&tab=map" for the first change. A 404 or 410 from
 * the push service deletes that subscription; any other failure increments
 * `failures`; a success stamps `last_ok_at` and resets `failures`.
 */

import webpush from "web-push";
import { sql } from "drizzle-orm";
import { db, type PeWatchChangeKind } from "@workspace/db";
import { logger } from "./logger";

type Log = Pick<typeof logger, "info" | "warn" | "error">;

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

/** The VAPID config, or null when push is not configured. */
export function webPushConfig(): VapidConfig | null {
  const publicKey = process.env["WEB_PUSH_VAPID_PUBLIC_KEY"]?.trim();
  const privateKey = process.env["WEB_PUSH_VAPID_PRIVATE_KEY"]?.trim();
  const subject = process.env["WEB_PUSH_SUBJECT"]?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export type WatchPushChange = {
  id: string;
  userId: string;
  parcelNodeId: string;
  address: string | null;
  kind: PeWatchChangeKind;
  title: string;
};

/** "1102 Hill St, Bastrop, TX" -> "1102 Hill St". */
export function shortAddress(address: string | null, parcelNodeId: string): string {
  const first = address?.split(",")[0]?.trim();
  return first || `Parcel ${parcelNodeId}`;
}

/** The notification for one user's changes in one run. */
export function watchPushPayload(changes: WatchPushChange[]): {
  title: string;
  body: string;
  tag: string;
  data: { url: string; changeIds: string[] };
} {
  const first = changes[0]!;
  const place = shortAddress(first.address, first.parcelNodeId);
  const more = changes.length - 1;
  return {
    title: `Smart Site · ${place}`,
    body: `${place}: ${first.title}${more > 0 ? ` · +${more} more` : ""}`,
    tag: "smart-site-watching",
    data: {
      url: `/?parcel=${encodeURIComponent(first.parcelNodeId)}&tab=map`,
      changeIds: changes.map((c) => c.id),
    },
  };
}

export type PushRunResult = {
  configured: boolean;
  usersNotified: number;
  sent: number;
  dropped: number;
  failed: number;
};

function statusOf(err: unknown): number | null {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : null;
}

/** Send one summary push per user to every subscription that user holds. */
export async function sendWatchPushes(
  changes: WatchPushChange[],
  opts: { log?: Log } = {},
): Promise<PushRunResult> {
  const log = opts.log ?? logger;
  const config = webPushConfig();
  const out: PushRunResult = { configured: Boolean(config), usersNotified: 0, sent: 0, dropped: 0, failed: 0 };
  if (!config || changes.length === 0) return out;

  const byUser = new Map<string, WatchPushChange[]>();
  for (const c of changes) {
    const list = byUser.get(c.userId) ?? [];
    list.push(c);
    byUser.set(c.userId, list);
  }

  for (const [userId, list] of byUser) {
    const subs = await db.execute<{ id: string; endpoint: string; keys: { p256dh?: string; auth?: string } }>(sql`
      SELECT id::text AS id, endpoint, keys FROM pe_push_subscriptions WHERE owner_user_id = ${userId}`);
    if (subs.rows.length === 0) continue;
    const payload = JSON.stringify(watchPushPayload(list));
    let anyOk = false;
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys?.p256dh ?? "", auth: sub.keys?.auth ?? "" } },
          payload,
          {
            vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
            TTL: 24 * 60 * 60,
          },
        );
        out.sent += 1;
        anyOk = true;
        await db.execute(sql`
          UPDATE pe_push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = ${sub.id}::uuid`);
      } catch (err) {
        const status = statusOf(err);
        if (status === 404 || status === 410) {
          out.dropped += 1;
          await db.execute(sql`DELETE FROM pe_push_subscriptions WHERE id = ${sub.id}::uuid`);
        } else {
          out.failed += 1;
          await db.execute(sql`
            UPDATE pe_push_subscriptions SET failures = failures + 1 WHERE id = ${sub.id}::uuid`);
          // Never log the endpoint (a bearer-like capability URL) or keys.
          log.warn({ status, subscriptionId: sub.id }, "watching: push send failed");
        }
      }
    }
    if (anyOk) out.usersNotified += 1;
  }
  return out;
}
