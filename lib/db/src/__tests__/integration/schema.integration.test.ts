/**
 * lib/db schema integration tests.
 *
 * Replays the production DDL into a temporary `test_<ts>_<rand>` schema and
 * exercises the contracts that downstream code depends on:
 *   - all expected tables exist
 *   - FK cascade from engagement → snapshots → sheets
 *   - UNIQUE (snapshot_id, sheet_number) prevents duplicate sheets
 *   - UNIQUE (content_hash) prevents duplicate atoms
 *   - UNIQUE (source_id, section_url) prevents duplicate queue rows
 *   - pgvector column accepts a 1536-dim embedding and round-trips it
 *   - cosine self-distance ≈ 0
 *   - queue defaults: status=pending, attempts=0, next_attempt_at set
 *
 * Drizzle wraps PG errors in DrizzleQueryError; the underlying pg error
 * (with .code) is on `.cause`. The expectPgError helper handles both.
 */

import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  engagements,
  snapshots,
  sheets,
  codeAtomSources,
  codeAtoms,
  codeAtomFetchQueue,
  countyFacetCoverage,
} from "../../schema";
import { withTestSchema } from "../../testing";

/**
 * Vitest's .rejects.toThrow only inspects message text, but Drizzle's
 * DrizzleQueryError stuffs the SQL into the message and the real PG
 * SQLSTATE code into the underlying `cause`. This helper unwraps it.
 */
async function expectPgError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected the promise to reject").toBeDefined();
  // Drizzle: { cause: pgError }. Direct pg: pgError. Defensively try both.
  const pgErr =
    (err as { cause?: { code?: string }; code?: string }).cause ??
    (err as { code?: string });
  expect(pgErr.code).toBe(code);
}

const PG_UNIQUE_VIOLATION = "23505";

const minimalThumb = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // not a real PNG, schema only requires bytes

