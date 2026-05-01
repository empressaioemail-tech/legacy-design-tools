/**
 * /api/settings — admin-only Settings surface (stub).
 *
 * The plan-review front end already hides the "Settings" sidebar entry
 * and blocks the `/settings` route for any session that doesn't carry
 * the `settings:manage` claim (see `artifacts/plan-review/src/App.tsx`
 * and `artifacts/plan-review/src/components/NavGroups.tsx`). Until the
 * real Settings admin page lands (Task #121) the back-end has nothing
 * to gate, which means the FE is the only line of defence — a
 * determined caller could `curl /api/settings` and skip the gate
 * entirely once a route eventually exists.
 *
 * This file pre-installs the gate so that the moment a real handler
 * drops in here it inherits the 403 behaviour by construction. Mirrors
 * `requireUsersManage` in `routes/users.ts`; when real auth lands
 * (Spec 20 follow-up, task #29) only the *source* of
 * `req.session.permissions` changes, not the gate.
 *
 * The entire Settings surface is admin-only — there is no anonymous
 * read use case, so the gate is applied router-wide rather than per-
 * write-handler (in contrast to `/api/users`, which keeps reads open
 * for the timeline-hydration helper).
 */

import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

const router: IRouter = Router();

/**
 * Permission name required by every Settings endpoint. Centralised
 * here so the string only lives in one place — the FE gate uses the
 * same literal in `App.tsx` / `NavGroups.tsx`, and the future
 * permissions-mapping module will read from this constant too.
 */
const SETTINGS_MANAGE = "settings:manage";

/**
 * Express middleware that 403s any caller whose session does not carry
 * the {@link SETTINGS_MANAGE} permission claim. Mounted router-wide
 * because every Settings endpoint is admin-only — there is no
 * anonymous-read use case to keep open.
 *
 * Returns the same `ErrorResponse` body shape the rest of the API uses
 * so the FE's `extractErrorMessage` helper picks up the message
 * uniformly.
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

router.use("/settings", requireSettingsManage);

/**
 * Stub fetch handler so the gate has something concrete to protect and
 * the test suite has a 200 path to assert against. Returns an empty
 * settings object — the real settings payload is the subject of Task
 * #121, and the empty wire shape is forward-compatible with the
 * key/value bag the future implementation will return.
 */
router.get("/settings", (_req: Request, res: Response) => {
  res.json({});
});

export default router;
