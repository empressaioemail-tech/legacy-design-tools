/**
 * v2 reasoning/citation atoms — persisted grounding OUTSIDE the public code_atoms catalog.
 *
 * Stores structure, confidence, verification state, deeplink sources[], and a capped snippet
 * only. NO full-section verbatim text column (Hauska stores reasoning, not code text).
 */

import { pgTable, text, jsonb, timestamp, numeric, index } from "drizzle-orm/pg-core";

export const REASONING_VERIFICATION_STATES = [
  "verified",
  "unverified-web-source",
] as const;
export type ReasoningVerificationState =
  (typeof REASONING_VERIFICATION_STATES)[number];

export const REASONING_DISPLAY_MODES = ["deeplink", "licensed"] as const;
export type ReasoningDisplayMode = (typeof REASONING_DISPLAY_MODES)[number];

export interface ReasoningSourceLink {
  url: string;
  sourceName: string;
  edition: string;
  retrievedAt: string;
  verified: boolean;
}

export const reasoningAtoms = pgTable(
  "reasoning_atoms",
  {
    /** `reasoning:<edition-slug>:<section>` — distinct from corpus UUID ids. */
    id: text("id").primaryKey(),
    jurisdictionKey: text("jurisdiction_key").notNull(),
    codeRef: text("code_ref").notNull(),
    edition: text("edition").notNull(),
    editionSlug: text("edition_slug").notNull(),
    sources: jsonb("sources").$type<ReasoningSourceLink[]>().notNull().default([]),
    reasoning: text("reasoning"),
    confidence: numeric("confidence").notNull(),
    verificationState: text("verification_state").notNull(),
    /** Capped short quote only (<=600 chars enforced in application code). */
    snippet: text("snippet"),
    displayMode: text("display_mode").notNull().default("deeplink"),
    /** Arrow-two calibration seam — populated later, not in this dispatch. */
    calibratedConfidence: numeric("calibrated_confidence"),
    accessPolicy: text("access_policy").notNull().default("platform-internal"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    jurisdictionIdx: index("reasoning_atoms_jurisdiction_idx").on(t.jurisdictionKey),
  }),
);

export type ReasoningAtom = typeof reasoningAtoms.$inferSelect;
export type NewReasoningAtom = typeof reasoningAtoms.$inferInsert;
