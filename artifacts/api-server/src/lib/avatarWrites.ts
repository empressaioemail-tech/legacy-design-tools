/**
 * Shared helpers for routes that let a caller change a `users.avatar_url`
 * pointer.
 *
 * Two routes write the column today:
 *
 *   - `PATCH /api/users/:id` (admin CRUD, gated on `users:manage`)
 *   - `PATCH /api/me/profile` (architect self-edit, no admin claim)
 *
 * Without a shared module each handler would have to re-implement the
 * same chain of "has the FE just uploaded a blob?", "is it the right
 * size?", "is it actually an image?", "do we need to roll the orphan
 * back?" — and the two surfaces would inevitably drift. The helpers
 * here are response-agnostic (they return tagged outcomes) so each
 * route can map outcomes onto the HTTP status it owes its specific
 * caller.
 *
 * `objectStorage` is exported as a singleton because the
 * `ObjectStorageService` constructor reads env vars on demand and is
 * stateless beyond that — one instance is enough for the whole
 * api-server process and lets test files mock `../lib/objectStorage`
 * once and have all consumers see the stub.
 */

import { ObjectNotFoundError, ObjectStorageService } from "./objectStorage";
import {
  IMAGE_SIGNATURE_HEAD_BYTES,
  looksLikeImage,
} from "./imageSignature";
import { requestUploadUrlBodySizeMax } from "@workspace/api-zod";
import { logger } from "./logger";

/** Re-exported so callers don't have to also import the cap from api-zod. */
export { requestUploadUrlBodySizeMax };

/**
 * Single instance shared by every route that touches the avatar column.
 * The constructor is cheap and the service is stateless beyond
 * lazily-read env vars, so a process-wide singleton is fine.
 */
export const objectStorage: ObjectStorageService = new ObjectStorageService();

/**
 * Outcome of {@link enforceAvatarSizeCap}. Tagged so the handler can map
 * each branch onto its own HTTP response without the helper baking in a
 * specific status code.
 */
export type AvatarSizeCheck =
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
 * 413 we owe the caller.
 */
export async function enforceAvatarSizeCap(
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
 * {@link AvatarSizeCheck} so route handlers can map outcomes onto HTTP
 * responses uniformly.
 */
export type AvatarImageCheck =
  | { kind: "ok" }
  | { kind: "external" }
  | { kind: "missing" }
  | { kind: "not_image" };

/**
 * Confirm that the bytes stored under `rawAvatarUrl` actually decode
 * to one of the image formats we accept.
 *
 * The presigned-URL endpoint pre-checks the *declared* `contentType`,
 * but a non-browser client can declare image/jpeg and PUT arbitrary
 * bytes via the signed URL. Without a second check, that arbitrary
 * blob gets referenced from `users.avatar_url` and served to other
 * users under an `<img>` tag.
 */
export async function enforceAvatarIsImage(
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
 * Pull a string `avatarUrl` candidate out of the raw request body
 * BEFORE zod validation runs. Lets the rollback path fire even on a
 * 400 (body shape rejected by zod). `deleteObjectIfStored` is itself
 * defensive (no-ops for empty / external / non-`/objects/...` inputs),
 * so we don't filter on shape here.
 */
export function readCandidateAvatarUrl(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)["avatarUrl"];
  return typeof value === "string" ? value : null;
}

/**
 * Best-effort rollback for an `avatarUrl` the request advertised but
 * that no row ended up pointing at. Log-and-continue on failure so a
 * transient GCS blip during rollback never turns into a 500 on top of
 * whatever the user was already trying to recover from.
 */
export async function rollbackOrphanedAvatar(
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
