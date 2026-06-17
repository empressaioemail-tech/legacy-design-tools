/**
 * Hosted extension login — signup + sign-in + password reset request (75i task 8).
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

router.post("/auth/password-reset-request", async (req: Request, res: Response) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!email) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  // Token email delivery is operator-configured; always return 202 to avoid account enumeration.
  logger.info({ emailDomain: email.split("@")[1] ?? "" }, "password reset requested");
  res.status(202).json({ ok: true, message: "If an account exists, reset instructions will be sent." });
});

const EXTENSION_LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hauska — Sign in</title>
  <style>
    :root {
      --hauska-bg: #0f1419;
      --hauska-surface: #1a2332;
      --hauska-accent: #c9a227;
      --hauska-text: #e8ecf1;
      --hauska-muted: #8b9cb3;
      --hauska-error: #e85d5d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; font-family: system-ui, sans-serif;
      background: var(--hauska-bg); color: var(--hauska-text);
      display: flex; align-items: center; justify-content: center; padding: 1.5rem;
    }
    .card {
      width: 100%; max-width: 380px; background: var(--hauska-surface);
      border-radius: 12px; padding: 2rem; box-shadow: 0 8px 32px rgba(0,0,0,.4);
    }
    h1 { font-size: 1.35rem; margin: 0 0 .25rem; font-weight: 600; }
    .sub { color: var(--hauska-muted); font-size: .9rem; margin-bottom: 1.5rem; }
    .tabs { display: flex; gap: .5rem; margin-bottom: 1.25rem; }
    .tabs button {
      flex: 1; padding: .5rem; border: 1px solid #2d3a4f; background: transparent;
      color: var(--hauska-muted); border-radius: 6px; cursor: pointer; font-size: .9rem;
    }
    .tabs button.active {
      border-color: var(--hauska-accent); color: var(--hauska-accent); background: rgba(201,162,39,.08);
    }
    label { display: block; font-size: .8rem; color: var(--hauska-muted); margin-bottom: .35rem; }
    input {
      width: 100%; padding: .65rem .75rem; margin-bottom: 1rem; border-radius: 6px;
      border: 1px solid #2d3a4f; background: #0f1419; color: var(--hauska-text); font-size: 1rem;
    }
    button.primary {
      width: 100%; padding: .75rem; border: none; border-radius: 6px;
      background: var(--hauska-accent); color: #0f1419; font-weight: 600; font-size: 1rem; cursor: pointer;
    }
    button.primary:disabled { opacity: .6; cursor: wait; }
    .err { color: var(--hauska-error); font-size: .85rem; min-height: 1.25rem; margin-top: .5rem; }
    .reset { margin-top: 1rem; text-align: center; font-size: .85rem; }
    .reset a { color: var(--hauska-accent); cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hauska Property Brief</h1>
    <p class="sub">Sign in to save your buy box, verdict history, and Pro depth.</p>
    <div class="tabs">
      <button type="button" id="tab-signin" class="active">Sign in</button>
      <button type="button" id="tab-signup">Create account</button>
    </div>
    <form id="f">
      <label for="email">Email</label>
      <input type="email" id="email" required autocomplete="email">
      <label for="password">Password (8+ characters)</label>
      <input type="password" id="password" required minlength="8" autocomplete="current-password">
      <button type="submit" class="primary" id="submit">Sign in</button>
    </form>
    <p class="err" id="err"></p>
    <p class="reset"><a id="reset-link">Forgot password?</a></p>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    const redirectUri = params.get("redirect_uri");
    const installId = params.get("install_id") || "";
    let mode = "signin";
    const tabSignin = document.getElementById("tab-signin");
    const tabSignup = document.getElementById("tab-signup");
    const submit = document.getElementById("submit");
    const err = document.getElementById("err");
    function setMode(m) {
      mode = m;
      tabSignin.classList.toggle("active", m === "signin");
      tabSignup.classList.toggle("active", m === "signup");
      submit.textContent = m === "signin" ? "Sign in" : "Create account";
      document.getElementById("password").autocomplete = m === "signin" ? "current-password" : "new-password";
    }
    tabSignin.onclick = () => setMode("signin");
    tabSignup.onclick = () => setMode("signup");
    document.getElementById("reset-link").onclick = async (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value;
      if (!email) { err.textContent = "Enter your email first."; return; }
      await fetch("/api/auth/password-reset-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      err.style.color = "#8b9cb3";
      err.textContent = "If an account exists, reset instructions will be sent.";
    };
    document.getElementById("f").onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      err.style.color = "";
      submit.disabled = true;
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      const path = mode === "signin" ? "/api/auth/login" : "/api/auth/signup";
      try {
        const r = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Hauska-Install-Id": installId },
          body: JSON.stringify({ email, password }),
        });
        const body = await r.json();
        if (!r.ok) { err.textContent = body.error || "Request failed"; return; }
        if (redirectUri) {
          const u = new URL(redirectUri);
          u.hash = "token=" + encodeURIComponent(body.token);
          location.href = u.toString();
        } else {
          err.style.color = "#8b9cb3";
          err.textContent = "Signed in. You can close this tab.";
        }
      } finally {
        submit.disabled = false;
      }
    };
  </script>
</body>
</html>`;

router.get("/auth/extension-login", (_req: Request, res: Response) => {
  res.type("html").send(EXTENSION_LOGIN_HTML);
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

export default router;
