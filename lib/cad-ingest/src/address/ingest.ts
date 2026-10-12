/**
 * Batch load of normalized address-point records into `txgio_address`.
 *
 * TWO write paths now live in this file:
 *
 *  1. `deleteCountyAddresses` + `upsertAddresses` — the ORIGINAL per-batch
 *     streaming upsert (ON CONFLICT DO UPDATE, idempotent across resumed
 *     runs). Still exported and still covered by its own tests (the
 *     migration-0110 key-collision proof below), but the CLI no longer
 *     calls these two as a bare sequence for a live county — see (2).
 *
 *  2. `bufferAddressRecords` + `swapCountyAddresses` — the FETCH-THEN-SWAP
 *     path (P-499 `_design/2026-10-09_P-499_source_shape_and_address_
 *     from_record.md` §3, applied to the existing `txgio_address` table
 *     rather than the not-yet-merged `source_feature`). This is what the
 *     CLI's real (non-dry-run) write path uses now.
 *
 *     Path (1) ran as two SEPARATE statements, outside any transaction,
 *     with the network crawl streaming DURING the insert half. For a
 *     live county this deleted the serving rows the moment the delete
 *     ran, then rebuilt them gradually over the whole crawl (Bexar:
 *     721,120 points, ~361 pages at the service's polite pace — on the
 *     order of 10-20 minutes with the county missing or partial), and a
 *     crawl that died midway left the county PERMANENTLY partly empty.
 *
 *     Path (2) fixes this by fetching and buffering the WHOLE county in
 *     memory first (`bufferAddressRecords`, before any DB connection is
 *     opened), refusing with zero writes if the crawl looks incomplete
 *     (`checkAddressFetchComplete`), and only then replacing the county's
 *     rows inside ONE transaction (`swapCountyAddresses`): delete, batch
 *     insert, verify the count, commit. Readers see the old rows until
 *     COMMIT (ordinary Postgres MVCC — no special isolation level is
 *     needed), and a failure anywhere in the insert rolls the delete back
 *     too, so a live county can never end up partially replaced.
 *
 * The key is (county_fips, object_id) as of migration 0110 — changed
 * from (county_fips, full_addr, unit), which silently collapsed distinct
 * delivery points that happened to share a label (measured Burnet
 * 2026-10-09: 35,857 service points, only 35,690 stored, 167 lost
 * across 86 colliding groups with no shared coordinates). The same
 * delivery point re-fetched in a fresher vintage still updates in
 * place, because object_id is stable within a county across a
 * wholesale reload (see module docs on `deleteCountyAddresses`).
 *
 * Callers pass a drizzle handle so the CLI (own pool from DATABASE_URL)
 * and tests (`withTestSchema`) share this code — same pattern as
 * `../txgio/ingest.ts`.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { txgioAddress } from "@workspace/db/schema";
import type { TxgioAddressRecord } from "./parse";

/** Minimal structural slice of a drizzle node-postgres database. */
export type AddressIngestDb = Pick<
  NodePgDatabase<Record<string, unknown>>,
  "insert" | "delete" | "execute"
>;

export const ADDRESS_DEFAULT_BATCH_SIZE = 1000;

export async function deleteCountyAddresses(
  db: AddressIngestDb,
  countyFips: string,
): Promise<void> {
  await db
    .delete(txgioAddress)
    .where(sql`${txgioAddress.countyFips} = ${countyFips}`);
}

export interface AddressUpsertOptions {
  /** Source label recorded on every row (the service layer path). */
  sourceFile: string;
  /** Program vintage label recorded on every row. */
  sourceVintage: string;
  batchSize?: number;
  /** Progress callback, called after each batch. */
  onBatch?: (totalRowsInserted: number) => void;
}