describe("lib/db schema integration", () => {
  it("creates every expected table in the test schema", async () => {
    await withTestSchema(async ({ pool, schemaName }) => {
      const res = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
        [schemaName],
      );
      const names = res.rows.map((r) => r.tablename);
      expect(names).toEqual([
        // Federal-adapter response cache (Task #180) — keyed on
        // (adapter_key, lat_rounded, lng_rounded) with a TTL gate so
        // re-runs of generate-layers skip the slow upstream feeds.
        "adapter_response_cache",
        // Per-architect "last viewed the inbox" watermark for the
        // design-tools notification surface. One row per user-kind
        // requestor id; bumped to "now" on POST
        // /me/notifications/mark-read.
        "architect_notification_reads",
        // Arrow-two Phase 3 — per-(atomId, jurisdictionTenant) calibration
        // overlay covering reasoning + corpus atoms (corpus never mutated).
        "atom_calibration_overlay",
        "atom_events",
        // Cortex L2 (Lane C.4 / C.4.2) — supporting documents attached
        // to an engagement (produced by the sheet-ingest pipeline).
        "attached_documents",
        // Task #482 / #486 — QA autopilot orchestration tables.
        // `autopilot_runs` is one row per kicked-off run;
        // `autopilot_findings` carries per-suite per-test findings; and
        // `autopilot_fix_actions` records fixer-applied side-effects we
        // may revert. Listed alphabetically to match `ORDER BY tablename`.
        "autopilot_findings",
        "autopilot_fix_actions",
        "autopilot_runs",
        // DA-PI-5 Revit-sensor materialization tables. Listed in
        // alphabetical order to match `ORDER BY tablename` from the
        // pg_tables query above. `bim_models` carries the per-engagement
        // pointer; `briefing_divergences` carries the operator-edit
        // log; `materializable_elements` carries the canonicalized
        // forms the divergences reference.
        "bim_models",
        "briefing_divergences",
        "briefing_generation_jobs",
        "briefing_sources",
        // Hauska Property Brief Chrome extension — persisted brief runs.
        "brokerage_brief_runs",
        // Task #29 — one install id maps to exactly one authenticated user.
        "brokerage_install_claims",
        "brokerage_user_profiles",
        "brokerage_wallet_ledger",
        "brokerage_wallets",
        "brokerage_workspace_attachments",
        "brokerage_workspace_shares",
        "brokerage_workspaces",
        // feat/cad-property-store — provider-neutral county appraisal
        // district (CAD) property-attribute store keyed
        // (county_fips, prop_id, tax_year); loaded by the
        // @workspace/cad-ingest batch CLI from free CAD bulk exports.
        "cad_property",
        // L21 / P-25 — deterministic cross-vintage CAD prop_id
        // crosswalk used by the blessed declared-vintage resolver.
        "cad_property_vintage_crosswalk",
        // L21 follow-up 3 / P-25 — explicit prior-vintage fallback list.
        "cad_property_vintage_fallback",
        // PLR-10 — tenant-scoped canned-finding library curated by
        // tenant admins; reviewers consume entries on FindingsTab to
        // pre-fill the manual-add form.
        "canned_findings",
        "canva_connections",
        "canva_design_pushes",
        "canva_oauth_states",
        "canva_push_jobs",
        // P-85 WDLL item 1 — clerk portal terms and operator ruling per portal.
        "clerk_portal_terms",
        "code_atom_fetch_queue",
        "code_atom_sources",
        "code_atoms",
        "collateral_export_jobs",
        "collateral_exports",
        "collateral_metering_events",
        "cotality_geocode_cache",
        "cotality_property_attr_cache",
        "cotality_spatial_tile_cache",
        "county_facet_coverage",
        // OPS-9 S1 onboarding ledger, per-registry-row OPS-8 pre-flight
        // gate + cert-grade state. Sorts after `county_facet_coverage`
        // (`_f` < `_g`) per `ORDER BY tablename`.
        "county_gate_cert_state",
        // L18 / P-14: singleton materialized GET /api/county-ledger payload.
        // Sorts after `county_gate_cert_state` (`_g` < `_l`) and before
        // `county_manifest` (`_l` < `_m`) per `ORDER BY tablename`.
        "county_ledger_snapshot",
        // Sprint 1 county manifest: `county_manifest` is the 254-row
        // denominator (every Texas county has a row whether or not it has
        // been worked) and `county_rail` is the 13-rail dimension. Sort
        // after `county_gate_cert_state` (`_g` < `_m` < `_r`) per
        // `ORDER BY tablename`.
        "county_manifest",
        "county_rail",
        "coverage_requests",
        // Phase 2 Dataroom/Files tile — document->atom association.
        // One row per engine-ingested extracted atom, pointing back to the
        // pinned source_document_cid (point-to model).
        "dataroom_document_atoms",
        // PLR-11 — derived-state side table for the issued plan-set
        // PDF (one row per recorded approval event).
        "decision_pdf_artifacts",
        // Cortex L6 (Lane C.4 / C.4.6) — rendered DOCX/PDF artifacts of
        // a deliverable letter. Sorts before `deliverable_letters`
        // (`_` < `s`) per `ORDER BY tablename`.
        "deliverable_letter_renders",
        // Cortex L3 (Lane C.4 / C.4.3) — deliverable-letter atoms.
        "deliverable_letters",
        // Cortex L4 (Lane C.4 / C.4.4) — Revit detail-callout specs.
        "detail_callout_specs",
        // Track D Phase 2 — engagement-scoped 2D/3D unified annotation
        // (markup / finding overlay). Distinct from `reviewer_annotations`
        // (submission-scoped scratch notes). Sorts before
        // `engagement_packages` (`_a` < `_p`) per `ORDER BY tablename`.
        "engagement_annotations",
        // Cockpit IA — engagement deliverable packages (client, publisher, jurisdiction).
        "engagement_packages",
        "engagements",
        // @workspace/eval harness tables (scaffolded in a8acb35;
        // landed alongside the per-run scoring + per-fixture
        // baseline schema). Listed alphabetically to match
        // `ORDER BY tablename`.
        "eval_baselines",
        "eval_runs",
        "eval_scores",
        // V1-1 / AIR-1 — finding atom row + producing-run row.
        // Supersedes the deleted `findings_code_atoms` placeholder
        // join (citation atomIds are now stored verbatim on
        // `findings.citations` jsonb per recon decision Ask #2).
        "finding_runs",
        "findings",
        // GTM observation layer — Property Brief extension consent + events.
        "gtm_consent",
        // P-100 item 5 — events this system declined to write for want of a
        // consent row. Sorts before `gtm_events` (`_` < `s`) per
        // `ORDER BY tablename`.
        "gtm_event_refusals",
        "gtm_events",
        // OPS-9 S1 onboarding ledger, read-side mirror of hauska-engine's
        // frozen JurisdictionRegistryRow. Sorts before `knowledge_atoms`
        // (`j` < `k`) per `ORDER BY tablename`.
        "jurisdiction_registry_row_mirror",
        "knowledge_atoms",
        // feat/manifest-observability-tables (0072) — dual commitment vs
        // lifetime cost per county. Sorts after `knowledge_atoms` and before
        // `manifest_run` (`_j` < `_r`) per `ORDER BY tablename`.
        "manifest_jurisdiction_cost",
        // feat/manifest-observability-tables (0072) — factory run row +
        // slot reservation + queue. Sorts after `manifest_jurisdiction_cost`
        // and before `materializable_elements` (`manifest_*` < `material_*`)
        // per `ORDER BY tablename`.
        "manifest_run",
        "manifest_slot_queue",
        "manifest_slot_reservation",
        "materializable_elements",
        // OPS-9 S1 onboarding ledger, one row per pre-flight decline /
        // block13-quarantine parcel / future warden-sweep finding. Sorts
        // after `materializable_elements` and before `package_share_comments`
        // (`o` between `m` and `p`) per `ORDER BY tablename`.
        "onboarding_ledger_event",
        "package_share_comments",
        "package_shares",
        "parcel_briefings",
        // R1 paywall (LOCK 2026-07-29) — signed-in-free chat counter +
        // per-property unlock record. Listed alphabetically to match
        // `ORDER BY tablename`.
        // P-98 next-action rail — shown/acted per ladder rung, scoped to the
        // PE USER rather than to `gtm_events`'s install_id. Sorts first in
        // the whole `pe_` block: `pe_ac` < `pe_ai` (`c` < `i`) per
        // `ORDER BY tablename`.
        // P-100 item 4 — once-per-account activation milestone. A DIFFERENT
        // subject from `pe_activation_events` (which is per ladder-rung
        // impression). Sorts before it: `pe_acc` < `pe_act` (`c` < `t`).
        "pe_account_activations",
        "pe_activation_events",
        // P-87 Claude Sync — MCP clients that have authenticated against
        // this account. Sorts after `pe_activation_events` and before
        // `pe_chat_message_counts` (`_ai` < `_ch`) per `ORDER BY tablename`.
        "pe_ai_connections",
        "pe_chat_message_counts",
        // P-112 email leg — magic-link sign-in tokens. Sorts after
        // `pe_chat_message_counts` and before `pe_parcel_constraint_index`
        // (`pe_ch` < `pe_ma` < `pe_pa`) per `ORDER BY tablename`.
        "pe_magic_link_tokens",
        // P-106 constraint search - the filterable projection of already-baked
        // facets, plus its build ledger. Sorts after `pe_chat_message_counts`
        // and before `pe_property_unlocks` (`pe_pa` < `pe_pr`) per
        // `ORDER BY tablename`.
        "pe_parcel_constraint_index",
        "pe_parcel_constraint_index_builds",
        "pe_property_unlocks",
        "pe_saved_properties",
        // P-91 / P-92 Wave B — screens are a different table from saves.
        "pe_screen_rows",
        "pe_screens",
        // P-86 — share grant registry. Resolvable URL is /s/{id}.
        // P-100 item 3 — which sharer a recipient account belongs to, keyed
        // on the grant row. Sorts before `pe_share_grants` (`_a` < `_g`).
        "pe_share_attributions",
        "pe_share_grants",
        "pe_team_invitations",
        "pe_team_members",
        "pe_user_entitlements",
        "pe_user_identities",
        "pe_workbench_state",
        // PLR-11 — atomic tenant-scoped permit-number counter.
        "permit_counters",
        // feat/permits-brief-slot — owned municipal issued-permit corpus
        // (Austin + San Antonio public-record acquisition, Wave 3);
        // loaded by the @workspace/cad-ingest permits-ingest CLI, read
        // by the permits:record Property Brief adapter.
        "permit_record",
        "place_layer_snapshots",
        // WS1 — per-piece discipline classification for plan-set decomposition.
        "plan_set_piece_classifications",
        // Cortex L5 (Lane C.4 / C.4.5) — ICC-ES product-spec references.
        "product_spec_references",
        // Task #481 — QA Dashboard checklist runs and per-item results.
        "qa_checklist_results",
        "qa_runs",
        // Task #482 — kv settings store for the QA dashboard
        // (notify.* keys land in #484, table shape unchanged).
        "qa_settings",
        // Task #503 — QA triage queue items (forwarded to planning).
        "qa_triage_items",
        // feat/manifest-observability-tables (0071) — append-only cell
        // history + verification audit trail. Sorts after `qa_triage_items`
        // and before `reasoning_atoms` (`rail_*` < `reason_*`) per
        // `ORDER BY tablename`.
        "rail_state_history",
        "rail_verification",
        // v2 cortex reasoning/citation atoms — deeplinks + capped snippet, not corpus code_atoms.
        "reasoning_atoms",
        // ADR-020 Phase 1 — engagement-scoped recorded instruments (R4 upload).
        "recorded_instruments",
        // P-85 WDLL item 4/6 — Records Request async jobs + acquired artifacts.
        "records_request_artifacts",
        "records_request_jobs",
        "render_outputs",
        // feat/durable-report-run-state — cross-instance plan-review
        // report-run STATE (replaces three instance-local Maps in
        // planReviewBff.ts). Keyed (engagement_id, report_type). Sorts after
        // `render_outputs` and before `response_tasks` (`ren` < `rep` < `res`)
        // per `ORDER BY tablename`.
        "report_run",
        // Cortex L1 (Lane C.4 / C.4.1) — response-task workflow rows.
        "response_tasks",
        // ADR-020 Phase 1 — restriction clauses extracted from instruments.
        "restriction_clauses",
        // Spec 307 / Task #307 — reviewer scratch-note surface anchored
        // per (submission, target atom) tuple. Reviewer-only until the
        // bulk-promote endpoint flips `promoted_at`.
        "reviewer_annotations",
        // Wave 2 Sprint D / V1-2 — reviewer-fired requests for
        // architect-side action (refresh briefing-source / refresh
        // bim-model / regenerate briefing). Resolved implicitly by
        // the matching domain action's atom-history event.
        "reviewer_requests",
        // Phase 2 shell experience — server-persisted, shareable named
        // workspace-layout spaces (tenant-ready). Sorts before
        // `sheet_content_extractions` (`sav` < `she`) per `ORDER BY tablename`.
        "saved_workspace_spaces",
        // SS-W7 / P-44 (0082) — one ingested CountyServingSweep per county,
        // the store behind GET /api/serving-sweep. Deliberately NOT a
        // statewide row: the statewide envelope is assembled at read time so
        // countiesSwept is measured from the array served. Sorts between
        // `saved_workspace_spaces` and `sheet_content_extractions`
        // (`sav` < `ser` < `she`) per `ORDER BY tablename`.
        "serving_sweep_county",
        // Cortex L2 (Lane C.4 / C.4.2) — structured sheet-content
        // extraction atoms (OCR segments + annotations).
        "sheet_content_extractions",
        "sheets",
        // OPS-17 G-14 — Smart Files, the city-file-system artifact family
        // (0078). A NEW family per amendment A-012; it does NOT extend
        // `brokerage_workspaces`. Split three ways because the promise forces
        // it: documents hold identity (one row per declared entityId, however
        // many places it appears), versions hold content append-only (revision
        // inserts and supersedes; nothing is overwritten, so history survives),
        // placements hold location many-to-many (placing again adds a row here,
        // never a copy of the document).
        // G-34 typed absence (0079). The record that we LOOKED for a document
        // and what we concluded. It exists as a TABLE because "only a positive
        // determination writes an absence" is unenforceable if the read path
        // can synthesize "absent" from a zero-row query — so the verdict must
        // be a row something deliberately wrote, and a read with no row here
        // reports `not-sought` instead. `basis` is NOT NULL and check-
        // constrained non-empty at the DB, so raw SQL cannot record an uncited
        // absence either.
        "smart_file_absence_determinations",
        "smart_file_documents",
        // G-56 / 0081 seed-only folder registry (not the graph).
        "smart_file_folder_records",
        "smart_file_folders",
        "smart_file_placements",
        "smart_file_versions",
        // IFC ingest metadata keyed off snapshots (parse status, global ids).
        "snapshot_ifc_files",
        "snapshots",
        // Track 1 — per-submission discipline / classification row.
        "submission_classifications",
        // Task #431 — reviewer↔architect inline reply thread anchored
        // to a submission. Distinct from `reviewer_annotations` (which
        // is reviewer-only scratch notes); this table is the
        // cross-audience conversation channel.
        "submission_comments",
        // PLR-5 — reviewer-sent communication-event rows (audit-grade
        // append-only letter log). Cascades off `submissions`.
        "submission_communications",
        "submissions",
        // async-terrain-job (0057) — async parcel-terrain authoring jobs.
        // Moves the heavy DEM->mesh->IFC authoring off the synchronous
        // refresh request path (viewpoint_renders-style: queued row +
        // fire-and-forget worker + status polling + orphan sweep).
        "terrain_generation_jobs",
        // feat/city-county-boundary-layer (0070) — statewide incorporated-
        // place polygons from TxGIO City_Boundaries. Sorts after
        // `terrain_generation_jobs` and before `tx_county_boundary`
        // (`_city` < `_county`) per `ORDER BY tablename`.
        "tx_city_boundary",
        // feat/city-county-boundary-layer (0070) — statewide county polygons
        // from Census TIGERweb (TxGIO has no county layer). Sorts after
        // `tx_city_boundary` and before `tx_parcel_tile_cache` (`_county` <
        // `_fema` < `_parcel`) per `ORDER BY tablename`.
        "tx_county_boundary",
        // feat/fema-nfhl-statewide-layer (0071) — statewide FEMA NFHL flood-
        // hazard polygons from NFHL_48 bulk FileGDB S_FLD_HAZ_AR. Sorts after
        // `tx_county_boundary` and before `tx_parcel_tile_cache` (`_fema` <
        // `_parcel`) per `ORDER BY tablename`.
        "tx_fema_nfhl_flood_zone",
        // Central TX county-GIS parcels provider (0051) — read-through
        // tile cache keyed (tile_key, county_fips); neutral of (and
        // parallel to) the dormant Cotality spatial-tile cache tables.
        "tx_parcel_tile_cache",
        // 0076 / P-75 — L22 utility who-serves staging. Sorts after
        // `tx_parcel_tile_cache` and before `txgio_address` (`_utility` <
        // `txgio`) per `ORDER BY tablename`.
        "tx_utility_territory_staging",
        // feat/txgio-address-points (0056) — self-hosted TxGIO/StratMap
        // address-POINT store (open paginated ArcGIS REST); point sibling
        // of txgio_parcel, keyed (county_fips, full_addr, unit).
        "txgio_address",
        // feat/txgio-parcel-geometry (0053) — self-hosted TxGIO/StratMap
        // parcel geometry store for counties without a live county GIS
        // (Hays/Comal); keyed (county_fips, tile_key, feature_index).
        "txgio_parcel",
        // Task #29 — hosted login credentials + per-user metering.
        "user_auth_credentials",
        "user_usage_metering",
        "users",
        "viewpoint_renders",
        // QA-57 — pilot workspace branding (firm display name, logo URL).
        "workspace_settings",
      ]);
    });
  });

  it("county_facet_coverage Phase A7 performance columns: defaults + nullability", async () => {
    await withTestSchema(async ({ db }) => {
      const [row] = await db
        .insert(countyFacetCoverage)
        .values({
          countyFips: "48491",
          facet: "zoning",
          integrityVerdict: "n/a",
          classification: "real-at-ceiling",
        })
        .returning();

      // Pre-existing columns still behave (additive change didn't disturb them).
      expect(row.honestCoveragePct).toBe("0.00");
      expect(row.sampled).toBe(0);

      // New performance columns: nullable ones default to NULL absent
      // an explicit value, defaulted ones land on their DB default.
      expect(row.recipeVersion).toBeNull();
      expect(row.certState).toBeNull();
      expect(row.lastRewarmAt).toBeNull();
      expect(row.lastRefreshAt).toBeNull();
      expect(row.stalenessFlag).toBe(false);
      expect(row.rewarmUnsafe).toBe(false);
      expect(row.costUsd).toBeNull();
      expect(row.onboarded).toBe(false);
    });
  });

  it("county_facet_coverage rejects a cert_state outside the enum", async () => {
    await withTestSchema(async ({ db }) => {
      await expectPgError(
        db.insert(countyFacetCoverage).values({
          countyFips: "48491",
          facet: "envelope",
          integrityVerdict: "n/a",
          classification: "real-at-ceiling",
          certState: "not-a-real-state",
        }),
        "23514", // PG check_violation
      );
    });
  });

  it("county_facet_coverage accepts every cert_state enum value + full performance-field write", async () => {
    await withTestSchema(async ({ db }) => {
      const now = new Date();
      const [row] = await db
        .insert(countyFacetCoverage)
        .values({
          countyFips: "48453",
          facet: "land-use",
          integrityVerdict: "pass",
          classification: "real-at-ceiling",
          recipeVersion: "recipe-2026.08.0",
          certState: "certified",
          lastRewarmAt: now,
          lastRefreshAt: now,
          stalenessFlag: true,
          rewarmUnsafe: true,
          costUsd: "184.50",
          onboarded: true,
        })
        .returning();

      expect(row.certState).toBe("certified");
      expect(row.recipeVersion).toBe("recipe-2026.08.0");
      expect(row.stalenessFlag).toBe(true);
      expect(row.rewarmUnsafe).toBe(true);
      expect(row.costUsd).toBe("184.50");
      expect(row.onboarded).toBe(true);
      expect(row.lastRewarmAt).toBeInstanceOf(Date);
      expect(row.lastRefreshAt).toBeInstanceOf(Date);
    });
  });

  it("cascades engagement → snapshot → sheet on delete", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [eng] = await db
        .insert(engagements)
        .values({
          name: "Test Engagement",
          nameLower: "test engagement",
          jurisdiction: "Moab, UT",
          address: "1 Main St, Moab, UT 84532",
          status: "active",
        })
        .returning({ id: engagements.id });
      const [snap] = await db
        .insert(snapshots)
        .values({
          engagementId: eng.id,
          projectName: "Test Snapshot",
          payload: { kind: "stub" },
        })
        .returning({ id: snapshots.id });
      await db.insert(sheets).values({
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: "A1",
        sheetName: "First Floor Plan",
        thumbnailPng: minimalThumb,
        thumbnailWidth: 100,
        thumbnailHeight: 100,
        fullPng: minimalThumb,
        fullWidth: 1000,
        fullHeight: 1000,
        sortOrder: 0,
      });

      const before = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM sheets`,
      );
      expect(Number(before.rows[0].c)).toBe(1);

      await db.delete(engagements).where(eq(engagements.id, eng.id));

      const snapsAfter = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM snapshots`,
      );
      expect(Number(snapsAfter.rows[0].c)).toBe(0);
      const sheetsAfter = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM sheets`,
      );
      expect(Number(sheetsAfter.rows[0].c)).toBe(0);
    });
  });

  it("rejects duplicate (snapshot_id, sheet_number)", async () => {
    await withTestSchema(async ({ db }) => {
      const [eng] = await db
        .insert(engagements)
        .values({
          name: "Dup Sheet Engagement",
          nameLower: "dup sheet engagement",
          jurisdiction: "Moab, UT",
          address: "x",
          status: "active",
        })
        .returning({ id: engagements.id });
      const [snap] = await db
        .insert(snapshots)
        .values({
          engagementId: eng.id,
          projectName: "Dup Snap",
          payload: {},
        })
        .returning({ id: snapshots.id });
      const baseSheet = {
        snapshotId: snap.id,
        engagementId: eng.id,
        sheetNumber: "A1",
        sheetName: "First",
        thumbnailPng: minimalThumb,
        thumbnailWidth: 1,
        thumbnailHeight: 1,
        fullPng: minimalThumb,
        fullWidth: 1,
        fullHeight: 1,
        sortOrder: 0,
      };
      await db.insert(sheets).values(baseSheet);
      await expectPgError(
        db.insert(sheets).values({ ...baseSheet, sheetName: "Duplicate" }),
        PG_UNIQUE_VIOLATION,
      );
    });
  });

  it("rejects duplicate code_atoms.content_hash", async () => {
    await withTestSchema(async ({ db }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_source",
          label: "Test Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });

      const baseAtom = {
        sourceId: src.id,
        jurisdictionKey: "test_jurisdiction",
        codeBook: "TEST_BOOK",
        edition: "Test 2025",
        sectionNumber: "1.1",
        sectionTitle: "Section One",
        body: "Body text",
        sourceUrl: "https://example.com/1.1",
        contentHash: "deadbeef".repeat(8), // 64-char fake sha256
      };
      await db.insert(codeAtoms).values(baseAtom);
      await expectPgError(
        db.insert(codeAtoms).values(baseAtom),
        PG_UNIQUE_VIOLATION,
      );
    });
  });

  it("stores and round-trips a 1536-dim pgvector embedding", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "vector_source",
          label: "Vector Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });

      const vec = Array.from({ length: 1536 }, (_, i) => (i % 7) / 10);
      await db.insert(codeAtoms).values({
        sourceId: src.id,
        jurisdictionKey: "vec_jurisdiction",
        codeBook: "VEC_BOOK",
        edition: "Vec 2025",
        body: "vector body",
        sourceUrl: "https://example.com/v",
        contentHash: "v".repeat(64),
        embedding: vec,
        embeddingModel: "text-embedding-3-small",
        embeddedAt: new Date(),
      });

      // Round-trip via raw SQL: pgvector returns "[0.0,0.1,...]" text format.
      const raw = await pool.query<{ embedding: string }>(
        `SELECT embedding::text AS embedding FROM code_atoms WHERE jurisdiction_key = $1 LIMIT 1`,
        ["vec_jurisdiction"],
      );
      expect(raw.rows).toHaveLength(1);
      const parsed = JSON.parse(raw.rows[0].embedding) as number[];
      expect(parsed).toHaveLength(1536);
      // Floating-point nudge from pgvector's normalisation: compare with tolerance.
      const expected = [0, 0.1, 0.2, 0.3, 0.4];
      for (let i = 0; i < expected.length; i++) {
        expect(parsed[i]).toBeCloseTo(expected[i], 5);
      }
    });
  });

  it("self-similarity via cosine distance is 0", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "cos_source",
          label: "Cos Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const vec = Array.from({ length: 1536 }, (_, i) => (i % 11) / 13);
      const vecLit = `[${vec.join(",")}]`;
      await db.insert(codeAtoms).values({
        sourceId: src.id,
        jurisdictionKey: "cos_jurisdiction",
        codeBook: "COS_BOOK",
        edition: "Cos 2025",
        body: "cos body",
        sourceUrl: "https://example.com/c",
        contentHash: "c".repeat(64),
        embedding: vec,
      });
      const dist = await pool.query<{ d: string }>(
        `SELECT (embedding <=> $1::vector) AS d FROM code_atoms WHERE jurisdiction_key = $2 LIMIT 1`,
        [vecLit, "cos_jurisdiction"],
      );
      expect(Number(dist.rows[0].d)).toBeCloseTo(0, 5);
    });
  });

  it("queue row defaults: status=pending, attempts=0, next_attempt_at set", async () => {
    await withTestSchema(async ({ db }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "queue_source",
          label: "Queue Source",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const [row] = await db
        .insert(codeAtomFetchQueue)
        .values({
          sourceId: src.id,
          jurisdictionKey: "qj",
          codeBook: "QB",
          edition: "Q 2025",
          sectionUrl: "https://example.com/q1",
        })
        .returning();
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
    });
  });

  it("rejects duplicate (source_id, section_url) on the queue", async () => {
    await withTestSchema(async ({ db }) => {
      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "queue_dedupe_source",
          label: "Queue Dedupe",
          sourceType: "html",
          licenseType: "public_record",
        })
        .returning({ id: codeAtomSources.id });
      const baseRow = {
        sourceId: src.id,
        jurisdictionKey: "j",
        codeBook: "B",
        edition: "E",
        sectionUrl: "https://example.com/dup",
      };
      await db.insert(codeAtomFetchQueue).values(baseRow);
      await expectPgError(
        db.insert(codeAtomFetchQueue).values(baseRow),
        PG_UNIQUE_VIOLATION,
      );
    });
  });
});

// avoid unused import lint when sql isn't actively referenced
void sql;
