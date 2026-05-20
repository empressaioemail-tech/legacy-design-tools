import {
  pgTable,
  uuid,
  text,
  customType,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deliverableLetters } from "./deliverableLetters";

/** Raw render bytes, stored inline (mirrors `sheets.full_png`). */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * L6 — `deliverable-letter-render` atom persistence (Cortex Lane C.4 /
 * C.4.6).
 *
 * One row per render of an L3 deliverable letter. The render output IS
 * a first-class atom (Sprint Amendment 6): queryable, provenance-pinned.
 * A letter is 1-to-many with its renders (format changes, re-renders).
 *
 * `render_bytes` stores the generated DOCX/PDF inline; `blob_ref` is
 * the opaque atom-level pointer (`db:deliverable-letter-render:<id>`).
 * The bytes are served by the `GET /deliverable-letter-renders/:id/file`
 * download route (a C.4.6 contract extension — see the route file).
 *
 * `source_letter_ref` is the `did:hauska:deliverable-letter:<id>` ref;
 * `source_letter_version` pins the source letter's `contentHash` at
 * render time.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L6. Atom shape: `DELIVERABLE_LETTER_RENDER_SCHEMA` in
 * `@workspace/atoms-l-surface`.
 */

export const RENDER_FORMAT_VALUES = ["docx", "pdf"] as const;
export type RenderFormatValue = (typeof RENDER_FORMAT_VALUES)[number];

export const deliverableLetterRenders = pgTable(
  "deliverable_letter_renders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Source letter (FK for the per-letter list query + cascade). */
    letterId: uuid("letter_id")
      .notNull()
      .references(() => deliverableLetters.id, { onDelete: "cascade" }),
    /** `did:hauska:deliverable-letter:<localId>` ref to the source letter. */
    sourceLetterRef: text("source_letter_ref").notNull(),
    /** The source letter's `contentHash` at render time. */
    sourceLetterVersion: text("source_letter_version").notNull(),
    /** Output format. */
    format: text("format").notNull(),
    /** Opaque atom-level pointer to the stored render bytes. */
    blobRef: text("blob_ref").notNull(),
    /** The generated DOCX/PDF bytes, stored inline. */
    renderBytes: bytea("render_bytes").notNull(),
    /** Actor who triggered the render (ADR-015). Null for system renders. */
    renderedByActorId: text("rendered_by_actor_id"),
    /** Timestamp the render was produced. */
    renderedAt: timestamp("rendered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    letterRenderedIdx: index("deliverable_letter_renders_letter_rendered_idx").on(
      t.letterId,
      t.renderedAt,
    ),
    /**
     * Closed-set enforcement at the DB layer. Kept literal — keep in
     * lock-step with `RENDER_FORMAT_VALUES`.
     */
    formatCheck: check(
      "deliverable_letter_renders_format_check",
      sql`${t.format} IN ('docx', 'pdf')`,
    ),
  }),
);

export type DeliverableLetterRender =
  typeof deliverableLetterRenders.$inferSelect;
export type NewDeliverableLetterRender =
  typeof deliverableLetterRenders.$inferInsert;
