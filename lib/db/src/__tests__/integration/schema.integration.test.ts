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
  const pgErr = (err as { cause?: { code?: string }; code?: string }).cause ??
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
        // PLR-10 — tenant-scoped canned-finding library curated by
        // tenant admins; reviewers consume entries on FindingsTab to
        // pre-fill the manual-add form.
        "canned_findings",
        "canva_connections",
        "canva_design_pushes",
        "canva_oauth_states",
        "canva_push_jobs",
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
        "gtm_events",
        "knowledge_atoms",
        "materializable_elements",
        "package_share_comments",
        "package_shares",
        "parcel_briefings",
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
        // v2 cortex reasoning/citation atoms — deeplinks + capped snippet, not corpus code_atoms.
        "reasoning_atoms",
        // ADR-020 Phase 1 — engagement-scoped recorded instruments (R4 upload).
        "recorded_instruments",
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
        // Cortex L2 (Lane C.4 / C.4.2) — structured sheet-content
        // extraction atoms (OCR segments + annotations).
        "sheet_content_extractions",
        "sheets",
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
        // Central TX county-GIS parcels provider (0051) — read-through
        // tile cache keyed (tile_key, county_fips); neutral of (and
        // parallel to) the dormant Cotality spatial-tile cache tables.
        "tx_parcel_tile_cache",
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
