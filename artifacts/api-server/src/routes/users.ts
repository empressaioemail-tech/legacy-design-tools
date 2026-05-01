/**
 * /api/users — admin CRUD over the `users` profile table.
 *
 * The table itself is documented in `lib/db/src/schema/users.ts`; this
 * route is the management surface so the admin "Users & Roles" screen
 * (and the operator CLI, if/when it lands) can keep the display
 * names / emails / avatars that hydrate timeline actor labels in sync
 * without dropping into psql.
 *
 * Auth posture
 * ------------
 * Write operations (POST/PATCH/DELETE) are gated server-side on
 * `req.session.permissions?.includes("users:manage")` — non-admin
 * sessions get a 403 with a uniform error body. Reads (GET list,
 * GET by id) stay open so the timeline-hydration helper and the
 * read-only "Users & Roles" view can fetch profile rows without
 * elevating the caller. Once a real auth layer mints verified
 * sessions (Spec 20 follow-up, task #29) the same permission check
 * keeps working — only the *source* of `req.session.permissions`
 * changes, not the gate itself.
 *
 * Validation
 * ----------
 * Bodies are validated with the generated zod schemas from
 * `@workspace/api-zod` so the route can never accept a shape the
 * OpenAPI spec doesn't advertise. PATCH treats `email` and `avatarUrl`
 * specially — `null` clears the column, an absent key leaves it
 * unchanged. `displayName` is non-nullable, so `null` would be a 400
 * (the zod schema enforces `.optional()`, not `.nullish()`).
 *
 * Avatar object cleanup
 * ---------------------
 * Both PATCH (when `avatarUrl` is replaced or cleared) and DELETE
 * best-effort delete the previous avatar's underlying object in GCS so
 * orphaned `/objects/uploads/<uuid>` files don't accumulate forever.
 * The cleanup is gated by `ObjectStorageService.deleteObjectIfStored`,
 * which silently no-ops for empty / external / already-gone URLs and
 * only ever touches paths under our private object dir. Cleanup
 * failures log a warning and the request still succeeds — the DB row
 * is the source of truth and an orphaned object is the very problem
 * this code is trying to *reduce*, so a transient GCS blip should
 * never turn into a 500 on a profile edit.
 *
 * The mirror leak — a freshly-uploaded avatar that the FE pushed to
 * GCS just before a PATCH/POST that ends up failing (validation 400,
 * 404, transient 500, …) — is closed by the rollback path on both
 * write handlers: any `avatarUrl` the request body advertised gets
 * fed to `deleteObjectIfStored` once we know the row never landed
 * pointing at it. The same "best-effort, log-and-continue" posture
 * applies — losing the rollback to a GCS blip leaves the orphan we
 * were already trying to mitigate, which is no worse than the
 * pre-existing failure mode.
 *
 * Avatar bytes-are-an-image gate
 * ------------------------------
 * The presigned-URL endpoint pre-checks the *declared* `contentType`
 * against the image MIME allow-list, but the bytes themselves are
 * PUT directly to GCS so a non-browser caller can declare
 * `image/jpeg` and upload a JSON dump (or HTML page, or any other
 * blob that fits under the size cap). Both POST and PATCH therefore
 * sniff the head of the stored object via {@link enforceAvatarIsImage}
 * before persisting `avatarUrl`; anything that doesn't decode to one
 * of the formats {@link looksLikeImage} accepts surfaces as a 415 and
 * the orphan blob is best-effort cleaned up. The DB row never gets
 * to reference a non-image, even if the bytes briefly land in the
 * bucket.
 */

import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { db, users } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  CreateUserBody,
  GetUserParams,
  UpdateUserBody,
  UpdateUserParams,
  DeleteUserParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import {
  IMAGE_SIGNATURE_HEAD_BYTES,
  looksLikeImage,
} from "../lib/imageSignature";
import { requestUploadUrlBodySizeMax } from "@workspace/api-zod";

