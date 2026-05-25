import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

function signingSecret(): string {
  const secret = process.env.COLLATERAL_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error("COLLATERAL_SIGNING_SECRET is not set");
  }
  return secret;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

function signPayload(payload: string): string {
  return base64UrlEncode(
    createHmac("sha256", signingSecret()).update(payload).digest(),
  );
}

export type SignedAssetPayload = {
  jobId: string;
  assetKey: string;
  exp: number;
};

/** Build HMAC token for Placid-facing asset fetch (15m TTL, job-scoped). */
export function createCollateralAssetToken(params: {
  jobId: string;
  assetKey: string;
  now?: number;
}): string {
  const exp = (params.now ?? Date.now()) + TTL_MS;
  const body = JSON.stringify({
    jobId: params.jobId,
    assetKey: params.assetKey,
    exp,
  });
  const sig = signPayload(body);
  return `${base64UrlEncode(Buffer.from(body, "utf8"))}.${sig}`;
}

export function buildSignedAssetFetchUrl(params: {
  baseUrl: string;
  jobId: string;
  assetKey: string;
}): string {
  const token = createCollateralAssetToken(params);
  const key = encodeURIComponent(params.assetKey);
  return `${params.baseUrl}/api/collateral/fetch/${token}/${key}`;
}

export function verifyCollateralAssetToken(
  token: string,
  expectedAssetKey: string,
): SignedAssetPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sig] = parts;
  let body: string;
  try {
    body = base64UrlDecode(bodyB64).toString("utf8");
  } catch {
    return null;
  }
  const expectedSig = signPayload(body);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let parsed: SignedAssetPayload;
  try {
    parsed = JSON.parse(body) as SignedAssetPayload;
  } catch {
    return null;
  }
  if (
    !parsed.jobId ||
    !parsed.assetKey ||
    typeof parsed.exp !== "number" ||
    parsed.assetKey !== expectedAssetKey
  ) {
    return null;
  }
  if (parsed.exp < Date.now()) return null;
  return parsed;
}

export function isSigningConfigured(): boolean {
  return Boolean(process.env.COLLATERAL_SIGNING_SECRET?.trim());
}
