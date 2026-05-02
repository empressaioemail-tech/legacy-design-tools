import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";
import { parcelBriefings } from "./parcelBriefings";
import { bimModels } from "./bimModels";
// Circular relation pair with `renderOutputs` (parent→child outputs +
// the reverse FK back-pointer). ESM hoists this import; the
// `relations()` callbacks below are lazy so the cycle resolves cleanly.
// Mirrors the parcelBriefings ↔ briefingGenerationJobs pattern.
import { renderOutputs } from "./renderOutputs";

/**
 * A *viewpoint render* (Spec 54 v2 §6.2 / V1-4 DA-RP-1) is the record
 * of a render the architect requested from mnml.ai for an engagement
 * that has both a `parcel_briefing` and a `bim_model`.
 *
 * Identity: one row per render request. Multiple renders per
 * engagement are valid (architects iterate); there is NO partial
 * unique index gating concurrent renders. This contrasts with
 * `briefing_generation_jobs` (which IS single-flight per engagement)
 * and is intentional — renders are user-initiated artifacts the
 * architect may want to queue several of in parallel while comparing
 * options.
 *
 * The `kind` discriminator is the api-server's domain vocabulary, not
 * mnml's wire vocabulary. The route translates:
 *
 *   - `still`         — 1 mnml /v1/archDiffusion-v43 call → 1 render_output (role `primary`)
 *   - `elevation-set` — 4 mnml /v1/archDiffusion-v43 calls (camera_direction
 *                       front/right/back/left) → 4 render_outputs
 *                       (roles `elevation-{n,e,s,w}`)
 *   - `video`         — 1 mnml /v1/video-ai call → 1 render_output
 *                       (role `video-primary`) plus a server-synthesized
 *                       ffmpeg-extracted thumbnail (role `video-thumbnail`)
 *
 * Snapshot semantics (Spec 54 §6 freshness mechanic): `briefing_id`
 * and `bim_model_id` are FKs that capture WHICH briefing / bim-model
 * the render was generated against; both use `ON DELETE SET NULL` so
 * a downstream regeneration of either upstream entity does not
 * cascade-delete the historical render row. Alongside the FKs, the
 * `briefing_atom_event_id` and `bim_model_atom_event_id` columns
 * capture the upstream's `latest_event` id at trigger time —
 * comparing those snapshots to the upstream's current latestEvent at
 * read time is how the render's freshness verdict ("current" vs
 * "stale-against-briefing" vs "stale-against-bim-model") is computed
 * by the atom's contextSummary.
 *
 * Status lifecycle (mirrors {@link RenderStatus} from
 * `@workspace/mnml-client`): `queued` → `rendering` → `ready` |
 * `failed` | `cancelled`. `cancelled` is a server-side concept (mnml
 * has no public cancel — Spec 54 v2 §6.1); the api-server simply
 * stops polling and writes this status to the row.
 *
 * Per-job fan-out columns:
 *   - `mnml_job_id`  — the single mnml-side render id for `still` and
 *                      `video` kinds. Stamped after the trigger call's
 *                      response. NULL for `elevation-set`.
 *   - `mnml_jobs`    — JSONB array `[{role, mnmlJobId, status, error?}]`
 *                      for `elevation-set` only. Tracks the four in-
 *                      flight per-direction calls so the polling
 *                      worker can iterate. NULL for `still` / `video`.
 *
 * Error fan-out:
 *   - `error_code`    — coarse bucket. e.g. `insufficient_credits`
 *                       (any-child failed with mnml's NO_CREDITS),
 *                       `elevation_set_partial` (rollup: at least one
 *                       child failed; partial successes still mirrored
 *                       per the Phase 1A approval), `validation`,
 *                       `unavailable`, etc.
 *   - `error_message` — human-readable blurb the FE renders verbatim.
 *   - `error_details` — JSONB structured payload, e.g.
 *                       `{ failed_directions: ["n", "s"] }` for
 *                       `elevation_set_partial`, or mnml's
 *                       `{ required_credits, available_credits }` for
 *                       `insufficient_credits`. Optional — null when
 *                       the bucket has no structured detail.
 */
