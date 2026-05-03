/**
 * /api/me — self-edit surface for the current session's `user`-kind
 * requestor.
 *
 * Today this owns two endpoints:
 *
 *   - `PATCH /me/architect-pdf-header` — set / clear the per-architect
 *     override for the stakeholder-briefing PDF header
 *     (`users.architect_pdf_header`).
 *   - `PATCH /me/profile` — edit the architect's own `displayName` /
 *     `email` / `avatarUrl` columns. Mirrors the admin
 *     `PATCH /users/{id}` route's validation + avatar safety gates,
 *     minus the `users:manage` claim — architects are not admins,
 *     and the only row this handler can ever touch is the requestor's
 *     own (`users.id = req.session.requestor.id`).
 *
 * Auth posture
 * ------------
 * Self-edit only. Both handlers require a `user`-kind requestor on
 * `req.session`; anonymous and agent callers are rejected with 401.
 * No `users:manage` admin gate runs here on purpose — the admin route
 * (`PATCH /users/{id}`) intentionally does not touch
 * `architect_pdf_header`, and the architect is the only person who
 * needs to edit their own display name / email.
 *
 * Profile bootstrap
 * -----------------
 * The session middleware fires `ensureUserProfile` for every fresh
 * `user`-kind requestor, but that's a fire-and-forget upsert — the
 * row may not have landed by the time the FE first opens Settings
 * and immediately submits. We re-run `ensureUserProfile` inline here
 * so the update target always exists, even on a never-before-seen
 * id.
 *
 * Avatar safety gates
 * -------------------
 * `PATCH /me/profile` reuses the size cap, image-bytes sniff, and
 * orphaned-upload rollback from `lib/avatarWrites.ts` so the
 * architect-self-edit surface cannot become a backdoor for storing
 * oversized or non-image blobs at `users.avatar_url`. The admin
 * `/users/{id}` route uses the same helpers — adjust the gates
 * there once and both routes pick up the change.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  UpdateMyArchitectPdfHeaderBody,
  UpdateMyProfileBody,
  PLAN_REVIEW_DISCIPLINE_VALUES,
  isPlanReviewDiscipline,
  type PlanReviewDiscipline,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { ensureUserProfile } from "../lib/userProfiles";
import { toUserResponse } from "./users";
import {
  enforceAvatarIsImage,
  enforceAvatarSizeCap,
  objectStorage,
  readCandidateAvatarUrl,
  requestUploadUrlBodySizeMax,
  rollbackOrphanedAvatar,
} from "../lib/avatarWrites";

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

/**
 * `PATCH /me/profile` — architect self-edit of `displayName` / `email`
 * / `avatarUrl`.
 *
 * Mirrors the partial-update semantics of the admin `PATCH /users/{id}`:
 *   - Omit a field to leave it unchanged.
 *   - `email` and `avatarUrl` accept `null` to clear them.
 *   - `displayName` is non-nullable and trimmed; an empty / whitespace-
 *     only value is a 400 (we never silently demote a real name to
 *     the opaque user id).
 *   - `email` is also trimmed; the empty string normalises to `null`
 *     so the architect can clear the column with a blank input.
 *
 * The avatar-write surface (`avatarUrl` set to a `/objects/...` path)
 * runs through the same size cap, image-bytes sniff, and rollback
 * helpers as the admin route — see `../lib/avatarWrites.ts`.
 *
 * Defense-in-depth: the row id always comes from
 * `req.session.requestor.id`, never from the request body. Even if a
 * malicious caller smuggles an `id` field into the JSON, the handler
 * cannot be coerced into editing another user's row.
 */
