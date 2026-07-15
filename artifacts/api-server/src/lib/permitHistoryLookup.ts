/**
 * Drizzle-backed `PermitHistoryLookup` accessor for the
 * `permits:record` Property Brief adapter (feat/permits-brief-slot).
 *
 * `lib/adapters` is HTTP-fetch-shaped and must not import
 * `@workspace/db`, so the adapter declares an injected accessor on the
 * `AdapterContext` (`ctx.permitLookup`) and this module supplies the
 * real implementation over the `permit_record` store (owned Austin/
 * San Antonio issued-permit corpus, Wave-3 public-record acquisition):
 * most-recent-N rows for a `(metro, streetKey)` pair by issued date
 * (DESC NULLS LAST — undated rows exist and must not float to the
 * top), plus count/min/max aggregates over the FULL match set so the
 * summary can say "N permits since YYYY" honestly.
 *
 * `streetKey` is produced by `permitStreetKey`
 * (`@workspace/adapters/local/permits`) on BOTH sides of the join —
 * the ingest wrote `address_normalized` with the same function, so
 * the equality here is exact by construction. The fuzziness lives in
 * the normalization itself (unit-level permits, address rewrites, and
 * range addresses can miss) and is disclosed by the adapter, not here.
 *
 * The read walks `permit_record_metro_address_issued_idx`
 * (metro, address_normalized, issued_date).
 */

import { and, eq, sql, count, min, max } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb, permitRecord } from "@workspace/db";
import type {
  PermitHistoryLookup,
  PermitRecordHit,
} from "@workspace/adapters";

/**
 * Narrow db surface, mirroring `cadPropertyLookup`'s `CadLookupDb`
 * precedent — lets tests pass their per-file test-schema handle.
 */
export type PermitLookupDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "select"
>;

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the accessor. `database` is injectable for tests (the
 * integration suite passes its per-file test-schema drizzle handle).
 */
export function makePermitHistoryLookup(
  database: PermitLookupDb = defaultDb,
): PermitHistoryLookup {
  return async (metro, streetKey, limit) => {
    const where = and(
      eq(permitRecord.metro, metro),
      eq(permitRecord.addressNormalized, streetKey),
    );

    const [rows, [agg]] = await Promise.all([
      database
        .select()
        .from(permitRecord)
        .where(where)
        .orderBy(
          sql`${permitRecord.issuedDate} DESC NULLS LAST`,
          permitRecord.permitNumber,
        )
        .limit(limit),
      database
        .select({
          totalMatched: count(),
          earliestIssued: min(permitRecord.issuedDate),
          latestIssued: max(permitRecord.issuedDate),
        })
        .from(permitRecord)
        .where(where),
    ]);

    const hits: PermitRecordHit[] = rows.map((r) => ({
      permitNumber: r.permitNumber,
      permitType: r.permitType,
      workClass: r.workClass,
      permitClass: r.permitClass,
      status: r.status,
      description: r.description,
      appliedDate: r.appliedDate,
      issuedDate: r.issuedDate,
      valuation: toNumber(r.valuation),
      addressRaw: r.addressRaw,
      sourceFile: r.sourceFile,
      acquiredDate: r.acquiredDate,
    }));

    return {
      rows: hits,
      totalMatched: agg?.totalMatched ?? 0,
      earliestIssued: agg?.earliestIssued ?? null,
      latestIssued: agg?.latestIssued ?? null,
    };
  };
}
