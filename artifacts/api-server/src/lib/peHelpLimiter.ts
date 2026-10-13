/**
 * Spend guard for POST /api/pe-help/chat.
 *
 * The route is reachable by anonymous visitors (it is the Smart Site Help
 * widget) and every accepted request is one paid model call. This module is
 * the hard cap: a request that is over a cap is refused BEFORE any model call.
 *
 * WHERE THE COUNTERS LIVE. Postgres, in the existing `user_usage_metering`
 * table (PK owner_user_id + meter_key + period_start), through the same atomic
 * upsert-and-return `incrementUserMeter` that per-user API metering uses. No
 * schema change. Every cortex instance increments the same row, so the cap
 * holds across instances (an in-memory counter would be N times the cap).
 * Key shapes (owner_user_id / meter_key):
 *   anon per-IP, 10-minute window  helpchat:ip:<hash>    pe_help_10m:<bucket>
 *   anon per-IP, UTC day           helpchat:ip:<hash>    pe_help_day
 *   anon global, UTC day           helpchat:global:anon  pe_help_day
 *   user, 10-minute window         <user id>             pe_help_user_10m:<bucket>
 *   user, UTC day                  <user id>             pe_help_user_day
 *   signed-in global, UTC day      helpchat:global:user  pe_help_day
 * `helpchat:` cannot collide with a real user id or an `anon_` owner id.
 *
 * Windows are fixed windows (a burst straddling a boundary can use up to 2x
 * the 10-minute figure); the daily cap and the global ceiling bound the total.
 *
 * The counter is incremented BEFORE the cap is compared (one atomic statement
 * per counter, no read-then-write race), so concurrent requests cannot both
 * slip under the cap. A refused request still counts against the window it was
 * refused by; the day counter and the global counter are only touched by
 * requests that passed the tighter windows before them.
 *
 * FAIL CLOSED. If the counter store cannot be reached, or no hash salt is
 * configured, the request is refused (503). An outage of the limiter must not
 * become an open model-spend tap.
 *
 * CLIENT IP. See {@link resolveHelpClientIp}. Raw IPs are never stored or
 * logged; only an HMAC-SHA256 keyed by HELP_CHAT_IP_HASH_SALT.
 */

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db, userUsageMetering } from "@workspace/db";
import { incrementUserMeter } from "./userMetering";
import { isRealSignedInUser } from "./engagementOwnership";
import { logger } from "./logger";

/** Header the browser proxy uses to hand cortex the visitor's IP. */
export const HELP_CLIENT_IP_HEADER = "x-hauska-client-ip";

export const HELP_WINDOW_SECONDS = 600;

export interface HelpLimits {
  anonPerWindow: number;
  anonPerDay: number;
  anonGlobalPerDay: number;
  userPerWindow: number;
  userPerDay: number;
  userGlobalPerDay: number;
  trustedProxyHops: number;
}

const DEFAULTS: HelpLimits = {
  anonPerWindow: 8,
  anonPerDay: 40,
  anonGlobalPerDay: 1000,
  userPerWindow: 20,
  userPerDay: 200,
  userGlobalPerDay: 3000,
  trustedProxyHops: 1,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read per call so an env change takes effect without a redeploy of code. */
export function readHelpLimits(): HelpLimits {
  return {
    anonPerWindow: envInt("HELP_CHAT_ANON_PER_10MIN", DEFAULTS.anonPerWindow),
    anonPerDay: envInt("HELP_CHAT_ANON_PER_DAY", DEFAULTS.anonPerDay),
    anonGlobalPerDay: envInt(
      "HELP_CHAT_ANON_GLOBAL_PER_DAY",
      DEFAULTS.anonGlobalPerDay,
    ),
    userPerWindow: envInt("HELP_CHAT_USER_PER_10MIN", DEFAULTS.userPerWindow),
    userPerDay: envInt("HELP_CHAT_USER_PER_DAY", DEFAULTS.userPerDay),
    userGlobalPerDay: envInt(
      "HELP_CHAT_USER_GLOBAL_PER_DAY",
      DEFAULTS.userGlobalPerDay,
    ),
    trustedProxyHops: Math.max(
      1,
      envInt("HELP_CHAT_TRUSTED_PROXY_HOPS", DEFAULTS.trustedProxyHops),
    ),
  };
}

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function presentedKeys(req: Request): string[] {
  const out: string[] = [];
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer[ ]+(.+)$/i.exec(auth.trim());
    if (m?.[1]?.trim()) out.push(m[1].trim());
  }
  const hk = req.headers["x-hauska-key"];
  if (typeof hk === "string" && hk.trim()) out.push(hk.trim());
  return out;
}

