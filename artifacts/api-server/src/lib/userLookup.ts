/**
 * User-profile hydration for actor identities surfaced on timeline /
 * audit-trail responses.
 *
 * Atom events store actors as `{ kind, id }` where `id` is whatever
 * opaque identifier the request session carried — for `kind === "user"`
 * that's a profile id, for `kind === "agent" | "system"` it's a stable
 * code-side label (e.g. `snapshot-ingest`, `engagement-edit`). This
 * module turns a list of those raw actors into a list of "hydrated"
 * actors where user-kind entries gain a `displayName` (and, when
 * available, `email` / `avatarUrl`) pulled from the `users` table.
 *
 * Contract:
 *   - Input order is preserved.
 *   - One round-trip to Postgres regardless of how many actors are
 *     passed in (single `WHERE id IN (...)`), de-duplicated by id.
 *   - Unknown user ids degrade gracefully: the actor is returned with
 *     no `displayName` so the UI can render its own "Unknown user"
 *     fallback. We deliberately do NOT inject a placeholder string here
 *     because the FE knows how to localise / style that fallback.
 *   - Non-user kinds are passed through unchanged so callers can blast
 *     their full event list through this helper without filtering.
 *   - DB failure does not break the response: callers that surface
 *     timelines should treat a thrown lookup as "no profiles" and emit
 *     the raw actors. (The current callers wrap accordingly.)
 */

import { db, users } from "@workspace/db";
import { inArray } from "drizzle-orm";

export interface RawActor {
  kind: "user" | "agent" | "system";
  id: string;
}

export interface HydratedActor extends RawActor {
  /** Human-readable label. Present only when a matching `users` row
   *  exists (and only meaningful for `kind === "user"`). */
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * Look up display names for any `kind === "user"` actor in the input.
 * Pure function over its inputs — does not mutate the array it receives.
 *
 * @param actors raw actors (e.g. taken straight from `atom_events.actor`).
 * @returns a new array, same order, with user actors enriched.
 */
export async function hydrateActors(
  actors: ReadonlyArray<RawActor>,
): Promise<HydratedActor[]> {
  // Collect unique user ids for a single batched lookup. agent/system
  // kinds are skipped — they have no profile row and never will.
  const userIds = new Set<string>();
  for (const a of actors) {
    if (a.kind === "user" && a.id) userIds.add(a.id);
  }

  if (userIds.size === 0) {
    // Fast path: nothing to look up. Return a shallow copy so callers
    // can mutate the result without touching the input.
    return actors.map((a) => ({ ...a }));
  }

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, Array.from(userIds)));

  const byId = new Map<
    string,
    { displayName: string; email: string | null; avatarUrl: string | null }
  >();
  for (const row of rows) {
    byId.set(row.id, {
      displayName: row.displayName,
      email: row.email,
      avatarUrl: row.avatarUrl,
    });
  }

  return actors.map((a) => {
    if (a.kind !== "user") return { ...a };
    const profile = byId.get(a.id);
    if (!profile) return { ...a };
    const out: HydratedActor = { ...a, displayName: profile.displayName };
    if (profile.email) out.email = profile.email;
    if (profile.avatarUrl) out.avatarUrl = profile.avatarUrl;
    return out;
  });
}