const router: IRouter = Router();
// One instance is enough — the service is stateless beyond the env-var
// reads it does on demand, and `objectStorageClient` is already a module
// singleton. Constructed lazily-by-import so test files that mock
// `../lib/objectStorage` get their stub here too.
const objectStorage = new ObjectStorageService();

/**
 * Outcome of {@link enforceAvatarSizeCap}. The handler maps these onto
 * HTTP responses; the helper itself stays response-agnostic so it can be
 * reused unchanged from POST and PATCH (and any future write surface).
 */
type AvatarSizeCheck =
  | { kind: "ok" }
  | { kind: "external" } // Caller supplied a URL we don't host (skip).
  | { kind: "missing" } // Path looks like ours but the object isn't in the bucket.
  | { kind: "too_large"; actualSize: number };

/**
 * Enforce the per-asset byte cap on a client-supplied avatar URL by
 * inspecting the *actual* stored object size.
 *
 * The presigned-URL handler caps `RequestUploadUrlBody.size` (client-
 * declared metadata), but a malicious or buggy non-browser client can
 * lie about that number and still PUT a much larger file. Validating
 * the real size here, before `users.avatar_url` is allowed to point at
 * the object, closes that loop: the row never references an oversized
 * blob, even if the bytes briefly landed in the bucket.
 *
 * On `too_large` we also best-effort delete the offending object so the
 * rejected upload doesn't leave an orphan in storage. The cleanup is
 * inside its own try/catch — a delete failure must not mask the real
 * 413 we owe the caller. (The orphan-sweep follow-up will mop up
 * anything we still miss here.)
 */
async function enforceAvatarSizeCap(
  rawAvatarUrl: string,
): Promise<AvatarSizeCheck> {
  let actualSize: number | null;
  try {
    actualSize = await objectStorage.getObjectEntitySize(rawAvatarUrl);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { kind: "missing" };
    }
    throw err;
  }
  if (actualSize === null) {
    // Not one of ours — pasted external URL, public-objects path, etc.
    // The cap only applies to objects we host.
    return { kind: "external" };
  }
  if (actualSize > requestUploadUrlBodySizeMax) {
    try {
      await objectStorage.deleteObjectIfStored(rawAvatarUrl);
    } catch (cleanupErr) {
      logger.warn(
        { err: cleanupErr, avatarUrl: rawAvatarUrl, actualSize },
        "failed to delete oversized avatar after rejection",
      );
    }
    return { kind: "too_large", actualSize };
  }
  return { kind: "ok" };
}

/**
 * Outcome of {@link enforceAvatarIsImage}. Mirrors the shape of
 * {@link AvatarSizeCheck} so the route handlers can map outcomes onto
 * HTTP responses uniformly. The helper itself stays response-agnostic
 * so it can be reused unchanged from POST and PATCH.
 */
type AvatarImageCheck =
  | { kind: "ok" }
  | { kind: "external" } // Caller supplied a URL we don't host (skip).
  | { kind: "missing" } // Path looks like ours but the object isn't in the bucket.
  | { kind: "not_image" };

/**
 * Confirm that the bytes stored under `rawAvatarUrl` actually decode
 * to one of the image formats we accept on the avatar upload path.
 *
 * The presigned-URL endpoint pre-checks the *declared* `contentType`
 * against the image MIME allow-list, but the bytes themselves are
 * PUT directly to GCS via the signed URL — so a non-browser caller
 * can declare `image/jpeg` and upload arbitrary bytes (a JSON dump,
 * an executable, an HTML page, …). Without a second check, that
 * arbitrary blob ends up referenced from `users.avatar_url` and gets
 * served to other admins under an `<img>` tag.
 *
 * This helper closes that loop: we read the head of the stored object
 * and run it through {@link looksLikeImage}. If the signature doesn't
 * match, the row is never allowed to point at the object and the
 * orphan is best-effort deleted on the way out (same posture as the
 * `too_large` branch in {@link enforceAvatarSizeCap}). The cleanup is
 * inside its own try/catch so a delete failure doesn't mask the real
 * 415 we owe the caller — the orphan-sweep follow-up will mop up
 * anything we still miss here.
 */