export interface AddressUpsertSummary {
  /**
   * Rows the database actually affected (drizzle `.returning()` row
   * count on the real INSERT ... ON CONFLICT statement), NOT the number
   * of records streamed in. Before this fix the field summed
   * `batch.length`, which counted a conflict-UPDATE as an insert — the
   * mechanism behind Burnet (2026-10-09) logging "35,750 rows inserted"
   * while only 35,690 rows were ever stored.
   */
  rowsInserted: number;
  batches: number;
  /**
   * Records dropped because the SAME (county_fips, object_id) was
   * already sent earlier in this same load — should not happen,
   * object_id is the source service's statewide-unique OBJECTID, but
   * counted rather than silently absorbed by ON CONFLICT DO UPDATE if
   * it ever does.
   */
  duplicateObjectIds: number;
}

export async function upsertAddresses(
  db: AddressIngestDb,
  records: AsyncIterable<TxgioAddressRecord> | Iterable<TxgioAddressRecord>,
  opts: AddressUpsertOptions,
): Promise<AddressUpsertSummary> {
  const batchSize = opts.batchSize ?? ADDRESS_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txgioAddress.$inferInsert;
  let batch: InsertRow[] = [];
  // Guard against a same-key duplicate ANYWHERE in this load, not just
  // within one batch — a single INSERT cannot update the same conflict
  // target twice, and a duplicate split across two batches would
  // otherwise be silently absorbed as a second conflict-UPDATE instead
  // of being counted. Scoped to the whole call (never reset), unlike the
  // old per-batch Set this replaces.
  const seenKeys = new Set<string>();
  let rowsInserted = 0;
  let duplicateObjectIds = 0;
  let batches = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const result = await db
      .insert(txgioAddress)
      .values(batch)
      .onConflictDoUpdate({
        target: [txgioAddress.countyFips, txgioAddress.objectId],
        set: {
          fullAddr: sql`excluded.full_addr`,
          unit: sql`excluded.unit`,
          addNumber: sql`excluded.add_number`,
          stName: sql`excluded.st_name`,
          postComm: sql`excluded.post_comm`,
          postCode: sql`excluded.post_code`,
          state: sql`excluded.state`,
          countyName: sql`excluded.county_name`,
          source: sql`excluded.source`,
          dateAcq: sql`excluded.date_acq`,
          longitude: sql`excluded.longitude`,
          latitude: sql`excluded.latitude`,
          tileKey: sql`excluded.tile_key`,
          sourceFile: sql`excluded.source_file`,
          sourceVintage: sql`excluded.source_vintage`,
          ingestedAt: sql`now()`,
        },
      })
      // Count what the database actually affected, not the batch size
      // sent — see AddressUpsertSummary.rowsInserted.
      .returning({ objectId: txgioAddress.objectId });
    rowsInserted += result.length;
    batches += 1;
    batch = [];
    opts.onBatch?.(rowsInserted);
  }

  for await (const rec of records) {
    const key = `${rec.countyFips}|${rec.objectId}`;
    if (seenKeys.has(key)) {
      duplicateObjectIds += 1;
      continue;
    }
    seenKeys.add(key);
    batch.push({
      countyFips: rec.countyFips,
      fullAddr: rec.fullAddr,
      unit: rec.unit,
      objectId: rec.objectId,
      addNumber: rec.addNumber,
      stName: rec.stName,
      postComm: rec.postComm,
      postCode: rec.postCode,
      state: rec.state,
      countyName: rec.countyName,
      source: rec.source,
      dateAcq: rec.dateAcq,
      longitude: rec.longitude,
      latitude: rec.latitude,
      tileKey: rec.tileKey,
      sourceFile: opts.sourceFile,
      sourceVintage: opts.sourceVintage,
    });
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { rowsInserted, batches, duplicateObjectIds };
}

// ---------------------------------------------------------------------
// Fetch-then-swap path (P-499 stage-check-swap, applied to txgio_address)
// ---------------------------------------------------------------------

