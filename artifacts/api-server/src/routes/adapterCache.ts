/**
 * /api/admin/adapter-cache — operator-triggered cache maintenance.
 *
 * Task #203 added a periodic in-process sweep of `adapter_response_cache`
 * (every `ADAPTER_CACHE_SWEEP_INTERVAL_MS`, default 1h). That covers the
 * steady-state bloat case, but if an operator notices a sudden surge in
 * row count (e.g. a bad batch of one-shot lookups) they previously had to
 * wait up to a full interval or restart the api-server to trigger
 * cleanup. Task #217 exposes a tiny endpoint that calls the same
 * `sweepExpiredAdapterCacheRows` helper so an operator (or an external
 * cron, if we ever move the sweep out of the API process) can trigger a
 * single sweep tick on demand.
 *
 * Auth: gated behind the same `settings:manage` claim the rest of the
 * admin/operator surface uses (mirrors `requireSettingsManage` in
 * `routes/settings.ts`). No new permission is invented — when real auth
 * lands (Spec 20 follow-up, task #29) only the *source* of
 * `req.session.permissions` changes, not the gate.
 *
 * Behaviour: a single sweep tick — `POST` because it has the same side
 * effects as the in-process worker (DELETEs rows). Returns a small JSON
 * envelope `{ deleted: number }` so an operator can see at a glance how
 * much pressure the call relieved. The helper itself never throws (DB
 * failures are swallowed and reported as `0`), so the only error path
 * here is the auth gate.
 */

import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { sweepExpiredAdapterCacheRows } from "../lib/adapterCache";

const router: IRouter = Router();

/**
 * Permission name required to operate the adapter-cache admin surface.
 * Reuses `settings:manage` rather than minting a new claim — the task
 * explicitly says "do not invent a new one", and this endpoint is
 * functionally an operator setting (forced cleanup of an internal
 * cache table).
 */
const SETTINGS_MANAGE = "settings:manage";

/**
 * Express middleware that 403s any caller whose session does not carry
 * the {@link SETTINGS_MANAGE} permission claim. Mirrors the body shape
 * (`{ error: string }`) the rest of the API uses so the FE's
 * `extractErrorMessage` helper picks up the message uniformly.
 */
const requireSettingsManage: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.session.permissions?.includes(SETTINGS_MANAGE)) {
    next();
    return;
  }
  res.status(403).json({ error: "Requires settings:manage permission" });
};

router.use("/admin/adapter-cache", requireSettingsManage);

/**
 * Run a single sweep tick and report the number of rows removed.
 *
 * Defers entirely to {@link sweepExpiredAdapterCacheRows} so the env-
 * driven `graceMs` / `batchSize` defaults stay the single source of
 * truth — an operator forcing a sweep gets exactly the same row-bound
 * behaviour as the periodic worker, just without waiting for the next
 * interval to fire.
 */
router.post(
  "/admin/adapter-cache/sweep",
  async (req: Request, res: Response) => {
    const deleted = await sweepExpiredAdapterCacheRows({ log: req.log });
    res.json({ deleted });
  },
);

export default router;
