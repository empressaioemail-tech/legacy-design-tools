import crypto from "node:crypto";
import { CANVA_OAUTH_AUTHORIZE, CANVA_OAUTH_TOKEN, CANVA_SCOPES } from "./config";
import { getCanvaClientId, getCanvaClientSecret, getCanvaRedirectUri } from "./config";

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(96).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function createOAuthState(): string {
  return crypto.randomBytes(96).toString("base64url");
}

export function buildAuthorizeUrl(params: {
  codeChallenge: string;
  state: string;
}): string {
  const clientId = getCanvaClientId();
  if (!clientId) {
    throw new Error("CANVA_CLIENT_ID not configured");
  }
  const q = new URLSearchParams({
    code_challenge: params.codeChallenge,
    code_challenge_method: "s256",
    scope: CANVA_SCOPES,
    response_type: "code",
    client_id: clientId,
    state: params.state,
    redirect_uri: getCanvaRedirectUri(),
  });
  return `${CANVA_OAUTH_AUTHORIZE}?${q.toString()}`;
}

export type CanvaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};

export async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
}): Promise<CanvaTokenResponse> {
  const clientId = getCanvaClientId();
  const clientSecret = getCanvaClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("Canva OAuth not configured");
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString(
    "base64",
  );
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: getCanvaRedirectUri(),
  });
  const res = await fetch(CANVA_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canva token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as CanvaTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<CanvaTokenResponse> {
  const clientId = getCanvaClientId();
  const clientSecret = getCanvaClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("Canva OAuth not configured");
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString(
    "base64",
  );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(CANVA_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canva token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as CanvaTokenResponse;
}
