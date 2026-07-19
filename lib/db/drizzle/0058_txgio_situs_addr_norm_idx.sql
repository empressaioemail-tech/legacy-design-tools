-- Functional indexes backing the F4d authoritative address->parcel
-- resolver (situs short-circuit + txgio_address rooftop lookup).
--
-- The resolver matches a normalized street line against a NORMALIZED
-- form of the stored situs_address / full_addr column (comma-split,
-- uppercased, punctuation-stripped, whitespace-collapsed, and
-- street-type/directional canonicalized to USPS abbreviations — e.g.
-- stored "144 THOMAS PLACE" -> "144 THOMAS PL"). Without these indexes
-- each Hays/Comal address request runs an unindexed sequential scan that
-- evaluates that whole regexp chain per row on the critical path. Measured
-- on live prod data (txgio_parcel 246k rows, txgio_address 979k rows):
--   situs   query  ~37,800ms  (Seq Scan) -> 0.30ms  (Index Scan)
--   rooftop query  ~38,700ms  (Seq Scan) -> 0.17ms  (Index Scan)
-- (EXPLAIN ANALYZE, PR #295.) These functional indexes on
-- (county_fips, <normalized expression>) make the equality lookup an
-- index scan.
--
-- CRITICAL: the index expression MUST be byte-identical to the query
-- expression or Postgres won't use it. BOTH are generated from the SAME
-- source of truth: buildNormalizedStreetSql() in
-- artifacts/api-server/src/lib/txgioAddressNormalize.ts. If that function
-- changes, regenerate this migration (a new file) so the index tracks it.
-- Every function in the expression (split_part, upper, trim,
-- regexp_replace) is IMMUTABLE, so the expression is index-valid.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the prod migration runner wraps
-- each file in a single transaction, and CREATE INDEX CONCURRENTLY cannot
-- run in one. IF NOT EXISTS keeps re-runs idempotent.
--
-- BUILD TIME / TIMEOUT SAFETY: building these functional indexes computes
-- the regexp chain over every row, so the build is slow — measured ~1min
-- (parcel) + ~4m47s (address) on prod, ~6min combined in one transaction.
-- `CREATE INDEX` is ACTIVE work, so the role's
-- idle_in_transaction_session_timeout (5min on this DB) does NOT fire
-- during it (that timeout only kills a txn sitting IDLE between
-- statements). `statement_timeout` IS 0 (unlimited) on the deploy role,
-- but we set it to 0 defensively below so a future non-zero default can't
-- kill the build mid-way. Both index builds take an ACCESS EXCLUSIVE lock
-- on their table for the build duration; these are ingest-only tables
-- (no live writers on the request path), so the lock only blocks a
-- concurrent ingest, which is acceptable during a deploy window.

-- Do not let a (future) non-zero statement_timeout kill the long build.
-- Plain SET (not SET LOCAL) so it applies whether this file is run inside
-- the prod runner's BEGIN/COMMIT transaction or standalone in autocommit;
-- the migration connection is one-shot, so a session-scoped SET is fine.
SET statement_timeout = 0;

CREATE INDEX IF NOT EXISTS "txgio_parcel_situs_norm_idx"
  ON "txgio_parcel" ("county_fips", (trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(trim(regexp_replace(regexp_replace(upper(split_part(situs_address, ',', 1)), '[.]', '', 'g'), '\s+', ' ', 'g')), '\mNORTH\M', 'N', 'g'), '\mSOUTH\M', 'S', 'g'), '\mEAST\M', 'E', 'g'), '\mWEST\M', 'W', 'g'), '\mNORTHEAST\M', 'NE', 'g'), '\mNORTHWEST\M', 'NW', 'g'), '\mSOUTHEAST\M', 'SE', 'g'), '\mSOUTHWEST\M', 'SW', 'g'), '\mALLEY\M', 'ALY', 'g'), '\mAVENUE\M', 'AVE', 'g'), '\mAV\M', 'AVE', 'g'), '\mBOULEVARD\M', 'BLVD', 'g'), '\mBEND\M', 'BND', 'g'), '\mCIRCLE\M', 'CIR', 'g'), '\mCOURT\M', 'CT', 'g'), '\mCOVE\M', 'CV', 'g'), '\mCROSSING\M', 'XING', 'g'), '\mDRIVE\M', 'DR', 'g'), '\mEXPRESSWAY\M', 'EXPY', 'g'), '\mHIGHWAY\M', 'HWY', 'g'), '\mHOLLOW\M', 'HOLW', 'g'), '\mLANE\M', 'LN', 'g'), '\mPARKWAY\M', 'PKWY', 'g'), '\mPLACE\M', 'PL', 'g'), '\mPLAZA\M', 'PLZ', 'g'), '\mPOINT\M', 'PT', 'g'), '\mRIDGE\M', 'RDG', 'g'), '\mROAD\M', 'RD', 'g'), '\mSQUARE\M', 'SQ', 'g'), '\mSTREET\M', 'ST', 'g'), '\mTERRACE\M', 'TER', 'g'), '\mTRACE\M', 'TRCE', 'g'), '\mTRAIL\M', 'TRL', 'g'), '\mTURNPIKE\M', 'TPKE', 'g'))));

CREATE INDEX IF NOT EXISTS "txgio_address_fulladdr_norm_idx"
  ON "txgio_address" ("county_fips", (trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(trim(regexp_replace(regexp_replace(upper(split_part(full_addr, ',', 1)), '[.]', '', 'g'), '\s+', ' ', 'g')), '\mNORTH\M', 'N', 'g'), '\mSOUTH\M', 'S', 'g'), '\mEAST\M', 'E', 'g'), '\mWEST\M', 'W', 'g'), '\mNORTHEAST\M', 'NE', 'g'), '\mNORTHWEST\M', 'NW', 'g'), '\mSOUTHEAST\M', 'SE', 'g'), '\mSOUTHWEST\M', 'SW', 'g'), '\mALLEY\M', 'ALY', 'g'), '\mAVENUE\M', 'AVE', 'g'), '\mAV\M', 'AVE', 'g'), '\mBOULEVARD\M', 'BLVD', 'g'), '\mBEND\M', 'BND', 'g'), '\mCIRCLE\M', 'CIR', 'g'), '\mCOURT\M', 'CT', 'g'), '\mCOVE\M', 'CV', 'g'), '\mCROSSING\M', 'XING', 'g'), '\mDRIVE\M', 'DR', 'g'), '\mEXPRESSWAY\M', 'EXPY', 'g'), '\mHIGHWAY\M', 'HWY', 'g'), '\mHOLLOW\M', 'HOLW', 'g'), '\mLANE\M', 'LN', 'g'), '\mPARKWAY\M', 'PKWY', 'g'), '\mPLACE\M', 'PL', 'g'), '\mPLAZA\M', 'PLZ', 'g'), '\mPOINT\M', 'PT', 'g'), '\mRIDGE\M', 'RDG', 'g'), '\mROAD\M', 'RD', 'g'), '\mSQUARE\M', 'SQ', 'g'), '\mSTREET\M', 'ST', 'g'), '\mTERRACE\M', 'TER', 'g'), '\mTRACE\M', 'TRCE', 'g'), '\mTRAIL\M', 'TRL', 'g'), '\mTURNPIKE\M', 'TPKE', 'g'))));
