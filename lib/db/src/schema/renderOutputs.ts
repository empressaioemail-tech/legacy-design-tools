import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { viewpointRenders } from "./viewpointRenders";

/**
 * A *render output* (Spec 54 v2 §6.3 / V1-4 DA-RP-1) is one finished
 * file produced by a `viewpoint_render`. Decoupled from the parent
 * row so an `elevation-set`'s four images can each be addressed
 * individually, and so video frames or alternate resolutions can be
 * added later without changing the parent atom.
 *
 * Identity: render-scoped + role-unique. The `(viewpoint_render_id,
 * role)` composite uniqueness invariant guarantees we never end up
 * with two `elevation-n` outputs on the same parent — useful as a
 * defensive guard against double-mirror-on-retry.
 *
 * Role taxonomy (mirrors {@link RenderOutputRole} in
 * `@workspace/mnml-client`):
 *
 *   - `primary`         — the single output of a `still` parent
 *   - `elevation-n/e/s/w` — the four cardinal outputs of an
 *                          `elevation-set` parent. The route's fan-out
 *                          assigns the role based on which
 *                          `camera_direction` (front/right/back/left)
 *                          produced each child mnml call's output.
 *   - `video-primary`   — the mp4 output of a `video` parent
 *   - `video-thumbnail` — server-synthesized via ffmpeg first-frame
 *                          extraction post-`ready`. mnml does not
 *                          return a thumbnail — Spec 54 v2 §6.2 / §6.5.
 *
 * URL persistence (Spec 54 v2 §6.3): mnml's response URLs (the
 * `message[]` array from `GET /v1/status/{id}` on success) expire,
 * sometimes within minutes. The route's poll handler fetches each
 * URL and uploads to our object storage with a deterministic key
 * (`renders/<viewpointRenderId>/<role>.<ext>`); both the (ephemeral)
 * `source_url` and the (durable) `mirrored_object_key` are persisted.
 * If the mirror step fails, the parent row stays in `rendering` and
 * the next poll retries; we never write a render-output row whose
 * `mirrored_object_key` is missing for a reachable URL.
 *
 * Format / size / duration metadata is best-effort. `format` is
 * derived from the URL extension (or content-type) at mirror time;
 * `size_bytes` is the byte-count from the upload; `duration_seconds`
 * is set for videos via ffprobe alongside the thumbnail extraction.
 */
export const renderOutputs = pgTable(
  "render_outputs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    viewpointRenderId: uuid("viewpoint_render_id")
      .notNull()
      .references((): AnyPgColumn => viewpointRenders.id, {
        onDelete: "cascade",
      }),
    /**
     * One of the role taxonomy values above. Stored as text to match
     * the project's enum-as-text convention; the route narrows.
     */
    role: text("role").notNull(),
    /** `png` | `jpg` | `mp4` | `webm`. Derived from URL/content-type at mirror time. */
    format: text("format").notNull(),
    /** e.g. `1344x896` for stills, `1920x1080` for video. NULL until known. */
    resolution: text("resolution"),
    /** Byte-count from the mirror upload. NULL until mirror completes. */
    sizeBytes: integer("size_bytes"),
    /** Video only — populated via ffprobe. NULL for stills. */
    durationSeconds: integer("duration_seconds"),
    /**
     * mnml's CDN URL for the asset (`api.mnmlai.dev/v1/images/...`).
     * Documented as expiring; we keep it for support / debugging
     * (e.g. mnml support can confirm the rendered output by id) but
     * never serve it back to the FE.
     */
    sourceUrl: text("source_url").notNull(),
    /**
     * The object-storage key under our bucket — the durable address.
     * Shape: `renders/<viewpointRenderId>/<role>.<ext>`. NULL during
     * the (brief) window between row insert and mirror completion;
     * the route writes both fields in the same status-poll handler so
     * a NULL here on a `ready` parent is an error condition the sweep
     * surfaces.
     */
    mirroredObjectKey: text("mirrored_object_key"),
    /** mnml-side output id, when present in the response. Useful for support tracking. */
    mnmlOutputId: text("mnml_output_id"),
    /**
     * Inline preview URL for video-primary rows (legacy compatibility
     * with `RenderOutput.thumbnailUrl` from older client shapes).
     * Today populated only by the ffmpeg-thumbnail synthesis step;
     * the standalone `video-thumbnail` row is the canonical place
     * to look. NULL for stills and elevations.
     */
    thumbnailUrl: text("thumbnail_url"),
    /** mnml's seed value, useful for reproducibility / "render the same again" affordances. */
    seed: integer("seed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * Most reads are "load all outputs for this render" (the gallery
     * panel, the contextSummary's child resolveComposition). The
     * unique index below covers parent-id lookups too, but listing
     * this explicitly keeps the index intent obvious.
     */
    viewpointRenderIdx: index("render_outputs_viewpoint_render_idx").on(
      t.viewpointRenderId,
    ),
    /**
     * One row per (parent, role). Defensive against double-mirror on
     * a retried poll: a UNIQUE collision short-circuits the second
     * insert with a clear constraint name rather than silently
     * producing a duplicate elevation-n row.
     */
    uniquePerRole: uniqueIndex("render_outputs_render_role_uniq").on(
      t.viewpointRenderId,
      t.role,
    ),
  }),
);

export const renderOutputsRelations = relations(renderOutputs, ({ one }) => ({
  viewpointRender: one(viewpointRenders, {
    fields: [renderOutputs.viewpointRenderId],
    references: [viewpointRenders.id],
  }),
}));

export type RenderOutput = typeof renderOutputs.$inferSelect;
export type NewRenderOutput = typeof renderOutputs.$inferInsert;
