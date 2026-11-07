-- G-309 item 5: DRY RUN (read-only). Lists reasoning_atoms rows sourced from iccsafe.org.
-- Do not run against production from the lane. The integration seat runs this on the operator's go.
-- Prints ids, counts and lengths ONLY - never snippet/reasoning content.
-- Connect with a read-only role / unpooled DSN with options=-c default_transaction_read_only=on.
-- Vacuous-zero check: (A) must be > 0 on a DB that has ever run codewarm; if reasoning_atoms total is 0
-- the wrong database was queried, and a zero here proves nothing.

BEGIN READ ONLY;

-- (A) sanity: total rows in table (a zero here means wrong database / empty table)
SELECT count(*) AS reasoning_atoms_total FROM reasoning_atoms;

-- (B) counts by how the row touches iccsafe.org
SELECT
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'url' ~* 'iccsafe')) AS rows_with_icc_source,
  count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'url' !~* 'iccsafe')
    AND jsonb_array_length(sources) > 0) AS rows_icc_only_sources,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'sourceName' = 'icc')) AS rows_with_icc_driver_name
FROM reasoning_atoms;

-- (C) per-row: id, jurisdiction, lengths and source counts. No content columns selected.
SELECT
  a.id,
  a.jurisdiction_key,
  a.code_ref,
  a.edition_slug,
  a.verification_state,
  length(a.snippet)   AS snippet_len,
  length(a.reasoning) AS reasoning_len,
  jsonb_array_length(a.sources) AS sources_total,
  (SELECT count(*) FROM jsonb_array_elements(a.sources) s WHERE s->>'url' ~* 'iccsafe') AS sources_icc,
  (SELECT count(*) FROM jsonb_array_elements(a.sources) s WHERE s->>'url' !~* 'iccsafe') AS sources_non_icc,
  a.created_at,
  a.updated_at
FROM reasoning_atoms a
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(a.sources) s WHERE s->>'url' ~* 'iccsafe')
ORDER BY a.id;

-- (D) per-jurisdiction rollup
SELECT jurisdiction_key,
       count(*) AS rows_with_icc_source,
       sum(length(snippet)) AS total_snippet_chars
FROM reasoning_atoms a
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(a.sources) s WHERE s->>'url' ~* 'iccsafe')
GROUP BY jurisdiction_key ORDER BY jurisdiction_key;

-- NOTE for the purge (not part of this dry run): rows with mixed sources (sources_non_icc > 0)
-- keep their non-ICC links; the snippet of a mixed row may still derive from ICC and should be
-- nulled. Rows with sources_non_icc = 0 can be deleted whole. Review (C) before choosing.
ROLLBACK;
