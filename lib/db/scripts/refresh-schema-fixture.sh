#!/usr/bin/env bash
#
# Re-capture lib/db/src/__tests__/__fixtures__/schema.sql.template from the
# live database. Run this after any drizzle-kit push that changes the schema
# (new tables/columns/indexes/FKs) — otherwise the lib/db integration tests
# will replay the old DDL and silently miss new columns.
#
# How it works:
#   1. pg_dump the public schema, schema-only, no owners/ACLs/comments.
#   2. Strip the leading SET / SELECT preamble lines that pg_dump emits;
#      they reference roles and search_path and would just add noise.
#   3. Rewrite every `public.` qualifier to the @@SCHEMA@@ sentinel so the
#      test harness can sed it to the per-test schema name at run time.
#   4. Restore `public.vector(...)` — the pgvector extension's `vector`
#      type lives in the public schema and must NOT be re-qualified.
#
# Usage:
#   pnpm --filter @workspace/db run test:fixture:schema
# or:
#   ./lib/db/scripts/refresh-schema-fixture.sh
#
# Required env: DATABASE_URL pointing at a database that has the latest
# schema applied (typically your dev DB after a `pnpm --filter @workspace/db
# run push`).

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL must be set" >&2
  exit 1
fi

# Resolve the fixture path relative to this script so it works whether the
# script is invoked from the project root, from lib/db (via pnpm), or from
# anywhere else.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/../src/__tests__/__fixtures__/schema.sql.template"

# pg_dump emits the SET search_path / SELECT pg_catalog.set_config preamble
# we don't want, plus the schema CREATE itself (we provide our own). We
# filter those lines out and rewrite qualifiers.
pg_dump \
  "$DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-acl \
  --no-comments \
  --schema=public \
  | grep -vE '^(SET |SELECT pg_catalog\.set_config|CREATE SCHEMA |\\restrict |\\unrestrict |--$|-- (PostgreSQL|Dumped))' \
  | sed -E 's/\bpublic\./@@SCHEMA@@./g; s/@@SCHEMA@@\.vector\(/public.vector(/g' \
  > "$OUT.tmp"

mv "$OUT.tmp" "$OUT"
echo "Wrote $OUT ($(wc -l < "$OUT") lines)"
