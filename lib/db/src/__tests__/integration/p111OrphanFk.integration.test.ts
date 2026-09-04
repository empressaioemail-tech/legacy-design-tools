/**
 * OPS-16 P-111 (A-075/A-076) integration coverage.
 *
 * `pe_saved_properties` and `pe_screens` previously had NO foreign key to
 * `users` at all, so deleting a user permanently orphaned their saved
 * property list and Studio screens. This file proves two things against a
 * real Postgres (not just the TS schema's declared shape):
 *
 *   1. Deleting a `users` row now cascades to `pe_saved_properties` and
 *      `pe_screens` (and transitively to `pe_screen_rows`, which already
 *      cascaded off `pe_screens.id` before this change), and the FK is
 *      enforced going forward (an insert for a nonexistent user is
 *      rejected; another user's rows are untouched).
 *   2. Migration `0097_pe_saved_properties_and_screens_user_fk.sql` -- read
 *      from disk, not re-typed here -- actually does what its comments
 *      claim: it deletes pre-existing orphans before adding the FK, and it
 *      is safe to run against a schema with zero orphans / to run twice
 *      (the common CI case, since a freshly-pushed schema already carries
 *      the FK and has nothing to clean up).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { users, peSavedProperties, peScreens, peScreenRows } from "../../schema";
import { withTestSchema } from "../../testing";

const migrationSql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "drizzle",
    "0097_pe_saved_properties_and_screens_user_fk.sql",
  ),
  "utf8",
);

/**
 * Vitest's .rejects.toThrow only inspects message text, but Drizzle's
 * DrizzleQueryError stuffs the SQL into the message and the real PG
 * SQLSTATE code into the underlying `cause`. Same helper as
 * schema.integration.test.ts (kept local -- neither file exports it).
 */
async function expectPgError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the promise to reject").toBeDefined();
  const pgErr =
    (err as { cause?: { code?: string }; code?: string }).cause ??
    (err as { code?: string });
  expect(pgErr.code).toBe(code);
}

const PG_FOREIGN_KEY_VIOLATION = "23503";