/**
 * A handle that can open a transaction — the CLI's pooled drizzle
 * instance (`drizzle(pool)`) and a single unpooled `drizzle(client)`
 * both satisfy it, same shape as `../txgio/ingest.ts`'s
 * `TxgioTransactionalDb`. The callback receives an `AddressIngestDb`
 * -shaped transaction handle.
 *
 * Unlike `@workspace/db/cadPropertyWriteLock`'s SESSION-scoped lock
 * (which must REFUSE a PgBouncer transaction-pooled connection outright —
 * see that module's header), `swapCountyAddresses` below takes a
 * TRANSACTION-scoped advisory lock (`pg_advisory_xact_lock`). Its
 * lifetime is exactly one BEGIN..COMMIT, the same unit a transaction-mode
 * pooler already pins to a single backend connection, so it is safe to
 * take over either a pooled or an unpooled connection string. This is
 * exercised directly: `addressSwap.integration.test.ts` runs the same
 * swap through a multi-connection `pg.Pool` (the CLI's own shape) AND
 * through a single, directly-opened `pg.Client` (standing in for a
 * direct/unpooled Neon host, e.g. `directNeonUrl`).
 */
export interface AddressTransactionalDb extends AddressIngestDb {
  transaction<T>(fn: (tx: AddressIngestDb) => Promise<T>): Promise<T>;
}

/**
 * Rows currently stored for a county — used to report `swap: deleted D,
 * inserted I` and, incidentally, as the first read inside the swap
 * transaction after the advisory lock is taken (see `swapCountyAddresses`).
 */
