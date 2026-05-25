/** Canva Connect env — see artifacts/api-server/README-canva.md */

export function getCanvaClientId(): string | null {
  const v = process.env.CANVA_CLIENT_ID?.trim();
  return v || null;
}

export function getCanvaClientSecret(): string | null {
  const v = process.env.CANVA_CLIENT_SECRET?.trim();
  return v || null;
}

export function getCanvaRedirectUri(): string {
  return (
    process.env.CANVA_REDIRECT_URI?.trim() ||
    "http://localhost:8080/api/canva/oauth/callback"
  );
}

export function isCanvaConfigured(): boolean {
  return Boolean(getCanvaClientId() && getCanvaClientSecret());
}

export const CANVA_API_BASE = "https://api.canva.com/rest/v1";
export const CANVA_OAUTH_AUTHORIZE =
  "https://www.canva.com/api/oauth/authorize";
export const CANVA_OAUTH_TOKEN = "https://api.canva.com/rest/v1/oauth/token";

export const CANVA_SCOPES = [
  "asset:read",
  "asset:write",
  "brandtemplate:content:read",
  "brandtemplate:meta:read",
  "design:content:read",
  "design:content:write",
  "design:meta:read",
  "profile:read",
].join(" ");
