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
  // Manual-QGIS upload tables (DA-PI-1B). `briefing_sources` cascades
  // off `parcel_briefings` which cascades off `engagements`, so the
  // engagements truncate above clears them transitively — but listing
  // them explicitly keeps the "if a route writes to it, it's in this
  // list" invariant honest and means a future test that seeds rows
  // without touching engagements still gets a clean slate.
  "parcel_briefings",
  "briefing_sources",
  // DA-PI-5 Revit-sensor materialization tables. These cascade off
  // engagements / parcel_briefings, but listing them keeps the
  // "if a route writes to it, it's in this list" invariant honest
  // and lets tests that seed bim_models without an engagement
  // (impossible today, defensive) still get a clean slate.
  "bim_models",
  "materializable_elements",
  "briefing_divergences",
  // DA-PI-3 generation jobs. Cascades off `engagements`, but listed
  // explicitly per the "if a route writes to it, it's in this list"
  // invariant — and also so suites that seed jobs without going
  // through the engagement table still get a clean slate.
  "briefing_generation_jobs",
  "code_atom_fetch_queue",
  "code_atoms",
  "code_atom_sources",
  // `atom_events` has no FK to the entity tables (it stores
  // entity_type+entity_id as opaque text), so the engagements CASCADE
  // does not clear it. Producers like the sheet ingest route now write
  // here, so we must reset it between tests to keep chain assertions
  // independent.
  "atom_events",
  // `users` is the profile-lookup table the actor-hydration helper
  // reads through. Tests that seed display names via this table need
  // it reset between cases so the rows do not leak across `it`s.
  "users",
  // Federal-adapter response cache (Task #180). Tests for the
  // generate-layers route assert hit/miss behaviour, so we must
  // reset the table between cases.
  "adapter_response_cache",
  // Wave 2 Sprint C / Spec 307 — reviewer-annotation rows. Cascades
  // off `submissions` (which cascades off `engagements`), but listed
  // explicitly per the "if a route writes to it, it's in this list"
  // invariant.
  "reviewer_annotations",
  // Task #431 — reviewer↔architect inline reply thread. Cascades off
  // `submissions`, but listed explicitly per the "if a route writes
  // to it, it's in this list" invariant.
  "submission_comments",
  // PLR-5 — reviewer-sent communication-event rows. Cascades off
  // `submissions`, but listed explicitly per the "if a route writes
  // to it, it's in this list" invariant so a suite that exercises
  // the communications composer always starts from a known-empty
  // state.
  "submission_communications",
  // V1-1 / AIR-1 — finding row + its producing-run row. Both
  // cascade off `submissions`, but listed explicitly per the
  // "if a route writes to it, it's in this list" invariant. `findings`
  // also has a `revision_of` self-FK with `ON DELETE SET NULL`, so
  // truncating the table doesn't trip a cascade chain.
  "findings",
  "finding_runs",
  // Wave 2 Sprint D / V1-2 — reviewer-request rows. Cascades off
  // `engagements`, but listed explicitly per the "if a route writes
  // to it, it's in this list" invariant — and so suites that test
  // the implicit-resolve hook can verify a known starting state
  // without piggy-backing on the engagements truncate.
  "reviewer_requests",
  // PLR-10 — tenant-scoped canned-finding library. No FK to anything,
  // so the engagements truncate above does not clear it. Listed
  // explicitly per the "if a route writes to it, it's in this list"
  // invariant — cannedFindings.test.ts seeds rows directly via drizzle
  // and needs a clean slate between cases.
  "canned_findings",
  // V1-4 / DA-RP-1 (Spec 54 v2) — mnml.ai render rows. `render_outputs`
  // cascades off `viewpoint_renders` which cascades off `engagements`,
  // so the engagements truncate above clears them transitively — but
  // listing them explicitly keeps the "if a route writes to it, it's
  // in this list" invariant honest and means a future test that seeds
  // render rows without going through engagements still gets a clean
  // slate.
  "viewpoint_renders",
  "render_outputs",
  // Architect inbox read-watermark. No FK to anything, so the
  // engagements truncate above does not clear it. Listed explicitly
  // per the "if a route writes to it, it's in this list" invariant,
  // and so the notifications suite can assert unread-count
  // transitions from a known empty starting state.
  "architect_notification_reads",
  // Task #485 — QA autopilot orchestration tables. `autopilot_findings`
  // and `autopilot_fix_actions` cascade off `autopilot_runs`, so
  // truncating the parent transitively clears the children — but
  // listed explicitly per the "if a route writes to it, it's in this
  // list" invariant so the orchestrator integration suite (and any
  // future suite that queries the latest-run endpoints) starts from
  // a known-empty state between cases.
  "autopilot_runs",
  "autopilot_findings",
  "autopilot_fix_actions",
  // Task #482 / #484 — QA dashboard kv (autopilot toggle + notify
  // settings). No FK to anything, so the engagements truncate above
  // does not clear it. qa-autopilot-notify.test.ts seeds it directly.
  "qa_settings",
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