export async function countCountyAddresses(
  db: AddressIngestDb,
  countyFips: string,
): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ${txgioAddress}
        WHERE ${txgioAddress.countyFips} = ${countyFips}`,
  )) as unknown as { rows: Array<{ n?: unknown }> };
  const n = result.rows?.[0]?.n;
  return typeof n === "number" ? n : Number(n ?? 0);
}

export interface AddressBufferResult {
  /** The whole crawl, deduped by objectid, held in memory. Measured
   *  2026-10-12: Bexar (721,120 points, the largest of the six live
   *  reload-target counties) buffers at roughly 250 bytes/record — about
   *  175 MB RSS — comfortably inside the DOKS job template's 2Gi memory
   *  budget, so none of the six counties need the spill-to-disk
   *  alternative (a newline-delimited JSON file under `os.tmpdir()`,
   *  which the template's 8Gi `/tmp` emptyDir would also cover). */
  records: TxgioAddressRecord[];
  /** Same accounting `upsertAddresses` has always kept: a record whose
   *  (county_fips, object_id) repeats one already buffered in this same
   *  load is counted here and dropped, never silently absorbed. */
  duplicateObjectIds: number;
}

/**
 * Drain the WHOLE crawl into memory before any DB write (P-499 §3's
 * "fetch everything first", applied to this table). The CLI calls this
 * for every mode — `--dry-run`, `--count-only` never reaches it, and a
 * real write — so the completeness numbers it produces
 * (`checkAddressFetchComplete`'s `rowsRead`/`rowsParsed`/`rowsSkipped`
 * inputs, and this function's own `records.length` /
 * `duplicateObjectIds`) are always the same real measurement, not an
 * estimate computed only on the write path.
 *
 * The objectid dedupe runs HERE, at buffer time, not inside the later
 * insert — by the time `swapCountyAddresses` runs, the county's old rows
 * have already been deleted inside that same transaction, so there is
 * nothing left for an insert to legitimately conflict with (see
 * `swapCountyAddresses`'s own comment on why it uses a plain INSERT, not
 * `upsertAddresses`'s ON CONFLICT DO UPDATE).
 */
export async function bufferAddressRecords(
  records: AsyncIterable<TxgioAddressRecord> | Iterable<TxgioAddressRecord>,
): Promise<AddressBufferResult> {
  const seenKeys = new Set<string>();
  const buffered: TxgioAddressRecord[] = [];
  let duplicateObjectIds = 0;
  for await (const rec of records) {
    const key = `${rec.countyFips}|${rec.objectId}`;
    if (seenKeys.has(key)) {
      duplicateObjectIds += 1;
      continue;
    }
    seenKeys.add(key);
    buffered.push(rec);
  }
  return { records: buffered, duplicateObjectIds };
}

/** The coded refusal this module raises when a crawl looks incomplete. */
export const ADDRESS_FETCH_INCOMPLETE = "ADDRESS_FETCH_INCOMPLETE";

export type AddressFetchIncompleteReason =
  | "count-mismatch"
  | "parsed-skipped-mismatch"
  | "zero-after-dedupe";

export interface AddressFetchCheckInput {
  countyFips: string;
  countyName: string;
  /** From `countAddressPoints`, taken at the START of the run. */
  serviceCount: number;
  rowsRead: number;
  rowsParsed: number;
  rowsSkipped: number;
  /** `bufferAddressRecords(...).records.length` — parsed records that
   *  survived the objectid dedupe. */
  bufferedAfterDedupe: number;
}

export interface AddressFetchRefusal {
  code: typeof ADDRESS_FETCH_INCOMPLETE;
  reason: AddressFetchIncompleteReason;
  message: string;
  countyFips: string;
  countyName: string;
  serviceCount: number;
  rowsRead: number;
  rowsParsed: number;
  rowsSkipped: number;
  bufferedAfterDedupe: number;
}

/**
 * The "check" of stage-check-swap: refuse — with NO db write attempted at
 * all — unless the crawl looks complete. Three ordered checks, each its
 * own named reason so the refusal JSON says which one fired:
 *
 *  1. `rowsRead !== serviceCount` — the crawl read a different number of
 *     features than the service reported at the start. Catches a crawl
 *     that died early, a server that silently truncated paging, AND a
 *     deliberately bounded `--limit` sample (correctly refused: a
 *     partial sample must never swap into a live county).
 *  2. `rowsParsed + rowsSkipped !== rowsRead` — every feature read must
 *     be accounted for as either parsed or skipped; a mismatch means the
 *     counters themselves are untrustworthy.
 *  3. `bufferedAfterDedupe === 0` — checked only once (1) and (2) pass,
 *     so this means a structurally complete crawl that genuinely
 *     produced nothing usable (wrong county name, service schema drift,
 *     or — degenerate case — every parsed record collided on objectid).
 *
 * Pure and synchronous: no network, no DB — so it is exercised directly
 * in unit tests, the same shape as `addressIngestWriteGate`.
 */
export function checkAddressFetchComplete(
  input: AddressFetchCheckInput,
): AddressFetchRefusal | null {
  const {
    countyFips,
    countyName,
    serviceCount,
    rowsRead,
    rowsParsed,
    rowsSkipped,
    bufferedAfterDedupe,
  } = input;
  const nums = {
    countyFips,
    countyName,
    serviceCount,
    rowsRead,
    rowsParsed,
    rowsSkipped,
    bufferedAfterDedupe,
  };

  if (rowsRead !== serviceCount) {
    return {
      code: ADDRESS_FETCH_INCOMPLETE,
      reason: "count-mismatch",
      message:
        `${ADDRESS_FETCH_INCOMPLETE}: ${countyName} (${countyFips}) crawl read ${rowsRead} ` +
        `feature(s) but the service reported ${serviceCount} at the start of this run. ` +
        "Refusing to touch the live rows -- a short, dropped, or deliberately " +
        "--limit-bounded crawl must never swap into a county's serving rows.",
      ...nums,
    };
  }
  if (rowsParsed + rowsSkipped !== rowsRead) {
    return {
      code: ADDRESS_FETCH_INCOMPLETE,
      reason: "parsed-skipped-mismatch",
      message:
        `${ADDRESS_FETCH_INCOMPLETE}: ${countyName} (${countyFips}) parsed ${rowsParsed} + ` +
        `skipped ${rowsSkipped} = ${rowsParsed + rowsSkipped}, which does not equal the ` +
        `${rowsRead} feature(s) read. Every read feature must land as parsed or skipped.`,
      ...nums,
    };
  }
  if (bufferedAfterDedupe === 0) {
    return {
      code: ADDRESS_FETCH_INCOMPLETE,
      reason: "zero-after-dedupe",
      message:
        `${ADDRESS_FETCH_INCOMPLETE}: ${countyName} (${countyFips}) produced zero address ` +
        `records after the objectid dedupe (read ${rowsRead}, parsed ${rowsParsed}, skipped ` +
        `${rowsSkipped}). Refusing an empty swap -- check the county name and service schema.`,
      ...nums,
    };
  }
  return null;
}

/** Namespace prefix for the swap's transaction-scoped advisory lock. */
export const ADDRESS_SWAP_LOCK_NAMESPACE_PREFIX = "txgio_address|";

export function addressSwapLockNamespace(countyFips: string): string {
  return `${ADDRESS_SWAP_LOCK_NAMESPACE_PREFIX}${countyFips}`;
}

/**
 * `SET LOCAL statement_timeout` for the whole swap transaction (2026-10-12
 * W3 review). Bounds EVERY statement in the transaction, including the
 * DELETE and each insert batch — never the transaction as a whole, since
 * `statement_timeout` resets per statement.
 *
 * Sized for the largest of the six live reload counties, Bexar
 * (721,120 rows, measured 2026-10-09). The DELETE removes rows under the
 * primary key btree ((county_fips, object_id), migration 0110) AND
 * maintains the normalized-`full_addr` functional index (migration 0058,
 * `txgio_address_fulladdr_norm_idx`) for every row it touches — on a
 * shared Neon server (noisy-neighbor contention is real there, not
 * hypothetical), a bare single-statement budget of 120s can plausibly be
 * exceeded by a DELETE this size even though it is not, by itself, a slow
 * operation: measured 2026-10-12 on an UNTHROTTLED standalone Postgres
 * with the same two indexes (PK + the migration-0058 functional index) and
 * the real `swapCountyAddresses` code path (not a bare `psql`), DELETE of
 * 721,120 Bexar rows took 580-970ms across repeated runs — comfortably
 * under 120s there, which is exactly why 120s was not sized for Neon's
 * noisy-neighbor case; this number is a local floor, not a Neon ceiling.
 * 30 minutes bounds the worst case generously while still failing (and
 * rolling back, never leaving a county half-replaced) if something is
 * genuinely stuck rather than just slow.
 */
export const ADDRESS_SWAP_STATEMENT_TIMEOUT = "30min";

/**
 * `SET LOCAL lock_timeout` for the whole swap transaction (2026-10-12 W3
 * review). Applies to the advisory-lock wait below (which goes through
 * the ordinary lock manager, so `lock_timeout` governs it) as well as any
 * other lock this transaction might wait on.
 *
 * Short and DELIBERATELY much tighter than `statement_timeout`: a second
 * load of the SAME county should fail FAST and loud rather than silently
 * queue for up to 30 minutes behind a peer that might itself be mid-swap
 * on all 721,120 Bexar rows. A fast, visible failure is retried or
 * rescheduled by the operator/job runner; a 30-minute silent queue is not
 * materially different from a hang, from the caller's point of view.
 */
export const ADDRESS_SWAP_LOCK_TIMEOUT = "10s";

/**
 * Take the swap's transaction-scoped advisory lock, keyed on
 * ('txgio_address', county_fips). BLOCKING (`pg_advisory_xact_lock`, never
 * the `_try_` variant): two loads of the SAME county SERIALIZE, one
 * waiting for the other — up to `ADDRESS_SWAP_LOCK_TIMEOUT`, after which
 * Postgres cancels the wait with a lock_timeout error (propagates out of
 * `swapCountyAddresses`, rolling back; the live county is untouched
 * either way). Within that window, the holder's transaction ending
 * (COMMIT or ROLLBACK) releases the lock automatically — even a crashed
 * holder's connection closing releases it, so there is no stale-lock
 * window to manage.
 *
 * `hashtextextended(key || '|' || current_schema(), 0)` is the same
 * schema-qualified hashing idiom `clusterLock.ts` and
 * `cadPropertyWriteLock.ts` already use: production (one `public` schema
 * per database) gets one shared key per county, while concurrent test
 * runs — each in its own `withTestSchema` schema — never contend on each
 * other's keys.
 */
async function takeAddressSwapLock(
  tx: AddressIngestDb,
  countyFips: string,
): Promise<void> {
  const namespace = addressSwapLockNamespace(countyFips);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespace} || '|' || current_schema(), 0))`,
  );
}

