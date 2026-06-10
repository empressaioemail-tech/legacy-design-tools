/**
 * Cortex-api hosted login — shared identity for Cortex web + extension C2.
 *
 * Extension C2 spec (not built here): chrome.identity.launchWebAuthFlow
 * opens GET /api/auth/extension-login?redirect_uri=<chrome-extension-url>
 * with optional state; user signs in; callback redirects to redirect_uri
 * with #token=<signed-session-token>. Extension stores token and sends
 * Authorization: Bearer <token> on authenticated calls, swapping the
 * embedded BROKERAGE_EXTENSION_PUBLIC_KEY for user-tier routes.
 * Anonymous tier (public key + X-Hauska-Install-Id) stays unchanged.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { DEFAULT_TENANT_ID, SESSION_COOKIE } from "../middlewares/session";
import { mintSessionToken } from "../lib/sessionToken";
import {
  loginWithEmailPassword,
  signupWithEmailPassword,
} from "../lib/authCredentials";
import { claimInstallHistoryForUser } from "../lib/brokerageInstallClaim";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const LoginBodySchema = z.object({
  email: z.string().min(3),
  password: z.string().min(8),
});

const SignupBodySchema = z.object({
  email: z.string().min(3),
  password: z.string().min(8),
  displayName: z.string().optional(),
});

function applicantSession(userId: string) {
  return {
    audience: "user" as const,
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user" as const, id: userId },
  };
}

function setSessionCookie(res: Response, token: string): void {
  const secure = process.env["NODE_ENV"] === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

async function maybeClaimInstall(
  req: Request,
  userId: string,
): Promise<{ claimError?: string }> {
  const installId = installIdFromRequest(req);
  if (!installId) return {};
  const result = await claimInstallHistoryForUser(installId, userId);
  if (!result.ok) {
    return { claimError: result.error };
  }
  return {};
}

router.post("/auth/signup", async (req: Request, res: Response) => {
  const parsed = SignupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const signup = await signupWithEmailPassword(parsed.data);
    if (!signup.ok) {
      const status = signup.error === "email_taken" ? 409 : 400;
      res.status(status).json({ error: signup.error });
      return;
    }
    const token = mintSessionToken(applicantSession(signup.userId));
    setSessionCookie(res, token);
    const claim = await maybeClaimInstall(req, signup.userId);
    res.status(201).json({
      token,
      userId: signup.userId,
      email: signup.email,
      ...(claim.claimError ? { claimError: claim.claimError } : {}),
    });
  } catch (err) {
    logger.error({ err }, "auth signup failed");
    res.status(500).json({ error: "signup_failed" });
  }
});

router.post("/auth/login", async (req: Request, res: Response) => {
  const parsed = LoginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const login = await loginWithEmailPassword(parsed.data);
    if (!login.ok) {
      res.status(401).json({ error: login.error });
      return;
    }
    const token = mintSessionToken(applicantSession(login.userId));
    setSessionCookie(res, token);
    const claim = await maybeClaimInstall(req, login.userId);
    res.json({
      token,
      userId: login.userId,
      email: login.email,
      ...(claim.claimError ? { claimError: claim.claimError } : {}),
    });
  } catch (err) {
    logger.error({ err }, "auth login failed");
    res.status(500).json({ error: "login_failed" });
  }
});

/** Minimal hosted login page for chrome.identity.launchWebAuthFlow (C2). */
router.get("/auth/extension-login", (_req: Request, res: Response) => {
  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in with Hauska</title></head>
<body>
<h1>Sign in with Hauska</h1>
<form id="f">
<label>Email <input type="email" id="email" required></label><br>
<label>Password <input type="password" id="password" required minlength="8"></label><br>
<button type="submit">Sign in</button>
</form>
<p id="err" style="color:red"></p>
<script>
const params = new URLSearchParams(location.search);
const redirectUri = params.get("redirect_uri");
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hauska-Install-Id": params.get("install_id") || "" },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json();
  if (!r.ok) { document.getElementById("err").textContent = body.error || "login failed"; return; }
  if (redirectUri) {
    const u = new URL(redirectUri);
    u.hash = "token=" + encodeURIComponent(body.token);
    location.href = u.toString();
  } else {
    document.getElementById("err").textContent = "Signed in. Token: " + body.token.slice(0, 16) + "…";
  }
};
</script>
</body></html>`);
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

export default router;
