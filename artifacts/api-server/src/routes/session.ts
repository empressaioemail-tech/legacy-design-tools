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
 * Track 1 — `requestor.disciplines` is hydrated here on read (not in
 * the session middleware) so the lookup cost is paid only when the FE
 * explicitly fetches `/api/session`. Mirrors the `ensureUserProfile`
 * posture the middleware uses for profile bootstrap: best-effort, a
 * transient DB error returns `disciplines: []` rather than 500-ing
 * the session fetch — `[]` is the safe FE fallback ("Show all" mode).
 *
 *   - `kind: "user"` — SELECT `disciplines` FROM `users` WHERE `id =
 *     :requestorId`. Row may be missing (the middleware's profile
 *     backfill is fire-and-forget); fall through to `[]`.
 *   - `kind: "agent"` (and any future `kind: "system"`) — uniform
 *     `[]`. Agents/systems have no ICC certifications by definition,
 *     and the FE's hook treats `[]` as "Show all" so the response
 *     stays predictable without per-kind type-narrowing.
 *
 * The route still never throws — failures fall through to the
 * empty-array branch. The `disciplines` field is denormalized read-
 * side metadata; `users.disciplines` remains the source of truth.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, users } from "@workspace/db";
import {
  isPlanReviewDiscipline,
  type PlanReviewDiscipline,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/session", async (req: Request, res: Response) => {
  const s = req.session;

  let requestor:
    | {
        kind: "user" | "agent";
        id: string;
        disciplines: PlanReviewDiscipline[];
      }
    | undefined;

  if (s.requestor) {
    let disciplines: PlanReviewDiscipline[] = [];
    if (s.requestor.kind === "user") {
      try {
        const rows = await db
          .select({ disciplines: users.disciplines })
          .from(users)
          .where(eq(users.id, s.requestor.id))
          .limit(1);
        const row = rows[0];
        if (row && Array.isArray(row.disciplines)) {
          // Closed-set filter — defensive in case the DB CHECK
          // constraint is ever relaxed and a stray value sneaks in.
          // The FE's typed shape is the closed enum; an unknown
          // value would otherwise widen the wire type at runtime.
          disciplines = row.disciplines.filter(isPlanReviewDiscipline);
        }
      } catch (err) {
        logger.warn(
          { err, requestorId: s.requestor.id },
          "session disciplines hydration failed; returning []",
        );
      }
    }
    requestor = {
      kind: s.requestor.kind,
      id: s.requestor.id,
      disciplines,
    };
  }

  res.json({
    audience: s.audience,
    // Only include `requestor` when present so the response stays
    // closer to the JSON wire shape — the OpenAPI spec marks it
    // optional. Spreading conditionally avoids `requestor: undefined`
    // serializing to a missing key (which is fine) but also keeps the
    // shape uniform with the typed `Session` interface.
    ...(requestor ? { requestor } : {}),
    // Normalize to an empty array so the FE can treat `permissions` as
    // always-present (the schema marks it required for the same
    // reason). Internally `SessionUser.permissions` is optional.
    permissions: s.permissions ? Array.from(s.permissions) : [],
    // Always include the session tenant so the FE can scope
    // tenant-keyed libraries (e.g. canned findings) without
    // hard-coding a tenant id. The middleware always populates
    // `tenantId`, defaulting to `DEFAULT_TENANT_ID` for anonymous /
    // production sessions, so this is never undefined.
    tenantId: s.tenantId,
  });
});

export default router;
