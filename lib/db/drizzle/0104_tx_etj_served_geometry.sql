-- P-359: an ETJ ring that swallows its own city is a drawing convention, not an answer.
--
-- P-332 measured (validated run, 2026-09-18) that 77,459 of 611,116 in-city parcels
-- in the six Phase 0 counties read incorporated PLUS ETJ-present, and that 74,785 of
-- them sit in a ring from one of three single-polygon publishers (georgetown-tx:9644,
-- leander-tx:1, dripping-springs-tx:1) whose published ETJ polygon CONTAINS the city
-- it belongs to. An ETJ is by definition OUTSIDE city limits, so those three publishers
-- drew one shape for "city plus ETJ"; the serve path reads it as a blanket `present`
-- for the city's own parcels. Separately, 24 of the 355 rings fail ST_IsValid, and
-- ST_Contains against an invalid polygon is undefined in GEOS.
--
-- THE SHAPE OF THIS FIX, and why these columns look the way they do:
--
--   * `geometry` stays the PUBLISHER'S GEOMETRY, VERBATIM. Nothing derived ever
--     overwrites the source. Acquisition and interpretation are different acts.
--   * `served_geometry` is what the reader may run containment against: the ring
--     minus its own city's limits for a self-containing ring, the repaired polygon
--     for an invalid one, NULL when the publisher's geometry is served unchanged.
--   * `served_status` is the reader's contract, and it DEFAULTS TO 'underived'.
--     That default is load-bearing: a ring that reaches this table without passing
--     the derivation pass is REFUSED by the reader and declared, rather than being
--     silently served as if it had been proven safe. Fail closed, not fail open.
--       verbatim    ST_IsValid true and the ring does not contain its own city;
--                   `geometry` is served unchanged.
--       derived     the ring contains its own city; `served_geometry` is the ring
--                   minus that city's limits.
--       repaired    ST_IsValid was false and ST_MakeValid moved the area inside the
--                   declared tolerance; `served_geometry` is the repaired polygon.
--       excluded    ST_IsValid was false and the repair moved more area than the
--                   tolerance allows; NOTHING is served, and `derivation` says why.
--       withheld    the ring contains its own city but the subtraction produced no
--                   usable polygon; NOTHING is served, and `derivation` says why.
--       underived   no derivation pass has run for this row. NOT served.
--   * `derivation` carries the record: what was subtracted and which city boundary
--     and vintage it came from, ST_IsValidReason, validity after repair, and the
--     areas before and after. A repair or a subtraction without its record is a
--     silent transformation, which is the defect class this program hunts.
--
-- The derivation itself is ONE implementation, in
-- `lib/cad-ingest/src/boundary/etjDerive.ts`, run by the ETJ ingest for exactly the
-- publishers it is (re-)acquiring. It is deliberately NOT duplicated here as a
-- backfill: two implementations of one rule is the CTRL-1 shape (DEV-PROCESS 2.4).
-- Consequence, stated because it is a real ordering constraint rather than a detail:
-- until the affected publishers are re-ingested, every existing ETJ ring reads
-- `underived` and the serve path answers `unresolved` with that reason. That is the
-- honest answer — the rings have not been checked — and it is why this row's
-- re-ingest and P-336's apply have to be ordered, named in the lane's close.

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE "tx_etj_boundary"
  ADD COLUMN IF NOT EXISTS "served_geometry" jsonb,
  ADD COLUMN IF NOT EXISTS "served_status" text NOT NULL DEFAULT 'underived',
  ADD COLUMN IF NOT EXISTS "derivation" jsonb,
  ADD COLUMN IF NOT EXISTS "area_published" double precision,
  ADD COLUMN IF NOT EXISTS "area_served" double precision,
  ADD COLUMN IF NOT EXISTS "derived_at" timestamp with time zone;

-- The reader narrows to served rows; keep that cheap to ask.
CREATE INDEX IF NOT EXISTS "tx_etj_boundary_served_status_idx"
  ON "tx_etj_boundary" ("served_status");
