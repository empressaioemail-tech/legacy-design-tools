/**
 * Signed ephemeral owner id for unauthenticated demo sessions.
 *
 * Each anonymous browser gets a unique `anon_*` owner via the
 * `pr_anon_owner` cookie so Phase 1 demo create/read stays scoped
 * without sharing the legacy backfill owner.
 */

import { randomBytes } from "node:crypto";
import {
  mintSessionToken,
  verifySessionToken,
} from "./sessionToken";
import type { SessionUser } from "../middlewares/session";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

export const ANONYMOUS_OWNER_COOKIE = "pr_anon_owner";
export const ANONYMOUS_OWNER_PREFIX = "anon_";

export function isAnonymousOwnerId(id: string): boolean {
  return id.startsWith(ANONYMOUS_OWNER_PREFIX);
}

export function newAnonymousOwnerId(): string {
  return `${ANONYMOUS_OWNER_PREFIX}${randomBytes(12).toString("hex")}`;
}

function anonymousOwnerSession(ownerId: string): SessionUser {
  return {
    audience: "user",
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user", id: ownerId },
  };
}

/** Mint a signed token carrying only the ephemeral owner id. */
export function mintAnonymousOwnerToken(ownerId: string): string {
  return mintSessionToken(anonymousOwnerSession(ownerId));
}

/** Verify token; returns owner id or null. */
export function verifyAnonymousOwnerToken(token: string): string | null {
  const result = verifySessionToken(token);
  if (!result.ok) return null;
  const id = result.session.requestor?.id;
  if (
    result.session.requestor?.kind !== "user" ||
    !id ||
    !isAnonymousOwnerId(id)
  ) {
    return null;
  }
  return id;
}

export function readAnonymousOwnerFromCookies(
  cookies: Record<string, unknown> | undefined,
): string | null {
  const raw = cookies?.[ANONYMOUS_OWNER_COOKIE];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return verifyAnonymousOwnerToken(raw);
}

/** Stable system owner for pre-auth backfilled engagements — never anonymous. */
export const LEGACY_INTERNAL_OWNER_USER_ID = "legacy-internal-owner";
