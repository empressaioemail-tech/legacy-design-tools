-- OPS-9 S1 onboarding ledger (feat/onboarding-ledger-ingest).
--
-- Three tables backing the pinned POST /api/onboarding-ledger/ingest
-- contract, written by hauska-engine's preflight-and-report.mjs /
-- cert-grade-and-report.mjs wrappers and read by the additive
-- GET /api/county-ledger extension (countyLedger.ts) for the Command
-- Center County Ledger panel.
--
-- onboarding_ledger_event   one row per finding: a pre-flight rail decline,
--                            a block13-quarantine parcel, or a future
--                            warden-sweep finding. Idempotent re-ingest:
--                            a partial unique index on the OPEN natural key
--                            (row_id, parcel_node_id, defect_class,
--                            rail_or_check, check_id) means re-running the
--                            same preflight/cert-grade pass bumps
--                            last_seen_at on the existing open row instead
--                            of inserting a duplicate.
--
-- jurisdiction_registry_row_mirror   a read-side mirror of hauska-engine's
--                            frozen JurisdictionRegistryRow (engine stays
--                            the source of truth); upserted from the
--                            ingest contract's rowMirror payload.
--
-- county_gate_cert_state    per-row OPS-8 pre-flight gate + cert-grade
--                            state; upserted from the ingest contract's
--                            gateSummary / certSummary payloads.

CREATE TABLE IF NOT EXISTS onboarding_ledger_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts               timestamptz NOT NULL,
  fips             text NOT NULL,
  row_id           text NOT NULL,
  parcel_node_id   text,
  source_kind      text NOT NULL,
  rail_or_check    text,
  check_id         text,
  sweep_id         text,
  decline_reason   text,
  defect_class     text NOT NULL,
  severity         text,
  evidence         jsonb,
  artifact_ref     text,
  status           text NOT NULL DEFAULT 'open',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  CONSTRAINT onboarding_ledger_event_source_kind_check
    CHECK (source_kind IN ('preflight', 'cert-grade', 'block13-quarantine', 'warden-sweep')),
  CONSTRAINT onboarding_ledger_event_status_check
    CHECK (status IN ('open', 'resolved'))
);

CREATE INDEX IF NOT EXISTS onboarding_ledger_event_row_idx
  ON onboarding_ledger_event (row_id);
CREATE INDEX IF NOT EXISTS onboarding_ledger_event_fips_idx
  ON onboarding_ledger_event (fips);
CREATE INDEX IF NOT EXISTS onboarding_ledger_event_defect_class_idx
  ON onboarding_ledger_event (defect_class);
CREATE INDEX IF NOT EXISTS onboarding_ledger_event_status_idx
  ON onboarding_ledger_event (status);

-- Idempotent-re-ingest dedupe key: at most one OPEN finding per
-- (row, parcel, defect class, rail/check). Partial (status='open') so a
-- resolved finding that recurs opens a fresh row (a regression signal),
-- rather than silently resurrecting the closed one.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_ledger_event_open_natural_key_idx
  ON onboarding_ledger_event (row_id, parcel_node_id, defect_class, rail_or_check, check_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS jurisdiction_registry_row_mirror (
  row_id         text PRIMARY KEY,
  fips           text NOT NULL,
  county_name    text NOT NULL,
  status         text NOT NULL,
  zoning_regime  text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS county_gate_cert_state (
  row_id                    text PRIMARY KEY,
  fips                      text NOT NULL,
  gate_pass_count           integer,
  gate_decline_count        integer,
  gate_checks               jsonb,
  cert_label                text,
  cert_block_pass           boolean,
  cert_scope_annotations    jsonb,
  cert_graded_at            timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);
