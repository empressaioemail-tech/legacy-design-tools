/**
 * /api/reviewers — admin-only Reviewer Pool surface (stub).
 *
 * The plan-review front end already hides the "Reviewer Pool" sidebar
 * entry and blocks the `/reviewers` route for any session that doesn't
 * carry the `reviewers:manage` claim (see `artifacts/plan-review/src/App.tsx`
 * and `artifacts/plan-review/src/components/NavGroups.tsx`). Until the real
 * Reviewer Pool admin page lands (Task #121) the back-end has nothing to
 * gate, which means the FE is the only line of defence — a determined
 * caller could `curl /api/reviewers` and skip the gate entirely once a
 * route eventually exists.
 *
 * This file pre-installs the gate so that the moment a real handler drops
 * in here it inherits the 403 behaviour by construction. Mirrors
 * `requireUsersManage` in `routes/users.ts`; when real auth lands (Spec
 * 20 follow-up, task #29) only the *source* of `req.session.permissions`
 * changes, not the gate.
 *
 * Unlike `/api/users` (where reads stay open so the timeline-hydration
 * helper and the read-only "Users & Roles" view can fetch profile rows
 * without elevating the caller), the entire Reviewer Pool surface is
 * admin-only — there is no anonymous read use case, so the gate is
 * applied router-wide rather than per-write-handler.
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
 * Permission name required by every Reviewer Pool endpoint. Centralised
 * here so the string only lives in one place — the FE gate uses the
 * same literal in `App.tsx` / `NavGroups.tsx`, and the future
 * permissions-mapping module will read from this constant too.
 */
const REVIEWERS_MANAGE = "reviewers:manage";

/**
 * Express middleware that 403s any caller whose session does not carry
 * the {@link REVIEWERS_MANAGE} permission claim. Mounted router-wide
 * because every Reviewer Pool endpoint is admin-only — there is no
 * anonymous-read use case to keep open.
 *
 * Returns the same `ErrorResponse` body shape the rest of the API uses
 * so the FE's `extractErrorMessage` helper picks up the message
 * uniformly.
 */
const requireReviewersManage: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.session.permissions?.includes(REVIEWERS_MANAGE)) {
    next();
    return;
  }
  res.status(403).json({ error: "Requires reviewers:manage permission" });
};

router.use("/reviewers", requireReviewersManage);

/**
 * Stub list handler so the gate has something concrete to protect and
 * the test suite has a 200 path to assert against. Returns an empty
 * array — the real pool listing is the subject of Task #121, and the
 * empty wire shape is forward-compatible with the array of reviewer
 * records the future implementation will return.
 */
router.get("/reviewers", (_req: Request, res: Response) => {
  res.json([]);
});

export default router;
