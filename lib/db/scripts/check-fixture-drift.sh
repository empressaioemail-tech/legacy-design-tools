#!/usr/bin/env bash
#
# Verify that lib/db/src/__tests__/__fixtures__/schema.sql.template is in
# sync with the live database. Runs the same pg_dump+sed pipeline as
# refresh-schema-fixture.sh and diffs the result against the committed
# fixture instead of overwriting it.
#
# Exit codes:
#   0 — fixture matches the live DB (or DATABASE_URL unset → skip).
#   1 — drift detected (or pg_dump failed).
#
# Intent: pair this with the integration test that invokes it so a schema
# change without a corresponding fixture refresh fails CI.

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL not set — skipping fixture drift check" >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMITTED="$SCRIPT_DIR/../src/__tests__/__fixtures__/schema.sql.template"

if [[ ! -f "$COMMITTED" ]]; then
  echo "Committed fixture not found at $COMMITTED" >&2
  exit 1
fi

# Same pipeline as refresh-schema-fixture.sh — kept inline (rather than
# sourcing the other script) so the two stay obviously parallel and a
# divergence is loud.
LIVE="$(mktemp)"
trap 'rm -f "$LIVE"' EXIT

pg_dump \
  "$DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-acl \
  --no-comments \
  --schema=public \
  | grep -vE '^(SET |SELECT pg_catalog\.set_config|CREATE SCHEMA |\\restrict |\\unrestrict |--$|-- (PostgreSQL|Dumped))' \
  | sed -E 's/\bpublic\./@@SCHEMA@@./g; s/@@SCHEMA@@\.vector\(/public.vector(/g' \
  > "$LIVE"

if ! diff -u "$COMMITTED" "$LIVE"; then
  echo "" >&2
  echo "Schema fixture drift detected." >&2
  echo "Run: pnpm --filter @workspace/db run test:fixture:schema" >&2
  echo "to refresh $COMMITTED, then commit the result." >&2
  exit 1
fi

echo "Schema fixture matches live DB."