export interface AddressSwapOptions {
  /** Source label recorded on every row (the service layer path). */
  sourceFile: string;
  /** Program vintage label recorded on every row. */
  sourceVintage: string;
  batchSize?: number;
  /** Progress callback, called after each insert batch commits (within
   *  the still-open transaction). */
  onBatchInserted?: (totalRowsInserted: number) => void;
  /**
   * TEST-ONLY. Invoked after the insert is complete and its row count is
   * verified, but BEFORE commit. The CLI never sets this. Tests use it to
   * hold the swap transaction open deterministically — so a concurrent
   * reader's "old rows, then new rows, never a mix" proof and a
   * concurrent writer's "two swaps of one county serialize" proof do not
   * depend on timing/sleeps.
   */
  onBeforeCommit?: () => Promise<void>;
  /**
   * TEST-ONLY. Overrides `ADDRESS_SWAP_LOCK_TIMEOUT` for this call. The CLI
   * never sets this. Tests use a short override (e.g. `'200ms'`) to prove
   * the fail-fast behavior itself — waiting out the real 10s default on
   * every run would make that proof prohibitively slow — without
   * duplicating the lock/timeout wiring in a separate test-only code path.
   */
  lockTimeoutOverride?: string;
}

export interface AddressSwapSummary {
  /** Rows the county held before this swap (all deleted). */
  rowsDeleted: number;
  rowsInserted: number;
  batches: number;
  /** Wall-clock time of the DELETE statement alone (2026-10-12 W3 review —
   *  the operation `ADDRESS_SWAP_STATEMENT_TIMEOUT` is sized for). */
  deleteMs: number;
  /** Wall-clock time of every insert batch combined (excludes the DELETE
   *  and the lock wait). */
  insertMs: number;
}