async function enforceAvatarIsImage(
  rawAvatarUrl: string,
): Promise<AvatarImageCheck> {
  let head: Buffer | null;
  try {
    head = await objectStorage.getObjectEntityHead(
      rawAvatarUrl,
      IMAGE_SIGNATURE_HEAD_BYTES,
    );
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { kind: "missing" };
    }
    throw err;
  }
  if (head === null) {
    // Not one of ours — pasted external URL, public-objects path,
    // etc. We can't sniff bytes we don't host, and the legacy "paste
    // a URL" path needs to keep working, so treat it as a skip.
    return { kind: "external" };
  }
  if (!looksLikeImage(head)) {
    try {
      await objectStorage.deleteObjectIfStored(rawAvatarUrl);
    } catch (cleanupErr) {
      logger.warn(
        { err: cleanupErr, avatarUrl: rawAvatarUrl },
        "failed to delete non-image avatar after rejection",
      );
    }
    return { kind: "not_image" };
  }
  return { kind: "ok" };
}

/**
 * Permission name required by every write to the `users` profile
 * table. Centralised here (rather than copy-pasted into each handler)
 * so the gate stays in lock-step with the OpenAPI description and the
 * future permissions-mapping module — when real auth lands, only this
 * single string needs to move.
 */
const USERS_MANAGE = "users:manage";

/**
 * Express middleware that 403s any caller whose session does not carry
 * the {@link USERS_MANAGE} permission claim. Mounted in front of the
 * write handlers below; the read handlers stay open so that the
 * timeline-hydration helper and the read-only "Users & Roles" view
 * (when an admin first lands on it) can still fetch profile rows.
 *
 * Returns the same `ErrorResponse` body shape the rest of the route
 * uses so the FE's `extractErrorMessage` helper picks up the message
 * uniformly.
 */
const requireUsersManage: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.session.permissions?.includes(USERS_MANAGE)) {
    next();
    return;
  }
  res.status(403).json({ error: "Requires users:manage permission" });
};

/**
 * Pull a string `avatarUrl` candidate out of the raw request body
 * BEFORE zod validation runs. We need this so that even a 400 (body
 * shape rejected by `UpdateUserBody` / `CreateUserBody`) can still
 * roll back the freshly-uploaded GCS object the FE pushed up just
 * ahead of the PATCH/POST. `deleteObjectIfStored` is internally
 * defensive (no-ops for empty / external / non-`/objects/...`
 * inputs), so we don't need to filter on shape here.
 */
function readCandidateAvatarUrl(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)["avatarUrl"];
  return typeof value === "string" ? value : null;
}

/**
 * Best-effort rollback for an `avatarUrl` the request advertised but
 * that no row ever ended up pointing at. Mirrors the posture of the
 * existing OLD-avatar cleanup branches — log and continue on failure
 * so a transient GCS blip during rollback never turns into a 500 on
 * top of whatever the user was already trying to recover from.
 */
async function rollbackOrphanedAvatar(
  candidate: string | null,
  userId: string | null,
): Promise<void> {
  if (!candidate) return;
  try {
    await objectStorage.deleteObjectIfStored(candidate);
  } catch (cleanupErr) {
    logger.warn(
      { err: cleanupErr, id: userId, orphanedAvatarUrl: candidate },
      "failed to delete orphaned avatar object after failed user write",
    );
  }
}

type UserRow = typeof users.$inferSelect;

interface UserResponse {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function toUserResponse(row: UserRow): UserResponse {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/users", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(users)
      .orderBy(asc(users.displayName));
    res.json(rows.map(toUserResponse));
  } catch (err) {
    logger.error({ err }, "list users failed");
    res.status(500).json({ error: "Failed to list users" });
  }
});

