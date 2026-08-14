-- L18 / P-14: materialized county-ledger GET payload (singleton).
-- GET /api/county-ledger serves this row in constant time. Writers refresh
-- it via countyLedgerMaterializeCli --apply after scoring. computed_at is
-- the freshness stamp; the route adds servedAt at read time.

CREATE TABLE IF NOT EXISTS county_ledger_snapshot (
  id           text PRIMARY KEY,
  computed_at  timestamptz NOT NULL,
  payload      jsonb NOT NULL,
  CONSTRAINT county_ledger_snapshot_id_check CHECK (id = 'current')
);
