import type pg from "pg";

/** Minimal QueryResult for NearestParcelsQueryable / pg.Pool.query mocks. */
export function pgQueryResult<R extends pg.QueryResultRow>(
  rows: R[],
): pg.QueryResult<R> {
  return {
    rows,
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}