router.post("/users", requireUsersManage, async (req: Request, res: Response) => {
  // Read the raw avatarUrl up-front so the rollback can fire even on
  // body-validation 400s (where `parsed.data` doesn't exist yet).
  const candidateAvatar = readCandidateAvatarUrl(req.body);
  // Tracks whether a row that points at `candidateAvatar` actually
  // landed in the DB. If we exit the handler without flipping this
  // true and the body advertised an avatar, the freshly-uploaded
  // object is orphaned and we roll it back.
  let avatarPersisted = false;
  let candidateUserId: string | null = null;

  try {
    const parsed = CreateUserBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const body = parsed.data;
    candidateUserId = body.id;

    // Conflict-aware insert: `id` is the primary key, so a duplicate id
    // surfaces as a Postgres 23505 unique-violation. We pre-check for the
    // common case (clearer 409 path, no log spam from "expected" errors)
    // *and* catch the unique-violation in case two creates race past the
    // pre-check. Both paths return the same 409 to the client.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.id))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "A user with this id already exists" });
      return;
    }

    // Validate the *actual* stored size of the avatar object before we
    // let the row reference it. See enforceAvatarSizeCap doc for the
    // threat model — covers the "non-browser client lies about size in
    // the presigned-URL request and PUTs a huge file anyway" path.
    if (body.avatarUrl) {
      const check = await enforceAvatarSizeCap(body.avatarUrl);
      if (check.kind === "too_large") {
        res.status(413).json({
          error: `Avatar too large: ${check.actualSize} bytes exceeds the ${requestUploadUrlBodySizeMax}-byte cap.`,
        });
        return;
      }
      if (check.kind === "missing") {
        res.status(400).json({ error: "Avatar object not found in storage" });
        return;
      }
    }

    // Sniff the bytes themselves to confirm they actually decode to
    // an image. The presigned-URL endpoint constrains the *declared*
    // contentType to the image MIME allow-list, but a non-browser
    // client can declare image/jpeg and PUT arbitrary bytes — see
    // enforceAvatarIsImage for the threat model. Run after the size
    // check so a malicious PUT with a huge JSON dump is rejected by
    // the cheaper metadata round-trip first.
    if (body.avatarUrl) {
      const imgCheck = await enforceAvatarIsImage(body.avatarUrl);
      if (imgCheck.kind === "not_image") {
        res.status(415).json({
          error: "Avatar bytes do not match a recognized image format",
        });
        return;
      }
      if (imgCheck.kind === "missing") {
        res.status(400).json({ error: "Avatar object not found in storage" });
        return;
      }
    }

    let row;
    try {
      [row] = await db
        .insert(users)
        .values({
          id: body.id,
          displayName: body.displayName,
          email: body.email ?? null,
          avatarUrl: body.avatarUrl ?? null,
        })
        .returning();
    } catch (err) {
      // Map raced unique-violations onto the same 409 the pre-check uses.
      // node-postgres surfaces the SQLSTATE on `.code`; drizzle wraps the
      // driver error and exposes it on `.cause`. Check both defensively.
      const pgCode =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (pgCode === "23505") {
        res.status(409).json({ error: "A user with this id already exists" });
        return;
      }
      throw err;
    }
    if (!row) {
      // Defensive: drizzle's `.returning()` always returns the inserted
      // rows on Postgres, but typing it as optional keeps the contract
      // honest if the dialect ever changes.
      res.status(500).json({ error: "Insert returned no row" });
      return;
    }
    // Row landed pointing at whatever the body asked for, including
    // `avatarUrl`. From here the candidate is referenced — skip rollback.
    avatarPersisted = true;
    res.status(201).json(toUserResponse(row));
  } catch (err) {
    logger.error({ err, id: candidateUserId }, "create user failed");
    res.status(500).json({ error: "Failed to create user" });
  } finally {
    if (!avatarPersisted) {
      // No row was inserted that points at `candidateAvatar`, so any
      // freshly-uploaded GCS object the FE pushed up is now an orphan.
      // For POST there's no pre-existing row to compare against, so we
      // don't have to worry about deleting a still-referenced path.
      await rollbackOrphanedAvatar(candidateAvatar, candidateUserId);
    }
  }
});

