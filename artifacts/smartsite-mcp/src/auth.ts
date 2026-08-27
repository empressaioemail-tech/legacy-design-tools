/**
 * WorkOS AuthKit bearer validation + fail-closed gate (P-87 items 10/11).
 * Bearer-without-OAuth is 401; no silent public catalog.
 */

import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { resolveSmartsiteUserFromClaims, type IdentityClaims } from "./identity.js";
import { wwwAuthenticateHeader } from "./oauth-metadata.js";
import { runWithAuth, type SmartsiteAuthContext } from "./request-context.js";
import type { PeOidcProvider } from "@workspace/db/schema";

export type AuthConfig = {
  workosClientId: string | null;
  workosIssuer: string | null;
  jwksUri: string | null;
  devMode: boolean;
};

export function loadAuthConfig(): AuthConfig {
  return {
    workosClientId: process.env.WORKOS_CLIENT_ID?.trim() || null,
    workosIssuer: process.env.WORKOS_ISSUER?.trim() || null,
    jwksUri: process.env.WORKOS_JWKS_URI?.trim() || null,
    devMode: process.env.SMARTSITE_MCP_DEV_MODE === "true",
  };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function claimsFromDevToken(token: string): IdentityClaims | null {
  // Local-only: SMARTSITE_MCP_DEV_TOKEN=google:sub123:user@example.com
  const expected = process.env.SMARTSITE_MCP_DEV_TOKEN;
  if (!expected || token !== expected) return null;
  const [provider, subject, email] = expected.split(":");
  if (provider !== "google" && provider !== "microsoft") return null;
  if (!subject) return null;
  return { provider: provider as PeOidcProvider, subject, email };
}

function claimsFromJwt(payload: JWTPayload): IdentityClaims | null {
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) return null;

  const email =
    typeof payload.email === "string"
      ? payload.email
      : typeof payload["https://workos.com/claims/email"] === "string"
        ? (payload["https://workos.com/claims/email"] as string)
        : null;

  const providerClaim =
    typeof payload.provider === "string"
      ? payload.provider
      : typeof payload["https://workos.com/claims/provider"] === "string"
        ? (payload["https://workos.com/claims/provider"] as string)
        : null;

  const provider: PeOidcProvider | undefined =
    providerClaim === "google" || providerClaim === "GoogleOAuth"
      ? "google"
      : providerClaim === "microsoft" || providerClaim === "MicrosoftOAuth"
        ? "microsoft"
        : undefined;

  return { provider, subject: sub, email };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(jwksUri: string) {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
  }
  return jwks;
}

async function verifyWorkosBearer(
  token: string,
  config: AuthConfig,
): Promise<IdentityClaims | null> {
  if (!config.jwksUri) return null;
  const audience =
    process.env.SMARTSITE_MCP_RESOURCE?.trim() ||
    "https://mcp.smartsite.cloud/mcp";
  try {
    const { payload } = await jwtVerify(token, getJwks(config.jwksUri), {
      audience,
      issuer: config.workosIssuer ?? undefined,
    });
    return claimsFromJwt(payload);
  } catch {
    return null;
  }
}

function unauthorized(res: Response, reason: string): void {
  res
    .status(401)
    .set("WWW-Authenticate", wwwAuthenticateHeader())
    .json({
      error: "unauthorized",
      reason,
      message: "Smart Site MCP requires OAuth. Unresolvable credentials are refused.",
    });
}

export function buildMcpAuthMiddleware(config: AuthConfig = loadAuthConfig()) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (!token) {
      unauthorized(res, "missing_bearer");
      return;
    }

    let claims: IdentityClaims | null = null;

    if (config.devMode) {
      claims = claimsFromDevToken(token);
    } else {
      claims = await verifyWorkosBearer(token, config);
    }

    if (!claims) {
      unauthorized(res, "invalid_oauth_token");
      return;
    }

    const resolved = await resolveSmartsiteUserFromClaims(claims);
    if (!resolved.ok) {
      unauthorized(res, resolved.reason);
      return;
    }

    const ctx: SmartsiteAuthContext = {
      userId: resolved.userId,
      email: claims.email ?? null,
      accessTier: resolved.entitlement.accessTier,
      subscriptionTier: resolved.entitlement.subscriptionTier,
      devRole: resolved.entitlement.devRole,
    };

    runWithAuth(ctx, () => next());
  };
}

/** Reject initialize when auth is not configured (production fail-closed). */
export function isAuthConfigured(config: AuthConfig = loadAuthConfig()): boolean {
  if (config.devMode) return true;
  return Boolean(config.jwksUri && config.workosIssuer);
}
