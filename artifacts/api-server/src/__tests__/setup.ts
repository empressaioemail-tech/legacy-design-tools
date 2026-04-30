/**
 * Helpers for api-server route integration tests.
 *
 * Lifecycle (one-schema-per-file):
 *   beforeAll: create a fresh test schema, store it on the shared `ctx`,
 *              build a test Express app (router-only — no startQueueWorker
 *              side effect from real `app.ts`).
 *   afterEach: TRUNCATE the explicit table list between tests so sequences
 *              and contents reset without paying for a fresh schema.
 *   afterAll:  drop the schema and close its pool.
 *
 * Test files are responsible for declaring their own `vi.mock` calls (they
 * must be hoisted at the top of the test file) — this module only owns the
 * schema lifecycle and the test-app construction.
 */

import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  createTestSchema,
  dropTestSchema,
  truncateAll,
} from "@workspace/db/testing";
import { ctx } from "./test-context";
import { sessionMiddleware } from "../middlewares/session";

/**
 * Tables that the api-server tests touch. CASCADE handles FK chains, so
 * truncating `engagements` also clears snapshots/sheets/etc.
 *
 * Listed explicitly per the project's "no auto-discovery" rule — if you
 * add a new table that a route writes to, add it here too.
 */
export const TRUNCATE_TABLES: readonly string[] = [
  "engagements",
  "snapshots",
  "sheets",
  "code_atom_fetch_queue",
  "code_atoms",
  "code_atom_sources",
  // `atom_events` has no FK to the entity tables (it stores
  // entity_type+entity_id as opaque text), so the engagements CASCADE
  // does not clear it. Producers like the sheet ingest route now write
  // here, so we must reset it between tests to keep chain assertions
  // independent.
  "atom_events",
];

/**
 * Construct a fresh Express app that mounts the same router tree the real
 * server uses, but WITHOUT calling startQueueWorker. The background worker
 * would race with our tests' direct queue inserts.
 *
 * Imported lazily so vi.mock declarations in the calling file take effect
 * before the route module graph loads.
 */
export async function buildTestApp(): Promise<Express> {
  const { default: router } = await import("../routes");
  const app = express();
  // Mirror app.ts: cookie-parser → session middleware → routes. Without
  // these, route handlers that read `req.session` (chat, etc.) would
  // crash with "cannot read property 'audience' of undefined" inside the
  // route, which is harder to diagnose than a wiring mismatch caught at
  // setup time. Vitest sets NODE_ENV=test by default, so the dev-only
  // header overrides in `sessionMiddleware` are honored here — that is
  // how route tests opt into a specific audience without minting cookies.
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(sessionMiddleware);
  app.use("/api", router);
  return app;
}

/**
 * Wire up beforeAll/afterEach/afterAll for a route test file. Pass a callback
 * that receives the live `Express` app (rebuilt once after the schema opens).
 */
export function setupRouteTests(
  onReady: (getApp: () => Express) => void = () => {},
): void {
  let app: Express | null = null;

  beforeAll(async () => {
    ctx.schema = await createTestSchema();
    app = await buildTestApp();
    onReady(() => {
      if (!app) throw new Error("setupRouteTests: app not built");
      return app;
    });
  });

  afterEach(async () => {
    if (!ctx.schema) return;
    await truncateAll(ctx.schema.pool, TRUNCATE_TABLES);
  });

  afterAll(async () => {
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
    app = null;
  });
}
