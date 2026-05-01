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
 * There is no real auth layer yet (see `middlewares/session.ts`), so
 * these endpoints are not gated server-side beyond the dev-vs-prod
 * baseline of `sessionMiddleware`. Once an auth layer lands the right
 * gate is `req.session.permissions?.includes("users:manage")` (or the
 * equivalent role check). Documented inline rather than left as a
 * silent gap so the follow-up is easy to find.
 *
 * Validation
 * ----------
 * Bodies are validated with the generated zod schemas from
 * `@workspace/api-zod` so the route can never accept a shape the
 * OpenAPI spec doesn't advertise. PATCH treats `email` and `avatarUrl`
 * specially — `null` clears the column, an absent key leaves it
 * unchanged. `displayName` is non-nullable, so `null` would be a 400
 * (the zod schema enforces `.optional()`, not `.nullish()`).
 */

import { Router, type IRouter, type Request, type Response } from "express";
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

const router: IRouter = Router();

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

router.post("/users", async (req: Request, res: Response) => {
  const parsed = CreateUserBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const body = parsed.data;

  try {
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

    const [row] = await db
      .insert(users)
      .values({
        id: body.id,
        displayName: body.displayName,
        email: body.email ?? null,
        avatarUrl: body.avatarUrl ?? null,
      })
      .returning();
    if (!row) {
      // Defensive: drizzle's `.returning()` always returns the inserted
      // rows on Postgres, but typing it as optional keeps the contract
      // honest if the dialect ever changes.
      res.status(500).json({ error: "Insert returned no row" });
      return;
    }
    res.status(201).json(toUserResponse(row));
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
    logger.error({ err, id: body.id }, "create user failed");
    res.status(500).json({ error: "Failed to create user" });
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

router.patch("/users/:id", async (req: Request, res: Response) => {
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

  try {
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
    res.json(toUserResponse(row));
  } catch (err) {
    logger.error({ err, id: params.data.id }, "update user failed");
    res.status(500).json({ error: "Failed to update user" });
  }
});

router.delete("/users/:id", async (req: Request, res: Response) => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const deleted = await db
      .delete(users)
      .where(eq(users.id, params.data.id))
      .returning({ id: users.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    logger.error({ err, id: params.data.id }, "delete user failed");
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;
