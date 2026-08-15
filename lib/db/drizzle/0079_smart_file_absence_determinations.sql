-- Typed absence for Smart Files (OPS-17 PLAN-ROW G-34).
--
-- Adds the ABSENCE DETERMINATION table: the record that we LOOKED for a
-- document and what we concluded. Depends on 0078 (the Smart Files foundation),
-- and is therefore behind the same operator HOLD: NEITHER 0078 NOR THIS FILE
-- HAS BEEN APPLIED TO ANY DEPLOYMENT DATABASE.
--
-- WHY A TABLE RATHER THAN A COMPUTED VERDICT. The inherited spine constraint is
-- that ONLY A POSITIVE DETERMINATION WRITES AN ABSENCE: an empty or failed
-- lookup re-enters the queue and does not become a recorded absence. That rule
-- is unenforceable if the read path can synthesize "absent" from a zero-row
-- query, because then every never-attempted lookup silently becomes a verified
-- absence. So the verdict lives in a row something DELIBERATELY WROTE, and a
-- read with no row here reports `not-sought` instead. Absence is a FINDING, not
-- the failure to find.
--
-- WHY THE BASIS IS NOT NULL AND CHECK-CONSTRAINED. "Not found" is not a basis;
-- WHY it is not found is. An absence without its citation is unfalsifiable. The
-- constraint lives at the DATABASE so a caller writing raw SQL, a future lane,
-- or a script that bypasses the application layer still cannot record an
-- uncited absence — a guardrail that does not survive a clone is not a
-- guardrail. This mirrors `county_facet_coverage.absence_basis`, which is
-- required by check constraint whenever `rail_state = 'satisfied-absent'` for
-- exactly this reason. The pattern is REUSED, not reinvented; that table itself
-- is keyed (county, rail) and has no document axis.
--
-- WHY `determined_at` IS SEPARATE FROM `created_at`. A verified absence DECAYS
-- exactly like a verified presence: "we checked in 2019 and Bastrop had no
-- short-term-rental ordinance" is not evidence about today. `determined_at` is
-- the absence path's `computed_at` and feeds the SAME freshness evaluator the
-- present path uses, so one proven-in-both-directions indicator covers both
-- paths rather than two indicators drifting apart. A re-determination UPDATEs
-- the row and moves `determined_at` forward, so the stamp reflects the LATEST
-- looking rather than the first.
--
-- NO FOREIGN KEY to `smart_file_documents` is deliberate. A determination is
-- about an entityId for which, in the absent case, no document row exists by
-- definition; an FK would make the common case unrepresentable.

CREATE TABLE IF NOT EXISTS "smart_file_absence_determinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The DECLARED entityId (`smartfile:<jurisdictionFips>:<docSlug>`), stored
  -- exactly as the builder produced it. Never reconstructed by a reader: a
  -- reconstructed shape matches zero rows and then reads as an honest absence,
  -- which is the precise failure this family exists to prevent.
  "entity_id" text NOT NULL,
  "jurisdiction_fips" text NOT NULL,
  "doc_slug" text NOT NULL,
  -- Exactly two recordable verdicts:
  --   `absent-verified` — we looked, it is genuinely not there. A real answer.
  --   `lookup-failed`   — the ATTEMPT failed. We know nothing about existence.
  -- Collapsing these is how a probe failure wears the costume of a data gap.
  -- `not-sought` is deliberately NOT a value: never having looked is the
  -- ABSENCE of a row here, and a row saying "we did nothing" would make the
  -- table lie about what a determination is.
  "verdict" text NOT NULL,
  -- WHY. Required, non-empty, enforced below.
  "basis" text NOT NULL,
  -- WHEN the determination was made. The absence path's `computed_at`.
  "determined_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- WHAT did the determining, so a determination is attributable and
  -- re-verifiable. Mirrors the spine's `verified_by_instrument`.
  "determined_by" text NOT NULL,
  -- The source consulted, when there is a URL. NULL is a POSITIVE "no single
  -- source URL" (e.g. a phone call to a clerk), not "unknown".
  "source_uri" text,
  -- ADR-017 five-value union, resolved at READ time. Present as a COLUMN;
  -- per-tenant ENFORCEMENT stays gated on G-11 / S-1 and is not claimed here.
  "access_policy" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "smart_file_absence_determinations_verdict_check"
    CHECK ("verdict" IN ('absent-verified', 'lookup-failed')),
  -- THE BASIS RULE, ENFORCED BY THE ENGINE. A blank or whitespace-only basis is
  -- rejected, so no caller, script, or future lane can record an uncited
  -- absence. This is what makes "an absence carries its basis" a mechanism
  -- rather than a convention.
  CONSTRAINT "smart_file_absence_determinations_basis_check"
    CHECK (length(btrim("basis")) > 0),
  CONSTRAINT "smart_file_absence_determinations_determined_by_check"
    CHECK (length(btrim("determined_by")) > 0),
  CONSTRAINT "smart_file_absence_determinations_access_policy_check"
    CHECK ("access_policy" IN ('public-free', 'public-paid', 'platform-internal', 'tenant-private', 'tenant-shared'))
);

-- One CURRENT determination per entityId. A re-determination UPDATEs this row
-- rather than appending, so a read never has to pick among competing verdicts.
CREATE UNIQUE INDEX IF NOT EXISTS "smart_file_absence_determinations_entity_id_uniq"
  ON "smart_file_absence_determinations" ("entity_id");
CREATE INDEX IF NOT EXISTS "smart_file_absence_determinations_jurisdiction_idx"
  ON "smart_file_absence_determinations" ("jurisdiction_fips", "doc_slug");
-- The corpus question this table will be asked by G-20: how many verified
-- absences vs failed lookups does a jurisdiction carry.
CREATE INDEX IF NOT EXISTS "smart_file_absence_determinations_verdict_idx"
  ON "smart_file_absence_determinations" ("verdict");
