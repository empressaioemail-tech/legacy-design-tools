/**
 * /api/session — read-only view of `req.session`.
 *
 * Frontends call this to gate admin-only UI without having to know
 * how the session is wired (cookie / header overrides / future signed
 * JWT). The response shape is the public subset of {@link SessionUser}
 * exposed to the OpenAPI spec — `audience`, optional `requestor`,
 * `permissions` (always an array, even when empty, so callers can
 * `.includes(...)` without a null-check).
 *
 * The route never reads the database and never throws — it just mirrors
 * whatever `sessionMiddleware` already attached to the request.
 */

import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

router.get("/session", (req: Request, res: Response) => {
  const s = req.session;
  res.json({
    audience: s.audience,
    // Only include `requestor` when present so the response stays
    // closer to the JSON wire shape — the OpenAPI spec marks it
    // optional. Spreading conditionally avoids `requestor: undefined`
    // serializing to a missing key (which is fine) but also keeps the
    // shape uniform with the typed `Session` interface.
    ...(s.requestor ? { requestor: s.requestor } : {}),
    // Normalize to an empty array so the FE can treat `permissions` as
    // always-present (the schema marks it required for the same
    // reason). Internally `SessionUser.permissions` is optional.
    permissions: s.permissions ? Array.from(s.permissions) : [],
  });
});

export default router;
