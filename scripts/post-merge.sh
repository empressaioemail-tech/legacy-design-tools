#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force
# Task #281 — stamp the producing job id onto every legacy
# `parcel_briefings` row whose `generated_at` is non-null but whose
# new `generation_id` column is. Idempotent (only acts on rows where
# `generation_id IS NULL`), so re-runs after the initial deploy are
# no-ops. Rows whose producing job has already aged out of the
# briefing-generation-jobs sweep window stay NULL on purpose — the UI
# surfaces that as "no producing run on file" rather than mislabelling
# an unrelated later run as "Current".
pnpm --filter @workspace/scripts run backfill:briefing-generation-ids
# Task #324 — copy the producing job's `completed_at` into
# `parcel_briefings.prior_generated_at` for legacy briefings whose
# `prior_generated_by` is set but whose timestamp is null. Lets the
# recent-runs panel render the full "Generated … by …" meta line on
# legacy regenerations via the existing interval matcher (no UI
# changes required). Idempotent: only acts on rows where
# `prior_generated_at IS NULL AND prior_generated_by IS NOT NULL`,
# so re-runs after the initial deploy are no-ops. Rows whose prior
# producing job has aged out of the briefing-generation-jobs sweep
# window stay NULL on purpose — the UI keeps the legacy "by …" only
# rendering rather than synthesising a fictitious timestamp.
pnpm --filter @workspace/scripts run backfill:prior-generated-at