export const viewpointRenders = pgTable(
  "viewpoint_renders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references((): AnyPgColumn => engagements.id, { onDelete: "cascade" }),
    /**
     * The parcel briefing the render was generated against. NULL if
     * the briefing was deleted post-render (FK is `set null` so the
     * render row survives as a historical artifact).
     */
    briefingId: uuid("briefing_id").references(
      (): AnyPgColumn => parcelBriefings.id,
      { onDelete: "set null" },
    ),
    /**
     * Snapshot of `parcel_briefing.latestEvent.id` at trigger time.
     * Compared to the briefing's current latestEvent at read time to
     * compute freshness; the briefingId pointer alone cannot
     * distinguish "render is current" from "briefing has been
     * regenerated since render was triggered" because the briefing's
     * row id stays stable across regenerations.
     */
    briefingAtomEventId: text("briefing_atom_event_id"),
    /**
     * The bim-model the render was generated against. NULL if the
     * bim-model row was deleted post-render. Same `set null` rationale
     * as `briefing_id`.
     */
    bimModelId: uuid("bim_model_id").references(
      (): AnyPgColumn => bimModels.id,
      { onDelete: "set null" },
    ),
    /**
     * Snapshot of `bim_model.latestEvent.id` at trigger time. Same
     * freshness-verdict purpose as `briefing_atom_event_id`.
     */
    bimModelAtomEventId: text("bim_model_atom_event_id"),
    /**
     * `still` | `elevation-set` | `video` per the Spec 54 v2 §6.2
     * domain vocabulary. Stored as text to match the project's
     * conversion-status convention; the route narrows it to a closed
     * union before inserting.
     */
    kind: text("kind").notNull(),
    /**
     * Validated, normalized request inputs. Image bytes never go in
     * the DB — the captured viewport image is uploaded to object
     * storage by the route's image-capture pipeline and the storage
     * key is stored here alongside `prompt`, `expert_name`,
     * `render_style`, the camera params, etc. Storing the full
     * payload lets the runs-list endpoint reconstruct what was
     * requested without joining a half-dozen child tables.
     */
    requestPayload: jsonb("request_payload").notNull(),
    /**
     * `queued` | `rendering` | `ready` | `failed` | `cancelled`.
     * Mirrors the codebase-internal RenderStatus union; the route
     * narrows on every transition.
     */
    status: text("status").notNull(),
    /**
     * The single mnml render id for `still` and `video` kinds.
     * NULL for `elevation-set` — those track 4 ids in `mnml_jobs`.
     * Stamped on the same transaction that flips status to `queued`
     * (post-trigger).
     */
    mnmlJobId: text("mnml_job_id"),
    /**
     * Per-direction job-tracking JSONB for `elevation-set` only.
     * Shape:
     *   [
     *     { role: "elevation-n", mnmlJobId: "rnd-1", status: "queued",
     *       cameraDirection: "back",
     *       error?: { code, message, details? } },
     *     ...
     *   ]
     * NULL for `still` / `video`. Updated per-direction by the polling
     * worker as each child mnml call resolves.
     */
    mnmlJobs: jsonb("mnml_jobs"),
    /**
     * Coarse error bucket for the failed branch. Examples:
     *   - `validation`            (mnml rejected request)
     *   - `insufficient_credits`  (mnml NO_CREDITS / 403 family)
     *   - `rate_limited`          (mnml 429)
     *   - `unavailable`           (mnml 5xx / transport)
     *   - `capture_failed`        (puppeteer-side image-capture failure)
     *   - `elevation_set_partial` (any-child-fail rollup; partial
     *                              successes mirrored, parent marked
     *                              failed; details lists failed_directions)
     */
    errorCode: text("error_code"),
    /** Human-readable error blurb. NULL while pending or on success. */
    errorMessage: text("error_message"),
    /**
     * Structured error payload — e.g. `{ failed_directions: ["n", "s"] }`
     * for `elevation_set_partial`, or `{ required_credits,
     * available_credits }` for `insufficient_credits`. NULL when the
     * bucket has no structured detail.
     */
    errorDetails: jsonb("error_details"),
    /**
     * The actor that triggered the render. Mirrors the
     * `parcel_briefings.generated_by` convention — opaque text id
     * (e.g. `user:<uuid>`, `agent:<id>`, `system:renders`).
     */
    requestedBy: text("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Set on the terminal transition (ready / failed / cancelled).
     * NULL while the render is still queued or rendering. Distinct
     * from `updated_at` so the runs-list query can sort by
     * completion-time without picking up housekeeping writes that
     * bump `updated_at`.
     */
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    /**
     * The list endpoint (`GET /api/engagements/:id/renders`) wants
     * "newest renders for this engagement first". This composite
     * index serves both the engagement-scoped filter and the order-by.
     */
    engagementCreatedIdx: index("viewpoint_renders_engagement_created_idx").on(
      t.engagementId,
      t.createdAt,
    ),
    /**
     * The renders sweep (parallel to `briefingGenerationJobsSweep`)
     * looks up old terminal `failed` / `cancelled` rows. A status-
     * indexed scan is cheaper than a full-table scan as the table
     * grows.
     */
    statusIdx: index("viewpoint_renders_status_idx").on(t.status),
  }),
);

export const viewpointRendersRelations = relations(
  viewpointRenders,
  ({ one, many }) => ({
    engagement: one(engagements, {
      fields: [viewpointRenders.engagementId],
      references: [engagements.id],
    }),
    briefing: one(parcelBriefings, {
      fields: [viewpointRenders.briefingId],
      references: [parcelBriefings.id],
    }),
    bimModel: one(bimModels, {
      fields: [viewpointRenders.bimModelId],
      references: [bimModels.id],
    }),
    /**
     * Wired in `renderOutputs.ts`'s relations block — child outputs
     * cascade-delete with the parent.
     */
    outputs: many(renderOutputs),
  }),
);

export type ViewpointRender = typeof viewpointRenders.$inferSelect;
export type NewViewpointRender = typeof viewpointRenders.$inferInsert;
