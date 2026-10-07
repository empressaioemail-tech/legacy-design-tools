/**
 * Short-lived download links for export PDFs (QA 2026-09-29, fix register
 * B3/C3: the feasibility PDF came back as ~17 MB of inline base64, which
 * overflows most agent contexts).
 *
 * A link is minted only after the export's paid gate has passed. It names the
 * parcel and the kind, expires after FILE_LINK_TTL_MS, and is signed with
 * SMARTSITE_FILE_LINK_SECRET. With that secret unset no link is minted and the
 * export keeps returning the bytes inline, so turning this on is a config step.
 * Anyone holding an unexpired link can download that one PDF, the same model as
 * a presigned storage URL.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const FILE_LINK_TTL_MS = 15 * 60 * 1000;
export type FileLinkKind = "feasibility";

function secret(): string | null {
  return process.env.SMARTSITE_FILE_LINK_SECRET?.trim() || null;
}

function publicBase(): string {
  return (process.env.SMARTSITE_MCP_PUBLIC_URL?.trim() || "https://mcp.smartsite.cloud").replace(/\/+$/, "");
}

function sign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function mintFileLink(
  kind: FileLinkKind,
  parcelNodeId: string,
  nowMs: number = Date.now(),
): { url: string; expiresAt: string } | null {
  const key = secret();
  if (!key) return null;
  const exp = nowMs + FILE_LINK_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ k: kind, p: parcelNodeId, e: exp })).toString("base64url");
  return {
    url: `${publicBase()}/files/${kind}/${payload}.${sign(key, payload)}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

export function verifyFileLink(
  kind: FileLinkKind,
  token: string,
  nowMs: number = Date.now(),
): { parcelNodeId: string } | { refused: "unsigned" | "expired" | "invalid" } {
  const key = secret();
  if (!key) return { refused: "unsigned" };
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { refused: "invalid" };
  const expected = Buffer.from(sign(key, payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { refused: "invalid" };
  let body: { k?: unknown; p?: unknown; e?: unknown };
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { refused: "invalid" };
  }
  if (body.k !== kind || typeof body.p !== "string" || typeof body.e !== "number") return { refused: "invalid" };
  if (body.e < nowMs) return { refused: "expired" };
  return { parcelNodeId: body.p };
}