/**
 * Plain batched INSERT of already-buffered rows — NOT `upsertAddresses`,
 * and deliberately with no ON CONFLICT clause. By the time this runs,
 * `swapCountyAddresses` has already deleted the county's existing rows
 * earlier in the SAME transaction, so there is nothing left to
 * legitimately conflict with: a conflict here can only mean a duplicate
 * objectid that survived `bufferAddressRecords`'s dedupe (a real bug) or
 * a programming error. Either way it must THROW — which rolls the whole
 * swap transaction back — never silently update as `upsertAddresses` does
 * for its own (deliberately different) resumable-streaming use case.
 */
async function insertAddressRows(
  tx: AddressIngestDb,
  records: readonly TxgioAddressRecord[],
  opts: AddressSwapOptions,
): Promise<{ rowsInserted: number; batches: number }> {
  const batchSize = opts.batchSize ?? ADDRESS_DEFAULT_BATCH_SIZE;
  type InsertRow = typeof txgioAddress.$inferInsert;
  let rowsInserted = 0;
  let batches = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const slice = records.slice(i, i + batchSize);
    const values: InsertRow[] = slice.map((rec) => ({
      countyFips: rec.countyFips,
      fullAddr: rec.fullAddr,
      unit: rec.unit,
      objectId: rec.objectId,
      addNumber: rec.addNumber,
      stName: rec.stName,
      postComm: rec.postComm,
      postCode: rec.postCode,
      state: rec.state,
      countyName: rec.countyName,
      source: rec.source,
      dateAcq: rec.dateAcq,
      longitude: rec.longitude,
      latitude: rec.latitude,
      tileKey: rec.tileKey,
      sourceFile: opts.sourceFile,
      sourceVintage: opts.sourceVintage,
    }));
    // `.returning()` row count, not `slice.length` — same "count what the
    // database actually affected" discipline as `upsertAddresses`
    // (AddressUpsertSummary's own doc comment explains why: a plain
    // `batch.length` sum was the mechanism behind Burnet 2026-10-09
    // logging more rows "inserted" than were ever actually stored).
    const result = await tx
      .insert(txgioAddress)
      .values(values)
      .returning({ objectId: txgioAddress.objectId });
    rowsInserted += result.length;
    batches += 1;
    opts.onBatchInserted?.(rowsInserted);
  }
  return { rowsInserted, batches };
}

