/**
 * HMAC-signed session tokens for cortex-api hosted login.
 *
 * Uses SESSION_SECRET (already in deploy docs). No external IdP — the
 * extension C2 cut will consume these via chrome.identity.launchWebAuthFlow
 * against the hosted login route.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionUser } from "../middlewares/session";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const DEFAULT_TENANT_ID = "default";

export type SignedSessionPayload = SessionUser & {
  exp: number;
  iat: number;
  v: number;
};

function sessionSecret(): string {
  const secret = process.env["SESSION_SECRET"]?.trim();
  if (!secret) {
    throw new Error("SESSION_SECRET is required for signed session tokens");
  }
  return secret;
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function sign(data: string): string {
  return b64urlEncode(
    createHmac("sha256", sessionSecret()).update(data).digest(),
  );
}

export function mintSessionToken(
  session: SessionUser,
  ttlSec = DEFAULT_TTL_SEC,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SignedSessionPayload = {
    ...session,
    tenantId: session.tenantId ?? DEFAULT_TENANT_ID,
    iat: now,
    exp: now + ttlSec,
    v: TOKEN_VERSION,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(body);
  return `${body}.${sig}`;
}

export function verifySessionToken(
  token: string,
): { ok: true; session: SessionUser } | { ok: false; reason: string } {
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing_token" };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed_token" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed: SignedSessionPayload;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8")) as SignedSessionPayload;
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (parsed.v !== TOKEN_VERSION) return { ok: false, reason: "bad_version" };
  const now = Math.floor(Date.now() / 1000);
  if (typeof parsed.exp !== "number" || parsed.exp < now) {
    return { ok: false, reason: "expired" };
  }
  if (
    parsed.audience !== "internal" &&
    parsed.audience !== "user" &&
    parsed.audience !== "ai"
  ) {
    return { ok: false, reason: "bad_audience" };
  }
  const session: SessionUser = {
    audience: parsed.audience,
    tenantId:
      typeof parsed.tenantId === "string" && parsed.tenantId.length > 0
        ? parsed.tenantId
        : DEFAULT_TENANT_ID,
  };
  if (parsed.requestor?.kind && parsed.requestor.id) {
    session.requestor = {
      kind: parsed.requestor.kind,
      id: parsed.requestor.id,
    };
  }
  if (Array.isArray(parsed.permissions) && parsed.permissions.length > 0) {
    session.permissions = parsed.permissions.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
  }
  return { ok: true, session };
}

/** Stable id for migration backfill rows — not a real login account. */
export const MIGRATION_OWNER_USER_ID = "migration-owner";

export function newUserId(): string {
  return `u_${randomBytes(12).toString("hex")}`;
}
