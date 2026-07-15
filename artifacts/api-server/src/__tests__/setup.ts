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
import { userRateLimitMiddleware } from "../middlewares/userRateLimit";

/**
 * Tables that the api-server tests touch. CASCADE handles FK chains, so
 * truncating `engagements` also clears snapshots/sheets/etc.
 *
 * Listed explicitly per the project's "no auto-discovery" rule — if you
 * add a new table that a route writes to, add it here too.
 */
export const TRUNCATE_TABLES: readonly string[] = [
  "engagements",
  // Phase 2 shell experience — server-persisted workspace spaces. A standalone
  // table with NO FK to engagements, so the engagements CASCADE does not clear
  // it; must be truncated explicitly so the saved-spaces route suite starts
  // from a known-empty state.
  "saved_workspace_spaces",
  "recorded_instruments",
  "restriction_clauses",
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
  // Track B — server-side IFC ingest. Cascades off `snapshots` (which
  // cascades off `engagements`), but listed explicitly per the
  // "if a route writes to it, it's in this list" invariant so suites
  // that exercise the IFC ingest path always start from a known-empty
  // state.
  "snapshot_ifc_files",
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
  // Cotality map-proxy caches (0043) — reset between cases for the same
  // hit/miss-assertion reason as adapter_response_cache.
  "cotality_spatial_tile_cache",
  "cotality_property_attr_cache",
  "cotality_geocode_cache",
  // Central TX county-GIS parcels tile cache (0051) — read-through cache
  // for the county provider in front of the dormant Cotality spatial-tile
  // path; reset between cases for the same hit/miss-assertion reason.
  "tx_parcel_tile_cache",
  // Wave 2 Sprint C / Spec 307 — reviewer-annotation rows. Cascades
  // off `submissions` (which cascades off `engagements`), but listed
  // explicitly per the "if a route writes to it, it's in this list"
  // invariant.
  "reviewer_annotations",
  // Track D Phase 2 — engagement-scoped 2D/3D annotations. Cascades off
  // `engagements` (and `finding_id` is ON DELETE SET NULL, no cascade
  // chain), but listed explicitly per the "if a route writes to it, it's
  // in this list" invariant so the annotation-route suite starts clean.
  "engagement_annotations",
  // Track F Phase 1 — annotation-generation seeds attached_documents.
  // Cascades off `engagements`, but listed explicitly per the "if a route
  // writes to it, it's in this list" invariant.
  "attached_documents",
  // Phase 2 Dataroom/Files tile — document->atom association. Cascades off
  // both `attached_documents` and `engagements`, but listed explicitly per
  // the "if a route writes to it, it's in this list" invariant so the
  // dataroom ingest-route suite starts clean.
  "dataroom_document_atoms",
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
  // WS-C — the in-app agent's `create_response_tasks` tool writes L1
  // response-tasks. Cascades off `engagements`, but listed explicitly
  // per the "if a route writes to it, it's in this list" invariant.
  "response_tasks",
  // Track 1 — auto-classification row (one-to-one with submissions).
  // Cascades off `submissions`, but listed explicitly per the
  // "if a route writes to it, it's in this list" invariant.
  "submission_classifications",
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
  // feat/durable-report-run-state — cross-instance plan-review report-run
  // STATE. No FK to anything (keyed on engagement_id+report_type text, not a
  // real FK — an engagement delete does not cascade to it), so the
  // engagements truncate above does not clear it. Listed per the "if a route
  // writes to it, it's in this list" invariant so the report-run route suite
  // starts from a known-empty state between cases.
  "report_run",
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
  // Task #503 — QA triage queue. No FK to anything, so listed
  // explicitly per the "if a route writes to it, it's in this list"
  // invariant.
  "qa_triage_items",
  // Task #482 / #484 — QA dashboard kv (autopilot toggle + notify
  // settings). No FK to anything, so the engagements truncate above
  // does not clear it. qa-autopilot-notify.test.ts seeds it directly.
  "qa_settings",
  "canva_design_pushes",
  "canva_push_jobs",
  "canva_connections",
  "canva_oauth_states",
  "collateral_metering_events",
  "collateral_exports",
  "collateral_export_jobs",
  "place_layer_snapshots",
  "brokerage_brief_runs",
  "brokerage_workspace_shares",
  "brokerage_workspace_attachments",
  "brokerage_workspaces",
  "brokerage_wallet_ledger",
  "brokerage_wallets",
  "brokerage_user_profiles",
  "gtm_events",
  "gtm_consent",
  "user_auth_credentials",
  "brokerage_install_claims",
  "user_usage_metering",
  "workspace_settings",
  // feat/cad-property-store — provider-neutral CAD property-attribute
  // store. No FK to anything (loaded by the @workspace/cad-ingest batch
  // CLI, read by future Property Brief slot adapters), so the
  // engagements truncate above does not clear it. Listed per the
  // "if a route writes to it, it's in this list" invariant so future
  // adapter-route suites start from a known-empty state.
  "cad_property",
  // feat/txgio-parcel-geometry — self-hosted TxGIO/StratMap parcel
  // geometry store (Hays/Comal). No FK to anything (loaded by the
  // @workspace/cad-ingest txgio-ingest CLI, read by the parcels
  // gis-layer + the point->prop_id resolver), so the engagements
  // truncate does not clear it. Listed per the "if a route writes to
  // it, it's in this list" invariant so store-backed route suites
  // start from a known-empty state.
  "txgio_parcel",
  // feat/txgio-address-points — self-hosted TxGIO/StratMap address-POINT
  // store (point sibling of txgio_parcel). No FK to anything (loaded by
  // the @workspace/cad-ingest address-ingest CLI, read by the geocode /
  // situs->parcel resolver), so the engagements truncate does not clear
  // it. Listed per the "if a route writes to it, it's in this list"
  // invariant so store-backed route suites start from a known-empty
  // state.
  "txgio_address",
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
  app.use(userRateLimitMiddleware);
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
    if (!process.env.PRIVATE_OBJECT_DIR?.trim()) {
      process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    }
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
