#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Task #281 — stamp the producing job id onto every legacy
# `parcel_briefings` row whose `generated_at` is non-null but whose
# new `generation_id` column is. Idempotent (only acts on rows where
# `generation_id IS NULL`), so re-runs after the initial deploy are
# no-ops. Rows whose producing job has already aged out of the
# briefing-generation-jobs sweep window stay NULL on purpose — the UI
# surfaces that as "no producing run on file" rather than mislabelling
# an unrelated later run as "Current".
pnpm --filter @workspace/scripts run backfill:briefing-generation-ids
