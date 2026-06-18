/**
 * Hosted extension login — signup + sign-in + password reset request (75i task 8).
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { DEFAULT_TENANT_ID, SESSION_COOKIE } from "../middlewares/session";
import { mintSessionToken } from "../lib/sessionToken";
import {
  loginWithEmailPassword,
  signupWithEmailPassword,
} from "../lib/authCredentials";
import { claimInstallHistoryForUser } from "../lib/brokerageInstallClaim";
import { syncPipedrivePerson } from "../lib/brokeragePipedrive";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import { logger } from "../lib/logger";
import {
  renderExtensionLoginPage,
  resolveExtensionLoginMode,
} from "../lib/extensionLoginPage";

const router: IRouter = Router();

function hauskaPublicDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "artifacts/api-server/public/hauska"),
    join(process.cwd(), "public/hauska"),
    join(here, "../public/hauska"),
    join(here, "../../public/hauska"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "hauska.css"))) return dir;
  }
  return null;
}

const hauskaDir = hauskaPublicDir();
if (hauskaDir) {
  router.use(
    "/auth/hauska",
    express.static(hauskaDir, {
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
    }),
  );
} else {
  logger.warn("hauska auth static assets not found — extension-login CSS will 404");
}

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
    const installId = installIdFromRequest(req);
    if (installId) {
      void syncPipedrivePerson({
        email: signup.email,
        installId,
        acquisitionSource: "hauska_extension_signup",
      });
    }
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

router.get("/auth/extension-login", (req: Request, res: Response) => {
  const mode = resolveExtensionLoginMode(req.query.intent);
  res.type("html").send(renderExtensionLoginPage(mode));
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

export default router;
