/**
 * User-profile mutation helpers — the write-side counterpart to
 * `userLookup.ts` (which only reads from `users` for actor hydration).
 *
 * Two responsibilities live here:
 *
 *   1. {@link ensureUserProfile} — best-effort upsert of a profile row
 *      the first time we see a given user id on a request. Wired into
 *      `sessionMiddleware` so a real signup / login flow does not need
 *      a separate "create profile" round trip; the timeline will show
 *      a sensible default `displayName` (the id itself) until an admin
 *      edits it via the `PATCH /api/users/:id` route.
 *
 *   2. CRUD primitives consumed by `routes/users.ts`. Centralising them
 *      here keeps the route module thin and keeps the same code paths
 *      under test in `users.test.ts`.
 *
 * Failure mode for {@link ensureUserProfile}: swallowed and logged. The
 * profile is presentation metadata, not a security boundary — a request
 * must never 5xx because the backfill insert failed (e.g. transient DB
 * blip). The next request will retry; the audit trail is unaffected
 * because actor ids are recorded directly on `atom_events`.
 */

import { db, users } from "@workspace/db";
import { logger } from "./logger";

/**
 * Upsert a profile row for `id` if one does not already exist. Best
 * effort: failures are logged and swallowed. Safe to call on every
 * request — Postgres' `ON CONFLICT DO NOTHING` makes the no-op path
 * a single round trip with no row update.
 *
 * `defaultDisplayName` falls back to the id itself so an unattended
 * first-login produces a non-empty label rather than an empty string.
 */
export async function ensureUserProfile(
  id: string,
  defaultDisplayName?: string,
): Promise<void> {
  if (!id) return;
  try {
    await db
      .insert(users)
      .values({
        id,
        displayName:
          defaultDisplayName && defaultDisplayName.length > 0
            ? defaultDisplayName
            : id,
      })
      .onConflictDoNothing({ target: users.id });
  } catch (err) {
    // Best-effort — never break the request because of a profile
    // backfill failure. The next request will retry; the audit log
    // is unaffected because event actor ids are stored directly on
    // `atom_events`, not joined through `users`.
    logger.warn({ err, id }, "ensureUserProfile failed");
  }
}
