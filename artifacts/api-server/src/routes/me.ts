/**
 * /api/me — self-edit surface for the current session's `user`-kind
 * requestor.
 *
 * Today this owns a single endpoint:
 * `PATCH /me/architect-pdf-header` — lets an architect set or clear
 * their `users.architect_pdf_header` override, which the
 * stakeholder-briefing PDF route reads to title each page.
 *
 * Auth posture
 * ------------
 * Self-edit only. The handler requires a `user`-kind requestor on
 * `req.session`; anonymous and agent callers are rejected with 401.
 * No `users:manage` admin gate runs here on purpose — the admin route
 * (`PATCH /users/{id}`) intentionally does not touch this column, so
 * the only way to set the override today is the user editing their
 * own row through this surface.
 *
 * Profile bootstrap
 * -----------------
 * The session middleware fires `ensureUserProfile` for every fresh
 * `user`-kind requestor, but that's a fire-and-forget upsert — the
 * row may not have landed by the time the FE first opens Settings
 * and immediately submits. We re-run `ensureUserProfile` inline here
 * so the update target always exists, even on a never-before-seen
 * id.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateMyArchitectPdfHeaderBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { ensureUserProfile } from "../lib/userProfiles";
import { toUserResponse } from "./users";

const router: IRouter = Router();

router.patch(
  "/me/architect-pdf-header",
  async (req: Request, res: Response) => {
    const requestor = req.session?.requestor;
    if (!requestor || requestor.kind !== "user") {
      res
        .status(401)
        .json({ error: "Self-edit requires a signed-in user session" });
      return;
    }

    const parsed = UpdateMyArchitectPdfHeaderBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    // Trim whitespace and treat empty strings as "clear the override"
    // so the Settings form can ship a single "save" button — the
    // alternative would be a dedicated "clear" affordance plus a
    // separate write path, which is more UI for the same outcome.
    const raw = parsed.data.architectPdfHeader;
    const next: string | null =
      raw === null ? null : raw.trim().length === 0 ? null : raw.trim();

    try {
      // Defensive backfill: the session middleware already fires
      // `ensureUserProfile` for fresh requestors, but it's
      // fire-and-forget so the row may not have landed by the time
      // the architect lands on Settings and immediately submits. The
      // upsert is a no-op when the row is already present.
      await ensureUserProfile(requestor.id);

      const [row] = await db
        .update(users)
        .set({ architectPdfHeader: next, updatedAt: new Date() })
        .where(eq(users.id, requestor.id))
        .returning();
      if (!row) {
        // Should be unreachable — `ensureUserProfile` guarantees a row
        // exists — but if a concurrent DELETE raced past us the FE
        // owes the user a clear signal rather than a 500.
        res.status(404).json({ error: "User profile not found" });
        return;
      }

      res.json(toUserResponse(row));
    } catch (err) {
      logger.error(
        { err, id: requestor.id },
        "update my architect pdf header failed",
      );
      res
        .status(500)
        .json({ error: "Failed to update architect PDF header" });
    }
  },
);

export default router;