/**
 * Replace one county's `txgio_address` rows ATOMICALLY, in ONE
 * transaction: BEGIN, take the county-scoped advisory lock, delete the
 * county's existing rows, batch-insert every buffered row, verify the
 * inserted count against the buffer, then commit.
 *
 * `records` must already be the COMPLETE, checked buffer
 * (`bufferAddressRecords` + a passing `checkAddressFetchComplete`) — this
 * function does no network I/O and holds nothing back; by design it has
 * no way to know whether its input represents a whole county, which is
 * exactly why that check runs before this is ever called.
 *
 * Readers on another connection see the OLD rows until COMMIT (ordinary
 * Postgres MVCC under the default READ COMMITTED isolation — no special
 * isolation level needed: an uncommitted DELETE/INSERT is simply not
 * visible to any other session's snapshot), then the NEW rows from the
 * moment COMMIT returns. A throw anywhere in the insert (including the
 * row-count verification below) propagates out of the `db.transaction`
 * callback, which rolls back the delete along with every batch already
 * inserted — the live county is left exactly as it was.
 */
export async function swapCountyAddresses(
  db: AddressTransactionalDb,
  countyFips: string,
  records: readonly TxgioAddressRecord[],
  opts: AddressSwapOptions,
): Promise<AddressSwapSummary> {
  return await db.transaction(async (tx) => {
    // Safety nets, NEVER session-level SET (brief rule 3 / P-499 review
    // note): both scoped to this transaction only, so neither can leak
    // onto another client's connection the way a session-level SET did on
    // 2026-10-07 (hauska_mcp pooler incident).
    //
    // statement_timeout bounds every statement (DELETE, each insert
    // batch) at a budget sized for Bexar, the largest county; lock_timeout
    // is far tighter, so a peer's lock wait fails fast instead of queueing
    // for the whole statement_timeout window — see both constants' own
    // comments for the full reasoning and the row counts behind them.
    // sql.raw, not a bound ${} parameter: SET's grammar takes a literal,
    // not a placeholder. The statement_timeout value is always this
    // module's own constant. lock_timeout can be test-overridden
    // (`lockTimeoutOverride`) — validated against Postgres's own GUC
    // time-value shape before it ever reaches raw SQL, so even a test
    // typo fails loudly here rather than opening an injection surface.
    const lockTimeout = opts.lockTimeoutOverride ?? ADDRESS_SWAP_LOCK_TIMEOUT;
    if (!/^\d+(ms|s|min|h|d)?$/.test(lockTimeout)) {
      throw new Error(`swapCountyAddresses: invalid lockTimeoutOverride ${JSON.stringify(lockTimeout)}`);
    }
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${ADDRESS_SWAP_STATEMENT_TIMEOUT}'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeout}'`));
    await takeAddressSwapLock(tx, countyFips);
    const rowsDeleted = await countCountyAddresses(tx, countyFips);

    const deleteStartedAt = Date.now();
    await deleteCountyAddresses(tx, countyFips);
    const deleteMs = Date.now() - deleteStartedAt;

    const insertStartedAt = Date.now();
    const { rowsInserted, batches } = await insertAddressRows(tx, records, opts);
    const insertMs = Date.now() - insertStartedAt;

    if (rowsInserted !== records.length) {
      throw new Error(
        `AddressSwapRowCountMismatch: county ${countyFips} inserted ${rowsInserted} row(s) ` +
          `but ${records.length} were buffered -- rolling back the whole swap.`,
      );
    }
    await opts.onBeforeCommit?.();
    return { rowsDeleted, rowsInserted, batches, deleteMs, insertMs };
  });
}