router.patch("/me/profile", async (req: Request, res: Response) => {
  const requestor = req.session?.requestor;
  if (!requestor || requestor.kind !== "user") {
    res
      .status(401)
      .json({ error: "Self-edit requires a signed-in user session" });
    return;
  }

  // Read the raw avatarUrl up-front so the rollback can fire even on
  // 400 paths (where `parsed.data` doesn't exist yet) — same posture
  // as the admin PATCH handler.
  const candidateAvatar = readCandidateAvatarUrl(req.body);
  let avatarPersisted = false;
  let existingAvatar: string | null = null;
  let existingFetched = false;

  try {
    const parsed = UpdateMyProfileBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const body = parsed.data;

    const hasUpdate =
      body.displayName !== undefined ||
      body.email !== undefined ||
      body.avatarUrl !== undefined;
    if (!hasUpdate) {
      res.status(400).json({ error: "Empty update" });
      return;
    }

    // Validate displayName trim before we do anything expensive — the
    // empty / whitespace-only case is a hard 400 because demoting the
    // architect's name to "" (or the opaque user id, on the next
    // backfill) is never what they meant.
    let nextDisplayName: string | undefined;
    if (body.displayName !== undefined) {
      const trimmed = body.displayName.trim();
      if (trimmed.length === 0) {
        res.status(400).json({ error: "Display name cannot be empty" });
        return;
      }
      nextDisplayName = trimmed;
    }

    // Same idea for email: trim, and let an empty / whitespace-only
    // string be a "clear the column" shortcut so the FE form can use
    // a single Save button without needing a dedicated "clear email"
    // affordance. Explicit null also clears.
    let nextEmail: string | null | undefined;
    if (body.email !== undefined) {
      if (body.email === null) {
        nextEmail = null;
      } else {
        const trimmed = body.email.trim();
        nextEmail = trimmed.length === 0 ? null : trimmed;
      }
    }

    // Backfill the profile row in case the session middleware's
    // fire-and-forget upsert hasn't landed yet — same defensive
    // pattern as the architect-pdf-header handler above.
    await ensureUserProfile(requestor.id);

    const existingRows = await db
      .select()
      .from(users)
      .where(eq(users.id, requestor.id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      // Unreachable on the happy path — `ensureUserProfile` just
      // ran. If a concurrent DELETE raced past us the FE owes the
      // user a clear signal rather than a 500.
      res.status(404).json({ error: "User profile not found" });
      return;
    }
    existingAvatar = existing.avatarUrl;
    existingFetched = true;

    if (body.avatarUrl) {
      // Cheaper metadata round-trip first so a giant blob is rejected
      // before we read its head bytes.
      const sizeCheck = await enforceAvatarSizeCap(body.avatarUrl);
      if (sizeCheck.kind === "too_large") {
        res.status(413).json({
          error: `Avatar too large: ${sizeCheck.actualSize} bytes exceeds the ${requestUploadUrlBodySizeMax}-byte cap.`,
        });
        return;
      }
      if (sizeCheck.kind === "missing") {
        res
          .status(400)
          .json({ error: "Avatar object not found in storage" });
        return;
      }

      const imgCheck = await enforceAvatarIsImage(body.avatarUrl);
      if (imgCheck.kind === "not_image") {
        res.status(415).json({
          error: "Avatar bytes do not match a recognized image format",
        });
        return;
      }
      if (imgCheck.kind === "missing") {
        res
          .status(400)
          .json({ error: "Avatar object not found in storage" });
        return;
      }
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (nextDisplayName !== undefined) update["displayName"] = nextDisplayName;
    if (nextEmail !== undefined) update["email"] = nextEmail;
    if (body.avatarUrl !== undefined) {
      update["avatarUrl"] = body.avatarUrl ?? null;
    }

    const [row] = await db
      .update(users)
      .set(update)
      .where(eq(users.id, requestor.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }
    avatarPersisted = true;

    // Garbage-collect the prior avatar object once the row update has
    // committed and the patch actually replaced or cleared the column.
    // Same deletion posture as the admin route — log-and-continue on
    // failure so an admin's Settings save isn't 500'd by a transient
    // GCS blip on a cleanup branch.
    if (
      body.avatarUrl !== undefined &&
      existing.avatarUrl &&
      existing.avatarUrl !== row.avatarUrl
    ) {
      try {
        await objectStorage.deleteObjectIfStored(existing.avatarUrl);
      } catch (cleanupErr) {
        logger.warn(
          {
            err: cleanupErr,
            id: existing.id,
            prevAvatarUrl: existing.avatarUrl,
          },
          "failed to delete previous avatar object on self-edit",
        );
      }
    }

    res.json(toUserResponse(row));
  } catch (err) {
    logger.error({ err, id: requestor.id }, "update my profile failed");
    res.status(500).json({ error: "Failed to update profile" });
  } finally {
    // The freshly-uploaded path is orphaned iff: the request body
    // advertised one AND the row never landed pointing at it. The
    // existingAvatar guard prevents us from yanking the file out from
    // under a row that already references the same path (e.g. a 5xx
    // landed mid-update on a no-op re-send).
    if (!avatarPersisted && candidateAvatar) {
      if (!existingFetched || existingAvatar !== candidateAvatar) {
        await rollbackOrphanedAvatar(candidateAvatar, requestor.id);
      }
    }
  }
});

/**
 * `PATCH /me/disciplines` — reviewer self-edit of
 * `users.disciplines` (Track 1).
 *
 * Accepts `{ disciplines: PlanReviewDiscipline[] }`; rejects unknown
 * enum values with a 400. Empty array is allowed (clears the
 * reviewer's discipline scope; FE falls back to "Show all"). Hand-
 * written validation rather than a generated `UpdateMyDisciplinesBody`
 * because CT lands the regenerated zod schema in a follow-up — until
 * then this surface keeps the FE-driven default-filter UX unblocked.
 */
router.patch("/me/disciplines", async (req: Request, res: Response) => {
  const requestor = req.session?.requestor;
  if (!requestor || requestor.kind !== "user") {
    res
      .status(401)
      .json({ error: "Self-edit requires a signed-in user session" });
    return;
  }

  const body = req.body as { disciplines?: unknown } | undefined;
  if (!body || !Array.isArray(body.disciplines)) {
    res.status(400).json({
      error: "Body must be { disciplines: PlanReviewDiscipline[] }",
    });
    return;
  }
  const out: PlanReviewDiscipline[] = [];
  const seen = new Set<PlanReviewDiscipline>();
  for (const v of body.disciplines) {
    if (!isPlanReviewDiscipline(v)) {
      res.status(400).json({
        error: `Unknown discipline; must be one of: ${PLAN_REVIEW_DISCIPLINE_VALUES.join(
          ", ",
        )}`,
      });
      return;
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }

  try {
    await ensureUserProfile(requestor.id);
    const [row] = await db
      .update(users)
      .set({ disciplines: out, updatedAt: new Date() })
      .where(eq(users.id, requestor.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }
    res.json(toUserResponse(row));
  } catch (err) {
    logger.error({ err, id: requestor.id }, "update my disciplines failed");
    res.status(500).json({ error: "Failed to update disciplines" });
  }
});

export default router;