/**
 * True only when the request provably came through the smartsite.cloud
 * browser proxy, the one caller allowed to say what the visitor's IP is.
 *
 *  - After the browser-proxy identity change (LDT #814) the
 *    browserProxyEndUser middleware has authenticated the proxy key, STRIPPED
 *    it from the headers, and set `req.browserProxyEndUser`. That marker is
 *    only ever set by that middleware, never from client input.
 *  - Today (and as a fallback) the proxy presents a key in `Authorization` /
 *    `X-Hauska-Key`: CORTEX_SERVICE_API_KEY (== cortex SERVICE_API_KEY)
 *    before #814, or a BROWSER_PROXY_API_KEYS entry. A request with no valid
 *    key, or a wrong one, is NOT trusted and its IP header is ignored.
 *
 * A holder of SERVICE_API_KEY is already fully trusted by cortex, so letting
 * it assert an IP widens nothing. A browser cannot hold either key.
 */
export function isTrustedClientIpSource(req: Request): boolean {
  if ((req as Request & { browserProxyEndUser?: unknown }).browserProxyEndUser) {
    return true;
  }
  const keys = [
    process.env["SERVICE_API_KEY"]?.trim() ?? "",
    ...(process.env["BROWSER_PROXY_API_KEYS"]?.split(",") ?? []).map((k) =>
      k.trim(),
    ),
  ].filter((k) => k.length > 0);
  if (keys.length === 0) return false;
  const presented = presentedKeys(req);
  let ok = false;
  for (const p of presented) {
    for (const k of keys) if (safeEqual(p, k)) ok = true;
  }
  return ok;
}

/**
 * Canonical string for rate-limit keying, or null if `raw` is not an IP.
 * IPv4-mapped IPv6 collapses to IPv4; other IPv6 collapses to its /64 so a
 * single network cannot mint 2^64 buckets.
 */
export function normalizeIp(raw: string): string | null {
  let ip = raw.trim();
  if (!ip) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return null;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  let groups: string[];
  if (ip.includes("::")) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const fill = new Array<string>(Math.max(0, 8 - h.length - t.length)).fill(
      "0",
    );
    groups = [...h, ...fill, ...t];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
      .join(":") + "::/64"
  );
}

/**
 * The visitor's IP, or null when none can be established.
 *
 *  1. Trusted proxy: the value of X-Hauska-Client-IP (set by hauska-map
 *     api/spine.ts from the platform's own header, never from the browser).
 *  2. Everyone else: the entry the platform ingress appended to
 *     X-Forwarded-For, i.e. counted from the RIGHT by
 *     HELP_CHAT_TRUSTED_PROXY_HOPS (default 1). Entries to the left of that
 *     are client-supplied and are ignored; a client can only prepend.
 *  3. Last resort: the socket address.
 * X-Hauska-Client-IP from an untrusted caller is never read.
 */
export function resolveHelpClientIp(
  req: Request,
  hops = readHelpLimits().trustedProxyHops,
): string | null {
  if (isTrustedClientIpSource(req)) {
    const raw = req.headers[HELP_CLIENT_IP_HEADER];
    const v = Array.isArray(raw) ? raw[0] : raw;
    const ip = typeof v === "string" ? normalizeIp(v) : null;
    if (ip) return ip;
  }
  const xff = req.headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff.join(",") : xff;
  if (typeof xffStr === "string" && xffStr.trim()) {
    const parts = xffStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const pick = parts[parts.length - hops];
    const ip = pick ? normalizeIp(pick) : null;
    if (ip) return ip;
  }
  const sock = req.socket?.remoteAddress;
  return sock ? normalizeIp(sock) : null;
}