describe("OPS-16 P-111: pe_saved_properties / pe_screens owner_user_id FK", () => {
  it("cascades: deleting a user removes their saved properties, screens, and screen rows", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [user] = await db
        .insert(users)
        .values({ id: "p111-cascade-user", displayName: "P-111 Cascade User" })
        .returning({ id: users.id });

      await db.insert(peSavedProperties).values({
        ownerUserId: user.id,
        parcelNodeId: "48055:10068",
      });

      const [screen] = await db
        .insert(peScreens)
        .values({ ownerUserId: user.id, name: "Test Screen" })
        .returning({ id: peScreens.id });

      await db.insert(peScreenRows).values({
        screenId: screen.id,
        ordinal: 0,
        query: "123 Main St",
        resolution: "unresolved",
        source: "pasted",
      });

      const countOf = async (table: string) => {
        const res = await pool.query<{ c: string }>(
          `SELECT COUNT(*)::text c FROM ${table}`,
        );
        return Number(res.rows[0].c);
      };

      expect(await countOf("pe_saved_properties")).toBe(1);
      expect(await countOf("pe_screens")).toBe(1);
      expect(await countOf("pe_screen_rows")).toBe(1);

      await db.delete(users).where(eq(users.id, user.id));

      expect(await countOf("pe_saved_properties")).toBe(0);
      expect(await countOf("pe_screens")).toBe(0);
      expect(await countOf("pe_screen_rows")).toBe(0);
    });
  });

  it("does not cascade-delete another user's saved properties or screens", async () => {
    await withTestSchema(async ({ db }) => {
      const [userA] = await db
        .insert(users)
        .values({ id: "p111-user-a", displayName: "User A" })
        .returning({ id: users.id });
      const [userB] = await db
        .insert(users)
        .values({ id: "p111-user-b", displayName: "User B" })
        .returning({ id: users.id });

      await db
        .insert(peSavedProperties)
        .values({ ownerUserId: userA.id, parcelNodeId: "48055:aaa" });
      await db
        .insert(peSavedProperties)
        .values({ ownerUserId: userB.id, parcelNodeId: "48055:bbb" });
      await db.insert(peScreens).values({ ownerUserId: userA.id, name: "A's screen" });
      await db.insert(peScreens).values({ ownerUserId: userB.id, name: "B's screen" });

      await db.delete(users).where(eq(users.id, userA.id));

      const remainingSaved = await db.select().from(peSavedProperties);
      expect(remainingSaved).toHaveLength(1);
      expect(remainingSaved[0].ownerUserId).toBe(userB.id);

      const remainingScreens = await db.select().from(peScreens);
      expect(remainingScreens).toHaveLength(1);
      expect(remainingScreens[0].ownerUserId).toBe(userB.id);
    });
  });

  it("rejects a saved property / screen for a user id that does not exist", async () => {
    await withTestSchema(async ({ db }) => {
      await expectPgError(
        db
          .insert(peSavedProperties)
          .values({ ownerUserId: "no-such-user", parcelNodeId: "48055:ghost" }),
        PG_FOREIGN_KEY_VIOLATION,
      );
      await expectPgError(
        db.insert(peScreens).values({ ownerUserId: "no-such-user", name: "ghost screen" }),
        PG_FOREIGN_KEY_VIOLATION,
      );
    });
  });

  it("migration 0097 deletes pre-existing orphans, adds the FK, and is safe to run twice", async () => {
    await withTestSchema(async ({ db, pool, schemaName }) => {
      // Simulate the actual pre-migration prod shape (OPS-16 A-075): drop
      // the FK this migration adds so an orphan row can be written at all
      // -- the constraint would otherwise refuse it, same as it will once
      // this migration ships.
      await pool.query(`
        ALTER TABLE pe_saved_properties
          DROP CONSTRAINT pe_saved_properties_owner_user_id_users_id_fk;
        ALTER TABLE pe_screens
          DROP CONSTRAINT pe_screens_owner_user_id_users_id_fk;
      `);

      const [liveUser] = await db
        .insert(users)
        .values({ id: "p111-live-user", displayName: "Live User" })
        .returning({ id: users.id });

      // Real, non-orphaned rows -- must survive the migration untouched.
      await db.insert(peSavedProperties).values({
        ownerUserId: liveUser.id,
        parcelNodeId: "48055:live",
      });
      await db.insert(peScreens).values({
        ownerUserId: liveUser.id,
        name: "Live screen",
      });

      // Orphans: owner_user_id points at no row in `users`. Only insertable
      // because the FK was just dropped above -- exactly the state OPS-16
      // A-075 found in prod (a deleted account's rows left behind forever).
      await pool.query(
        `INSERT INTO pe_saved_properties (owner_user_id, parcel_node_id) VALUES ($1, $2)`,
        ["ghost-user-1", "48055:orphan-1"],
      );
      await pool.query(
        `INSERT INTO pe_saved_properties (owner_user_id, parcel_node_id) VALUES ($1, $2)`,
        ["ghost-user-2", "48055:orphan-2"],
      );
      await pool.query(
        `INSERT INTO pe_screens (owner_user_id, name) VALUES ($1, $2)`,
        ["ghost-user-1", "orphan screen"],
      );

      // Run the actual migration file, byte for byte -- exactly what
      // migrate-prod.mjs sends to Postgres.
      await pool.query(migrationSql);

      const savedRows = await db.select().from(peSavedProperties);
      expect(savedRows).toHaveLength(1);
      expect(savedRows[0].ownerUserId).toBe(liveUser.id);
      expect(savedRows[0].parcelNodeId).toBe("48055:live");

      const screenRows = await db.select().from(peScreens);
      expect(screenRows).toHaveLength(1);
      expect(screenRows[0].ownerUserId).toBe(liveUser.id);

      // pg_constraint is a flat, database-wide catalog -- unlike an
      // ordinary table lookup it is NOT scoped by search_path, so every
      // other live test_* schema in the container (and `public`) also
      // carries a same-named constraint. Join to pg_namespace and filter
      // on this test's own schema, or the count silently inflates by
      // however many concurrent/leftover schemas happen to exist.
      const fkCheck = await pool.query<{ conname: string }>(
        `
        SELECT c.conname FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = $1
          AND c.conname IN (
            'pe_saved_properties_owner_user_id_users_id_fk',
            'pe_screens_owner_user_id_users_id_fk'
          )
        ORDER BY c.conname
        `,
        [schemaName],
      );
      expect(fkCheck.rows.map((r) => r.conname)).toEqual([
        "pe_saved_properties_owner_user_id_users_id_fk",
        "pe_screens_owner_user_id_users_id_fk",
      ]);

      // Idempotent / safe on a schema with zero orphans -- the common CI
      // case (a freshly-pushed schema is born with the FK and nothing to
      // clean up), and literally this schema's state right now after the
      // first apply above. Re-running must not throw and must not touch
      // the surviving live rows.
      await expect(pool.query(migrationSql)).resolves.toBeDefined();

      const savedRowsAfterRerun = await db.select().from(peSavedProperties);
      expect(savedRowsAfterRerun).toHaveLength(1);
      const screenRowsAfterRerun = await db.select().from(peScreens);
      expect(screenRowsAfterRerun).toHaveLength(1);
    });
  });
});
