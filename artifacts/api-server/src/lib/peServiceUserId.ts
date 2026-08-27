/**
 * Trusted service impersonation for Property Explorer BFF routes called by
 * smartsite-mcp (P-87). SERVICE_API_KEY alone is not a user session; the
 * MCP server passes the OAuth-resolved Smart Site user id in X-PE-User-Id.
 */
import type { Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getServiceApiKey } from "./serviceToken";

export const PE_SERVICE_USER_ID_HEADER = "x-pe-user-id";

const ANONYMOUS_OWNER_PREFIX = "anon_";

function extractBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** User id when SERVICE_API_KEY is valid and X-PE-User-Id names a real account. */
export function resolvePeUserIdFromTrustedServiceCall(
  req: Request,
): string | null {
  const userId = req.header(PE_SERVICE_USER_ID_HEADER)?.trim();
  if (!userId || userId.startsWith(ANONYMOUS_OWNER_PREFIX)) return null;

  const presented = extractBearerToken(req);
  if (presented === null) return null;
  if (!timingSafeStringEqual(presented, getServiceApiKey())) return null;

  return userId;
}
