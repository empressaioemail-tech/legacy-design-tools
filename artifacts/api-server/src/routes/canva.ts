/**
 * Canva Connect — OAuth, assets, brand templates, async push jobs.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, engagements } from "@workspace/db";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";
import { isCanvaConfigured } from "../lib/canva/config";
import { FALLBACK_BRAND_TEMPLATES } from "../lib/canva/catalog";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
} from "../lib/canva/oauth";
import {
  connectionStatusForOwner,
  consumeOAuthState,
  deleteConnection,
  getConnectionForOwner,
  listDesignPushes,
  saveOAuthState,
  sessionOwnerId,
  toPushJobWire,
  createPushJob,
  getPushJobRow,
  updateConnectionTokens,
  upsertConnection,
} from "../lib/canva/store";
import { listEngagementCanvaAssets } from "../lib/canva/assets";
import {
  listBrandTemplatesFromCanva,
  fetchCanvaProfile,
  type CanvaConnectionRow,
} from "../lib/canva/client";
import { runCanvaPushJob } from "../lib/canva/pushWorker";
import type { CanvaPushRequest } from "../lib/canva/wireTypes";

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function requestBaseUrl(req: Request): string {
  const proto = req.header("x-forwarded-proto") ?? req.protocol;
  const host = req.header("x-forwarded-host") ?? req.get("host") ?? "localhost:8080";
  return `${proto}://${host}`;
}

function ownerFromReq(req: Request): { tenantId: string; ownerUserId: string } {
  return {
    tenantId: req.session.tenantId,
    ownerUserId: sessionOwnerId(req.session.requestor?.id),
  };
}

const authed = Router();
authed.use(requireServiceTokenOrSession);

authed.get("/canva/connection", async (req: Request, res: Response) => {
  const { tenantId, ownerUserId } = ownerFromReq(req);
  try {
    const status = await connectionStatusForOwner(tenantId, ownerUserId);
    res.json(status);
  } catch (err) {
    logger.error({ err }, "canva connection status failed");
    res.status(500).json({ error: "Internal error" });
  }
});

/** Dev/test only — mark session connected without Canva OAuth. */
authed.post("/canva/oauth/dev-connect", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production" || isCanvaConfigured()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { tenantId, ownerUserId } = ownerFromReq(req);
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await upsertConnection({
    tenantId,
    ownerUserId,
    accessToken: "dev-token",
    refreshToken: "dev-refresh",
    expiresAt,
    displayName: "Studio Canva (dev)",
  });
  res.json({
    state: "connected",
    displayName: "Studio Canva (dev)",
    connectedAt: new Date().toISOString(),
  });
});

authed.post("/canva/oauth/start", async (req: Request, res: Response) => {
  if (!isCanvaConfigured()) {
    res.status(503).json({
      error: "Canva OAuth is not configured (set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET)",
    });
    return;
  }
  const { tenantId, ownerUserId } = ownerFromReq(req);
  try {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createOAuthState();
    await saveOAuthState({ state, codeVerifier, ownerUserId, tenantId });
    const url = buildAuthorizeUrl({ codeChallenge, state });
    res.json({ url });
  } catch (err) {
    logger.error({ err }, "canva oauth start failed");
    res.status(500).json({ error: "Internal error" });
  }
});

authed.delete("/canva/connection", async (req: Request, res: Response) => {
  const { tenantId, ownerUserId } = ownerFromReq(req);
  await deleteConnection(tenantId, ownerUserId);
  res.status(204).end();
});

authed.get("/canva/brand-templates", async (req: Request, res: Response) => {
  const { tenantId, ownerUserId } = ownerFromReq(req);
  try {
    if (!isCanvaConfigured()) {
      res.json(FALLBACK_BRAND_TEMPLATES);
      return;
    }
    const row = await getConnectionForOwner(tenantId, ownerUserId);
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      res.json(FALLBACK_BRAND_TEMPLATES);
      return;
    }
    const connection: CanvaConnectionRow = {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
    };
    const result = await listBrandTemplatesFromCanva(connection, async (tokens) => {
      await updateConnectionTokens(row.id, tokens);
    });
    if (result === "enterprise_required") {
      res.json(FALLBACK_BRAND_TEMPLATES);
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error({ err }, "canva brand templates failed");
    res.json(FALLBACK_BRAND_TEMPLATES);
  }
});

authed.get(
  "/engagements/:engagementId/canva/assets",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const assets = await listEngagementCanvaAssets(
        engagementId,
        requestBaseUrl(req),
      );
      if (assets === null) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json(assets);
    } catch (err) {
      logger.error({ err, engagementId }, "canva assets failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.get(
  "/engagements/:engagementId/canva/designs",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [eng] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const designs = await listDesignPushes(engagementId);
    res.json(designs);
  },
);

authed.post(
  "/engagements/:engagementId/canva/push",
  async (req: Request, res: Response) => {
    const engagementId = routeParam(req.params.engagementId);
    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [eng] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const body = req.body as CanvaPushRequest;
    if (!body?.templateId || !Array.isArray(body.assetIds)) {
      res.status(400).json({ error: "Invalid push request" });
      return;
    }
    const { tenantId, ownerUserId } = ownerFromReq(req);
    const status = await connectionStatusForOwner(tenantId, ownerUserId);
    if (status.state !== "connected" && isCanvaConfigured()) {
      res.status(401).json({ error: "Canva not connected" });
      return;
    }
    try {
      const jobId = await createPushJob({
        engagementId,
        request: {
          templateId: body.templateId,
          assetIds: body.assetIds,
          slotMapping: body.slotMapping ?? {},
          textFields: body.textFields ?? {},
          uploadAssetsOnly: body.uploadAssetsOnly,
        },
      });
      runCanvaPushJob({
        jobId,
        tenantId,
        ownerUserId,
        baseUrl: requestBaseUrl(req),
      });
      res.status(202).json({ jobId });
    } catch (err) {
      logger.error({ err, engagementId }, "canva push start failed");
      res.status(500).json({ error: "Internal error" });
    }
  },
);

authed.get("/canva/push-jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = routeParam(req.params.jobId);
  if (!UUID_RE.test(jobId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const row = await getPushJobRow(jobId);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(toPushJobWire(row));
});

/** OAuth callback — browser redirect from Canva (no session cookie required). */
router.get("/canva/oauth/callback", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const error = typeof req.query.error === "string" ? req.query.error : null;

  if (error || !code || !state) {
    res.status(400).send("Canva authorization failed or was denied.");
    return;
  }

  const pending = await consumeOAuthState(state);
  if (!pending) {
    res.status(400).send("Invalid or expired OAuth state.");
    return;
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: pending.codeVerifier,
    });
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const connection: CanvaConnectionRow = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      displayName: "Canva user",
      avatarUrl: null,
    };
    const profile = await fetchCanvaProfile(connection);
    await upsertConnection({
      tenantId: pending.tenantId,
      ownerUserId: pending.ownerUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    });
    const returnTo =
      process.env.CANVA_OAUTH_SUCCESS_URL?.trim() ||
      "http://localhost:20295/";
    res.redirect(302, `${returnTo}?canva=connected`);
  } catch (err) {
    logger.error({ err }, "canva oauth callback failed");
    res.status(500).send("Failed to complete Canva connection.");
  }
});

router.use(authed);

export default router;
