import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { engagements } from "./engagements";
import { materializableElements } from "./materializableElements";

/**
 * A *terrain generation job* records one async run (or attempted run) of the
 * site-topography ingest worker — the heavy CPU authoring path (DEM → gridded
 * triangle mesh → GLB → ifcopenshell IFC) that used to run SYNCHRONOUSLY inside
 * the `POST …/site-topography/refresh` request handler.
 *
 * Why async, why a table. The mesh build is a nested per-pixel loop on the Node
 * main thread and the IFC author spawns a Python sidecar; on the shared 2-CPU
 * cortex-api container both pegged the cores and starved the co-scheduled 29s
 * brief request, producing Cloud Run "malformed response" 503s. Moving the
 * authoring off the request path is the fix: the refresh route now inserts a
 * `queued` row and returns 202 immediately; a fire-and-forget worker (the same
 * `void`-launched pattern `viewpoint_renders` uses) runs the ingest off the
 * request path and drives this row's `status` to a terminal state; the read
 * route reports that status back so the Brief can poll.
 *
 * Identity: the row's `id` IS the `jobId` returned to the client on enqueue and
 * echoed by the status read. Modeled on `briefing_generation_jobs` /
 * `viewpoint_renders`, whose PK doubles as the public job id.
 *
 * Status: `queued` (enqueued, worker not started) → `generating` (worker began
 * the DEM/mesh/IFC authoring) → `ready` (ingest succeeded; the materialized
 * `materializable_elements` site-topography row carries the mesh/ifc/confidence)
 * | `failed` (ingest threw or an upstream stage failed) | `no-coverage` (no
 * parcel + no geocode — a well-formed engagement the worker cannot derive an
 * extent for). Stored as text to match this codebase's conversion-status style;
 * the routes narrow it to a closed wire union.
 *
 * Single-flight: at most one row per `engagement_id` may be `queued` OR
 * `generating` at a time, enforced by the partial unique index
 * `terrain_generation_jobs_active_per_engagement_uniq`. A concurrent refresh
 * loses on the unique-violation and the route maps that to the existing active
 * job's id (idempotent re-poll) rather than launching a second authoring run —
 * exactly the CPU contention we are removing. This mirrors the
 * `briefing_generation_jobs` pending-per-engagement guard.
 *
 * Orphan rescue: a worker that crashes mid-authoring (deploy restart, OOM)
 * leaves a `queued`/`generating` row that no live worker will ever settle. The
 * periodic sweeper at `artifacts/api-server/src/lib/terrainGenerationJobsSweep.ts`
 * fails rows older than a wall-clock threshold (the standard `finding_runs`
 * rescue shape) and reaps old terminal rows so the table stays bounded.
 *
 * `materializable_element_id` is a back-pointer to the site-topography read row
 * the successful run produced, stamped on the `ready` transition so the read
 * route can serve the propertySet without re-querying by (engagement, kind).
 * Nullable (unset while non-terminal, and on failure); cascade `set null` so a
 * read-row deletion does not leave a dangling job.
 */
export const terrainGenerationJobs = pgTable(
  "terrain_generation_jobs",
  {
    /**
     * The job's id IS the public `jobId` the refresh route returns and the
     * status read echoes back.
     */
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /**
     * The MCP place engagement's deterministic place key, when the job was
     * enqueued via the address/lat-lng place plane (the Brief path). Lets the
     * read route resolve a job by placeKey without re-minting the engagement.
     * Null on the direct engagement-scoped refresh path.
     */
    placeKey: text("place_key"),
    /**
     * Normalized ingest parameters (contourIntervalMeters, catchmentBufferMeters,
     * demResolutionMeters, forceRefresh, jurisdictionTenant). The worker reads
     * these off the row instead of holding them in a process-local closure, so a
     * rescued/re-driven run authors with the same inputs.
     */
    requestPayload: jsonb("request_payload"),
    /**
     * `queued` → `generating` → `ready` | `failed` | `no-coverage`. Stored as
     * text; the routes narrow it to the closed wire union.
     */
    status: text("status").notNull(),
    /** Stable failure code (the ingest worker's `upstream-error` code, or a worker code). */
    errorCode: text("error_code"),
    /** Verbatim failure message (truncated by the worker if long). */
    errorMessage: text("error_message"),
    /**
     * The site-topography `materializable_elements` row this run produced.
     * Stamped on the `ready` transition; null while non-terminal and on failure.
     */
    materializableElementId: uuid("materializable_element_id").references(
      () => materializableElements.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Null while non-terminal; stamped on the terminal transition. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    /** Status polls / single-flight checks look up by engagement, newest first. */
    engagementCreatedIdx: index(
      "terrain_generation_jobs_engagement_created_idx",
    ).on(t.engagementId, t.createdAt),
    /** placeKey read path (the Brief resolves a job by placeKey). */
    placeKeyIdx: index("terrain_generation_jobs_place_key_idx").on(t.placeKey),
    /** Sweep scans `status IN ('queued','generating', …)`; keep it index-served. */
    statusIdx: index("terrain_generation_jobs_status_idx").on(t.status),
    /**
     * Single-flight guard — at most one non-terminal (queued OR generating)
     * job per engagement. A concurrent refresh loses on the unique-violation
     * and the route maps that to the active job's id instead of launching a
     * second authoring run.
     */
    activePerEngagementUniq: uniqueIndex(
      "terrain_generation_jobs_active_per_engagement_uniq",
    )
      .on(t.engagementId)
      .where(sql`${t.status} in ('queued', 'generating')`),
  }),
);

export const terrainGenerationJobsRelations = relations(
  terrainGenerationJobs,
  ({ one }) => ({
    engagement: one(engagements, {
      fields: [terrainGenerationJobs.engagementId],
      references: [engagements.id],
    }),
    materializableElement: one(materializableElements, {
      fields: [terrainGenerationJobs.materializableElementId],
      references: [materializableElements.id],
    }),
  }),
);

export type TerrainGenerationJob = typeof terrainGenerationJobs.$inferSelect;
export type NewTerrainGenerationJob =
  typeof terrainGenerationJobs.$inferInsert;