/** Salted, one-way key for an IP. null = no salt configured (fail closed). */
export function hashIp(ip: string): string | null {
  const salt = process.env["HELP_CHAT_IP_HASH_SALT"]?.trim();
  const secret = salt || process.env["SESSION_SECRET"]?.trim();
  if (!secret) return null;
  const key = salt ? secret : `pe-help-ip-salt:${secret}`;
  return createHmac("sha256", key).update(ip, "utf8").digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Caller classification
// ---------------------------------------------------------------------------

export type HelpCaller =
  | { cls: "user"; userId: string }
  | { cls: "anon"; ipHash: string }
  | { cls: "unattributable" };

/**
 * Class of caller. A user is ONLY a session the server itself verified
 * (`req.session` comes from a signed token, or from the browser-proxy
 * end-user session after #814). Nothing in the request body or an
 * unverified header can make a caller a "user".
 */
export function classifyHelpCaller(req: Request): HelpCaller {
  const session = req.session;
  if (session && session.audience !== "internal" && isRealSignedInUser(session)) {
    const id = session.requestor?.id;
    if (id) return { cls: "user", userId: id };
  }
  const ip = resolveHelpClientIp(req);
  const h = ip ? hashIp(ip) : null;
  if (!h) return { cls: "unattributable" };
  return { cls: "anon", ipHash: h };
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export type HelpDecision =
  | { ok: true; caller: HelpCaller; used: Record<string, number> }
  | {
      ok: false;
      status: 429 | 503;
      reason:
        | "ip_window"
        | "ip_day"
        | "global_day"
        | "user_window"
        | "user_day"
        | "limiter_unavailable";
      retryAfterSeconds: number;
      caller: HelpCaller;
    };

export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function secondsUntilWindowEnd(now = new Date()): number {
  const ms = HELP_WINDOW_SECONDS * 1000;
  return Math.max(1, Math.ceil((ms - (now.getTime() % ms)) / 1000));
}

/**
 * Count this request against its caps. Returns ok:true only when every cap
 * that applies still has room. Call BEFORE the model; on ok:false the caller
 * must return the refusal and make no model call.
 */
export async function checkAndCountHelpRequest(
  req: Request,
  now = new Date(),
): Promise<HelpDecision> {
  const caller = classifyHelpCaller(req);
  const limits = readHelpLimits();
  const bucket = Math.floor(now.getTime() / (HELP_WINDOW_SECONDS * 1000));
  const win = secondsUntilWindowEnd(now);
  const day = secondsUntilUtcMidnight(now);
  const used: Record<string, number> = {};

  if (caller.cls === "unattributable") {
    // No IP and no salt/secret: we cannot bound this caller. Refuse.
    logger.error("pe-help limiter: cannot attribute caller (no IP or no hash salt)");
    return { ok: false, status: 503, reason: "limiter_unavailable", retryAfterSeconds: 60, caller };
  }

  try {
    if (caller.cls === "anon") {
      const owner = `helpchat:ip:${caller.ipHash}`;
      used["ip_window"] = await incrementUserMeter(owner, `pe_help_10m:${bucket}`);
      if (used["ip_window"] > limits.anonPerWindow) {
        return { ok: false, status: 429, reason: "ip_window", retryAfterSeconds: win, caller };
      }
      used["ip_day"] = await incrementUserMeter(owner, "pe_help_day");
      if (used["ip_day"] > limits.anonPerDay) {
        return { ok: false, status: 429, reason: "ip_day", retryAfterSeconds: day, caller };
      }
      used["global_day"] = await incrementUserMeter("helpchat:global:anon", "pe_help_day");
      if (used["global_day"] > limits.anonGlobalPerDay) {
        return { ok: false, status: 429, reason: "global_day", retryAfterSeconds: day, caller };
      }
    } else {
      used["user_window"] = await incrementUserMeter(caller.userId, `pe_help_user_10m:${bucket}`);
      if (used["user_window"] > limits.userPerWindow) {
        return { ok: false, status: 429, reason: "user_window", retryAfterSeconds: win, caller };
      }
      used["user_day"] = await incrementUserMeter(caller.userId, "pe_help_user_day");
      if (used["user_day"] > limits.userPerDay) {
        return { ok: false, status: 429, reason: "user_day", retryAfterSeconds: day, caller };
      }
      used["global_day"] = await incrementUserMeter("helpchat:global:user", "pe_help_day");
      if (used["global_day"] > limits.userGlobalPerDay) {
        return { ok: false, status: 429, reason: "global_day", retryAfterSeconds: day, caller };
      }
    }
  } catch (err) {
    logger.error({ err }, "pe-help limiter: counter store unavailable; failing closed");
    return { ok: false, status: 503, reason: "limiter_unavailable", retryAfterSeconds: 60, caller };
  }

  maybeSweepOldCounters();
  return { ok: true, caller, used };
}

/**
 * Retention. Rows older than two days are deleted, on roughly 1 in 500
 * requests, fire-and-forget. Only `pe_help*` meter keys are touched.
 */
function maybeSweepOldCounters(): void {
  if (Math.random() >= 1 / 500) return;
  void db
    .delete(userUsageMetering)
    .where(
      sql`${userUsageMetering.meterKey} LIKE 'pe\\_help%' AND ${userUsageMetering.periodStart} < (current_date - 2)`,
    )
    .catch((err: unknown) =>
      logger.warn({ err }, "pe-help limiter: counter sweep failed"),
    );
}