router.get("/users/:id", async (req: Request, res: Response) => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, params.data.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(toUserResponse(row));
  } catch (err) {
    logger.error({ err, id: params.data.id }, "get user failed");
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

router.patch("/users/:id", requireUsersManage, async (req: Request, res: Response) => {
  // Read the raw avatarUrl up-front so the rollback fires even on the
  // 400 paths below (where we haven't parsed the body yet).
  const candidateAvatar = readCandidateAvatarUrl(req.body);
  // Tracks whether a row landed pointing at `candidateAvatar`. If we
  // exit the handler without flipping this true, the freshly-uploaded
  // object is orphaned and we roll it back in the `finally` block.
  let avatarPersisted = false;
  // Captured once we've successfully read the existing row so the
  // rollback can avoid deleting a path the existing row still
  // references (e.g. caller PATCHes the same avatarUrl back and the
  // DB write later fails — the row still points at it, so we must
  // NOT rip the object out from under it).
  let existingAvatar: string | null = null;
  let existingFetched = false;
  const idForLog =
    typeof req.params?.["id"] === "string" ? req.params["id"] : null;

  try {
    const params = UpdateUserParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsedBody = UpdateUserBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const body = parsedBody.data;

    // Reject empty patches up front — silently no-op'ing them would let
    // the FE swallow a buggy form submission, and `updatedAt` would still
    // tick which is also confusing. Easier to surface the mistake.
    const hasUpdate =
      body.displayName !== undefined ||
      body.email !== undefined ||
      body.avatarUrl !== undefined;
    if (!hasUpdate) {
      res.status(400).json({ error: "Empty update" });
      return;
    }

    const existingRows = await db
      .select()
      .from(users)
      .where(eq(users.id, params.data.id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    existingAvatar = existing.avatarUrl;
    existingFetched = true;

    // Same actual-size enforcement as POST. Only run when the patch
    // actually sets a new non-null `avatarUrl` — clearing the column
    // (`null`) and leaving it unchanged (`undefined`) both skip the
    // GCS metadata round-trip.
    if (body.avatarUrl) {
      const check = await enforceAvatarSizeCap(body.avatarUrl);
      if (check.kind === "too_large") {
        res.status(413).json({
          error: `Avatar too large: ${check.actualSize} bytes exceeds the ${requestUploadUrlBodySizeMax}-byte cap.`,
        });
        return;
      }
      if (check.kind === "missing") {
        res.status(400).json({ error: "Avatar object not found in storage" });
        return;
      }
    }

    // Same magic-number sniff as POST. The size check above already
    // rejected the cheap "huge JSON dump" case via metadata; this is
    // the smaller-but-still-non-image case (a 4 KB HTML page declared
    // as image/jpeg, etc). Only the route handler 415s — the helper
    // itself is response-agnostic so the same code can drive POST and
    // PATCH. The previous avatar (if any) is left intact: only the
    // freshly-uploaded non-image gets cleaned up inside the helper.
    if (body.avatarUrl) {
      const imgCheck = await enforceAvatarIsImage(body.avatarUrl);
      if (imgCheck.kind === "not_image") {
        res.status(415).json({
          error: "Avatar bytes do not match a recognized image format",
        });
        return;
      }
      if (imgCheck.kind === "missing") {
        res.status(400).json({ error: "Avatar object not found in storage" });
        return;
      }
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.displayName !== undefined) update["displayName"] = body.displayName;
    // `email` and `avatarUrl` accept `null` as "clear this column".
    // Distinguish "key absent" from "key explicitly null" by checking
    // for `undefined` (zod's `.nullish()` collapses both into the same
    // type but the runtime value preserves the difference).
    if (body.email !== undefined) update["email"] = body.email ?? null;
    if (body.avatarUrl !== undefined) {
      update["avatarUrl"] = body.avatarUrl ?? null;
    }

    const [row] = await db
      .update(users)
      .set(update)
      .where(eq(users.id, existing.id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    // Row landed pointing at the requested avatarUrl (or kept the
    // existing one when the patch didn't touch it). Either way, the
    // candidate is now referenced and must NOT be rolled back.
    avatarPersisted = true;

    // Once the row update has committed, garbage-collect the prior
    // avatar object if the patch is replacing or clearing it. We only
    // act when the patch actually touches `avatarUrl` (otherwise an
    // email-only patch would re-evaluate the field unnecessarily) and
    // when the previous value is non-null and different from the new
    // one. `deleteObjectIfStored` itself filters out external URLs and
    // collapses 404s, so we don't need to special-case those here.
    if (
      body.avatarUrl !== undefined &&
      existing.avatarUrl &&
      existing.avatarUrl !== row.avatarUrl
    ) {
      try {
        await objectStorage.deleteObjectIfStored(existing.avatarUrl);
      } catch (cleanupErr) {
        // The DB row already changed; an orphaned object is the
        // pre-existing failure mode this whole feature is mitigating,
        // so log and move on rather than 500'ing the admin's edit.
        logger.warn(
          { err: cleanupErr, id: existing.id, prevAvatarUrl: existing.avatarUrl },
          "failed to delete previous avatar object",
        );
      }
    }

    res.json(toUserResponse(row));
  } catch (err) {
    logger.error({ err, id: idForLog }, "update user failed");
    res.status(500).json({ error: "Failed to update user" });
  } finally {
    // The freshly-uploaded path is orphaned iff: the request body
    // advertised one AND the row never landed pointing at it. The
    // existingAvatar guard prevents us from yanking the file out from
    // under a row that already references the same path (e.g. a 5xx
    // landed mid-update on a no-op re-send). When we never managed to
    // fetch the existing row (e.g. body validation 400) we fall
    // through to cleanup — the FE owns the rollback no matter what,
    // and `deleteObjectIfStored` is a no-op for non-`/objects/` paths
    // so a pasted external URL is harmless to forward.
    if (!avatarPersisted && candidateAvatar) {
      if (!existingFetched || existingAvatar !== candidateAvatar) {
        await rollbackOrphanedAvatar(candidateAvatar, idForLog);
      }
    }
  }
});

router.delete("/users/:id", requireUsersManage, async (req: Request, res: Response) => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    // Use `.returning(...)` to grab the prior `avatarUrl` in the same
    // round-trip as the delete itself. Doing it this way (rather than a
    // SELECT-then-DELETE) means we never race a concurrent admin write
    // and end up trying to delete the wrong file.
    const deleted = await db
      .delete(users)
      .where(eq(users.id, params.data.id))
      .returning({ id: users.id, avatarUrl: users.avatarUrl });
    if (deleted.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const prevAvatarUrl = deleted[0]?.avatarUrl ?? null;
    if (prevAvatarUrl) {
      try {
        await objectStorage.deleteObjectIfStored(prevAvatarUrl);
      } catch (cleanupErr) {
        // Same posture as PATCH: the row is already gone, so a failed
        // object cleanup downgrades to a logged warning rather than a
        // 500 the FE has no way to recover from.
        logger.warn(
          { err: cleanupErr, id: params.data.id, prevAvatarUrl },
          "failed to delete avatar object after user delete",
        );
      }
    }

    res.status(204).end();
  } catch (err) {
    logger.error({ err, id: params.data.id }, "delete user failed");
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;
