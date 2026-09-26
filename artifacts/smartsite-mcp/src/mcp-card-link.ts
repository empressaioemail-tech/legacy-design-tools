/**
 * P-447. Signed card-page links on smartsite.cloud (same HMAC shape as PE share tokens).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const MCP_CARD_TOKEN_VERSION = 3 as const;
/** Seven days: long enough to hand to a buyer, short enough that stale record reads are labelled. */
export const MCP_CARD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MCP_CARD_LINK_EXPIRY_REASON =
  "This link expires after seven days so an older MCP answer is not mistaken for a live county read.";

export type McpCardScope =
  | { kind: "parcel"; parcelNodeId: string }
  | { kind: "parcels"; parcelNodeIds: string[] }
  | { kind: "screen"; screenId: string; parcelNodeId?: string | null };

export type McpCardTokenPayload = {
  v: typeof MCP_CARD_TOKEN_VERSION;
  k: "mcp-card";
  tool: string;
  scope: McpCardScope;
  u: string;
  exp: number;
  via?: string;
  dn?: string;
};

export type McpCardLink = {
  url: string;
  expiresAt: string;
  expiryReason: string;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

export function mcpCardSigningSecret(): string | null {
  const dedicated = process.env.PE_MCP_CARD_SECRET?.trim();
  if (dedicated) return dedicated;
  const share = process.env.PE_SHARE_SECRET?.trim();
  return share && share.length > 0 ? share : null;
}

export function cardPageOrigin(): string {
  return (process.env.SMARTSITE_CARD_PAGE_ORIGIN?.trim() || "https://smartsite.cloud").replace(
    /\/+$/,
    "",
  );
}

export function mintMcpCardLink(opts: {
  secret: string;
  sharerUserId: string;
  tool: string;
  scope: McpCardScope;
  agentVia?: string | null;
  sharedByDisplayName?: string | null;
  nowMs?: number;
  ttlMs?: number;
}): McpCardLink {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? MCP_CARD_LINK_TTL_MS;
  const exp = Math.floor((nowMs + ttlMs) / 1000);
  const payload: McpCardTokenPayload = {
    v: MCP_CARD_TOKEN_VERSION,
    k: "mcp-card",
    tool: opts.tool,
    scope: opts.scope,
    u: opts.sharerUserId,
    exp,
    ...(opts.agentVia?.trim() ? { via: opts.agentVia.trim() } : {}),
    ...(opts.sharedByDisplayName?.trim() ? { dn: opts.sharedByDisplayName.trim() } : {}),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(sign(payloadB64, opts.secret));
  const token = `${payloadB64}.${sig}`;
  const expiresAt = new Date(exp * 1000).toISOString();
  return {
    url: `${cardPageOrigin()}/card#${token}`,
    expiresAt,
    expiryReason: MCP_CARD_LINK_EXPIRY_REASON,
  };
}

export type McpCardTokenValidation =
  | { ok: true; payload: McpCardTokenPayload; expiresAt: string }
  | { ok: false; reason: "invalid" | "expired" | "tampered" };

export function validateMcpCardToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): McpCardTokenValidation {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "invalid" };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { ok: false, reason: "invalid" };
  const expected = sign(payloadB64, secret);
  const got = Buffer.from(sigB64, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: "tampered" };
  }
  let payload: McpCardTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as McpCardTokenPayload;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (payload.v !== MCP_CARD_TOKEN_VERSION || payload.k !== "mcp-card") {
    return { ok: false, reason: "invalid" };
  }
  if (!payload.u || !payload.tool || !payload.scope) return { ok: false, reason: "invalid" };
  const expMs = payload.exp * 1000;
  if (!Number.isFinite(expMs) || expMs <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload, expiresAt: new Date(expMs).toISOString() };
}
