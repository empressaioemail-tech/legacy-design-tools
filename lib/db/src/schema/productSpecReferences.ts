import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * L5 — `product-spec-reference` atom persistence (Cortex Lane C.4 /
 * C.4.5).
 *
 * One row per ICC-ES-evaluated product reference, carrying the live
 * ICC-ES evaluation status. `status_history` is an append-only JSONB
 * chain of `{ status, changedAt, sourceUrl }` observations; the newest
 * entry's `status` mirrors the row's current `status`.
 *
 * `icc_es_url` is the ICC-ES listing URL the current status was
 * verified against — it maps to the atom's inherited
 * `BaseAtomInstance.sourceUrl` (L5 is the one L-surface atom that
 * carries a real source URL).
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L5. Atom shape: `PRODUCT_SPEC_REFERENCE_SCHEMA` in
 * `@workspace/atoms-l-surface`.
 */

export const PRODUCT_SPEC_STATUS_VALUES = [
  "active",
  "withdrawn",
  "expired",
] as const;
export type ProductSpecStatusValue =
  (typeof PRODUCT_SPEC_STATUS_VALUES)[number];

export const productSpecReferences = pgTable(
  "product_spec_references",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Structured product identity (`product.name`). */
    productName: text("product_name").notNull(),
    /** Structured product identity (`product.manufacturer`). */
    productManufacturer: text("product_manufacturer").notNull(),
    /** ICC-ES ESR number (format `ESR-<digits>`). */
    esrNumber: text("esr_number").notNull(),
    /** Current ICC-ES evaluation status. */
    status: text("status").notNull().default("active"),
    /** Timestamp the status was last verified by an ICC-ES poll. */
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Append-only `[{ status, changedAt, sourceUrl }]` chain. */
    statusHistory: jsonb("status_history")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** ICC-ES listing URL the current status was verified against. */
    iccEsUrl: text("icc_es_url").notNull().default(""),
    /** Source finding entityId. Null otherwise. */
    findingId: text("finding_id"),
    /** Source response-task entityId. Null otherwise. */
    responseTaskId: text("response_task_id"),
    /** Architect / staff member who added the product reference (ADR-015). */
    actorId: text("actor_id"),
    /** Actor accountable; may differ from `actorId` for delegation. */
    principalActorId: text("principal_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementCreatedIdx: index(
      "product_spec_references_engagement_created_idx",
    ).on(t.engagementId, t.createdAt),
    /**
     * Closed-set enforcement at the DB layer. Kept literal — keep in
     * lock-step with `PRODUCT_SPEC_STATUS_VALUES`.
     */
    statusCheck: check(
      "product_spec_references_status_check",
      sql`${t.status} IN ('active', 'withdrawn', 'expired')`,
    ),
  }),
);

export type ProductSpecReference =
  typeof productSpecReferences.$inferSelect;
export type NewProductSpecReference =
  typeof productSpecReferences.$inferInsert;
