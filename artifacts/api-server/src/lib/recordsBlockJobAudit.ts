/**
 * Issued-job audit for the BLOCK defect. A job is a re-run candidate
 * when its stored legal text carries a block the retired pattern missed.
 * A count is not a record; each row is named.
 *
 * This module is the instrument. Running it against a live store is a
 * separate invocation that needs DATABASE_URL. No URL is not a zero.
 */

import { blockTermMissedByRetiredPattern } from "./recordsSearchQueryPlan";

export type IssuedRecordsJobRow = {
  id: string;
  parcelKey: string;
  status: string;
  legalDescription: string | null;
  storedBlock: string | null;
};

export type BlockJobAuditHit = {
  id: string;
  parcelKey: string;
  status: string;
  legalDescription: string;
};

export function selectBlockMissJobs(
  rows: ReadonlyArray<IssuedRecordsJobRow>,
): BlockJobAuditHit[] {
  const hits: BlockJobAuditHit[] = [];
  for (const row of rows) {
    if (!blockTermMissedByRetiredPattern(row.legalDescription)) continue;
    hits.push({
      id: row.id,
      parcelKey: row.parcelKey,
      status: row.status,
      legalDescription: row.legalDescription!.trim(),
    });
  }
  return hits;
}

export const BLOCK_JOB_AUDIT_SQL = `
SELECT
  id,
  parcel_key AS "parcelKey",
  status,
  request_payload->'searchTerms'->>'legalDescription' AS "legalDescription",
  request_payload->'searchTerms'->>'block' AS "storedBlock"
FROM records_request_jobs
WHERE request_payload->'searchTerms'->>'legalDescription' IS NOT NULL
`.trim();
