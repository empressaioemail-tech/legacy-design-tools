/**
 * `swapStagedCounty` -- the stage-check-swap write path for `source_feature`
 * (P-499, OPS-16 A-382/A-383; design
 * `_design/2026-10-09_P-499_source_shape_and_address_from_record.md`
 * section 3; migration `0111_source_feature.sql`).
 *
 * Replaces the per-loader DELETE-then-insert every TxGIO/CAD table in this
 * repo used before (e.g. `txgio_address`'s own ingest, until card B moves
 * it onto this table too). Delete-then-insert has a window where a short
 * or broken download has already deleted the live county and not yet
 * finished inserting its replacement -- the exact shape of the September
 * Bastrop parcel mistake the design's write-semantics section names. This
 * module closes that window by never deleting the live rows until a
 * COMPLETE, COUNT-VERIFIED replacement already sits in
 * `source_feature_stage`, and only inside one transaction with the
 * replacement.
 *
 * GATE 1 (factory's reconciliation against the registry's expected count)
 * is NOT this module's job -- the design is explicit that gate 1 runs
 * first, upstream, in the factory job. This module is the second,
 * independent check: it takes the caller's `expectedCount` and refuses to
 * touch any row if the stage's own count does not match it, or if the
 * stage is empty. A caller that skipped gate 1 (or got it wrong) cannot
 * make this function swap an unchecked county -- the count check is
 * re-verified here, not merely trusted.
 *
 * Why a TS module and not a SQL function: the repo's existing lock/sweep
 * helpers (`clusterLock.ts`, `cadPropertyWriteLock.ts`) are TS modules
 * over a drizzle transaction, not stored procedures, and this follows the
 * same shape so the same test harness (`withTestSchema`) exercises it.
 *
 * CONCURRENCY (W3 review, 2026-10-09). Two swaps of the SAME (provider,
 * countyFips) must never interleave -- without serialization, two
 * concurrent transactions could each pass their own count-check, each
 * DELETE the other's just-inserted rows, and each INSERT their own run's
 * rows, landing the live table on the UNION of both runs (stale rows from
 * one run surviving alongside the other's) rather than exactly one run.
 * The first statement in the transaction is a BLOCKING
 * `pg_advisory_xact_lock` keyed on (provider, countyFips) -- a second
 * swap for the same county simply WAITS for the first transaction to
 * commit or roll back (the lock is transaction-scoped, so it releases
 * automatically either way), rather than refusing immediately like
 * `cadPropertyWriteLock.ts`'s session-scoped try-lock. "Serialize", not
 * "refuse", is the explicit requirement here -- two legitimate swaps of
 * the same county queuing behind each other is normal; racing them is
 * not.
 */

import { and, eq, sql } from "drizzle-orm";
import type { db as defaultDb } from "./index";
import { sourceFeature } from "./schema/sourceFeature";
import { sourceFeatureStage } from "./schema/sourceFeatureStage";

/**
 * Type alias for any drizzle handle compatible with the project's shared
 * `db` singleton (both the production `@workspace/db` export and a
 * per-suite test schema's drizzle client satisfy this) -- same pattern as
 * `clusterLock.ts`'s `ClusterLockDbHandle`, defined separately here so
 * this module stays self-contained like `cadPropertyWriteLock.ts`.
 */
export type SourceFeatureSwapDbHandle = typeof defaultDb;

export interface SwapStagedCountyParams {
  /** Registry key, e.g. `txgio.address-points`. */
  provider: string;
  /** National 5-digit county FIPS, e.g. `48053` (Burnet). */
  countyFips: string;
  /** The Cluster Job / run id that wrote the staged rows being swapped in. */
  loadRunId: string;
  /**
   * The count the caller (gate 1) already reconciled the staged rows
   * against. `swapStagedCounty` RE-CHECKS the stage's actual row count
   * against this value and refuses the swap on any mismatch -- this is
   * the function's own gate, independent of whatever the caller already
   * did upstream.
   */
  expectedCount: number;
}

export interface SwapStagedCountyResult {
  provider: string;
  countyFips: string;
  loadRunId: string;
  /** Rows deleted from the live (provider, county) partition before the insert. */
  deletedLiveCount: number;
  /** Rows inserted into `source_feature` from this run's staged rows. */
  insertedCount: number;
}

export const SOURCE_FEATURE_SWAP_EMPTY_STAGE = "SOURCE_FEATURE_SWAP_EMPTY_STAGE";

/** Refusal: the stage holds zero rows for (provider, county, loadRunId). No-op -- nothing is deleted or inserted. */
export class SourceFeatureSwapEmptyStageError extends Error {
  readonly code = SOURCE_FEATURE_SWAP_EMPTY_STAGE;
  constructor(
    readonly provider: string,
    readonly countyFips: string,
    readonly loadRunId: string,
  ) {
    super(
      `${SOURCE_FEATURE_SWAP_EMPTY_STAGE}: source_feature_stage has zero rows for ` +
        `provider=${JSON.stringify(provider)} county_fips=${JSON.stringify(countyFips)} ` +
        `load_run_id=${JSON.stringify(loadRunId)}. Refusing the swap -- a short or broken ` +
        "load must never empty a live county. The live rows for this county are untouched.",
    );
    this.name = "SourceFeatureSwapEmptyStageError";
  }
}

export const SOURCE_FEATURE_SWAP_COUNT_MISMATCH = "SOURCE_FEATURE_SWAP_COUNT_MISMATCH";

/** Refusal: the stage's actual row count does not match the caller's `expectedCount`. No-op. */
export class SourceFeatureSwapCountMismatchError extends Error {
  readonly code = SOURCE_FEATURE_SWAP_COUNT_MISMATCH;
  constructor(
    readonly provider: string,
    readonly countyFips: string,
    readonly loadRunId: string,
    readonly expectedCount: number,
    readonly actualCount: number,
  ) {
    super(
      `${SOURCE_FEATURE_SWAP_COUNT_MISMATCH}: source_feature_stage holds ${actualCount} row(s) for ` +
        `provider=${JSON.stringify(provider)} county_fips=${JSON.stringify(countyFips)} ` +
        `load_run_id=${JSON.stringify(loadRunId)}, expected ${expectedCount}. Refusing the swap -- ` +
        "this is the function's own re-check of gate 1's reconciliation, not a trust of it. " +
        "The live rows for this county are untouched and the staged rows are kept for diagnosis.",
    );
    this.name = "SourceFeatureSwapCountMismatchError";
  }
}

export const SOURCE_FEATURE_SWAP_INSERT_MISMATCH = "SOURCE_FEATURE_SWAP_INSERT_MISMATCH";

/**
 * Refusal: the `INSERT ... SELECT` moved a different number of rows than
 * the stage held at count-check time, moments earlier in the SAME
 * transaction. Under this function's own flow that can only happen if
 * something else modified `source_feature_stage` for this exact
 * `(provider, countyFips, loadRunId)` between the count-check and the
 * insert WITHOUT holding the advisory lock this function takes first
 * (e.g. a stage-cleanup job with a bug, or a future caller that bypasses
 * this function) -- the stage table itself has no internal duplicates
 * (its own primary key already includes `provider_object_id`), and the
 * live DELETE already ran before this INSERT, so a same-process,
 * same-transaction mismatch is not reachable through this function's own
 * logic alone. Thrown rather than silently accepted: throwing inside the
 * transaction callback rolls back the WHOLE transaction, including the
 * live DELETE, so a bad insert never leaves the county half-swapped.
 */
export class SourceFeatureSwapInsertMismatchError extends Error {
  readonly code = SOURCE_FEATURE_SWAP_INSERT_MISMATCH;
  constructor(
    readonly provider: string,
    readonly countyFips: string,
    readonly loadRunId: string,
    readonly stagedCount: number,
    readonly insertedCount: number,
  ) {
    super(
      `${SOURCE_FEATURE_SWAP_INSERT_MISMATCH}: INSERT ... SELECT moved ${insertedCount} row(s) into ` +
        `source_feature for provider=${JSON.stringify(provider)} county_fips=${JSON.stringify(countyFips)} ` +
        `load_run_id=${JSON.stringify(loadRunId)}, but source_feature_stage held ${stagedCount} row(s) ` +
        "at this function's own count-check moments earlier in the same transaction. Rolling back -- " +
        "the live rows for this county are left untouched (this error aborts the transaction, undoing " +
        "the DELETE too).",
    );
    this.name = "SourceFeatureSwapInsertMismatchError";
  }
}

/**
 * Validates the plain-shape arguments BEFORE any query runs, same style as
 * `takeCadPropertyWriteLock`'s county_fips guard.
 */
function assertValidParams(params: SwapStagedCountyParams): void {
  if (!params.provider) {
    throw new Error("swapStagedCounty requires a non-empty provider");
  }
  if (!/^\d{5}$/.test(params.countyFips)) {
    throw new Error(
      `swapStagedCounty requires a 5-digit county_fips, got ${JSON.stringify(params.countyFips)}`,
    );
  }
  if (!params.loadRunId) {
    throw new Error("swapStagedCounty requires a non-empty loadRunId");
  }
  if (!Number.isInteger(params.expectedCount) || params.expectedCount < 0) {
    throw new Error(
      `swapStagedCounty requires a non-negative integer expectedCount, got ${JSON.stringify(params.expectedCount)}`,
    );
  }
}

/**
 * The namespace hashed into the advisory lock key, scoped to (provider,
 * countyFips) and to `current_schema()` -- the latter purely so concurrent
 * `withTestSchema` suites (each its own Postgres schema on one shared test
 * database) never contend with each other's locks; every production
 * connection is on `public`, so it costs nothing there.
 */
function swapLockNamespace(provider: string, countyFips: string): string {
  return `source_feature_swap|${provider}|${countyFips}`;
}

/**
 * Swap the live `source_feature` rows for (provider, countyFips) with this
 * run's staged rows from `source_feature_stage`, in ONE transaction:
 *
 *   0. Take a BLOCKING transaction-scoped advisory lock keyed on
 *      (provider, countyFips) -- the FIRST statement, before anything
 *      else runs. A concurrent swap of the SAME county waits here rather
 *      than racing (see the module header's "CONCURRENCY" note).
 *   1. Count the staged rows for (provider, countyFips, loadRunId).
 *   2. Refuse (throw, no-op) if that count is zero, or does not equal
 *      `expectedCount`. Nothing is deleted or inserted on a refusal --
 *      the live county is untouched and the stage is kept for diagnosis.
 *   3. Delete the live (provider, countyFips) rows.
 *   4. Insert this run's staged rows into `source_feature`. Refuse (throw,
 *      rolling back the delete too) if the number of rows actually moved
 *      does not equal the count from step 1.
 *   5. Delete this run's rows from `source_feature_stage` (the stage is
 *      only ever a holding area for one load's own rows en route to
 *      going live, or to being thrown away on a refusal).
 *
 * All steps run inside one drizzle transaction, so a crash or error
 * between steps 3 and 5 rolls the whole swap back -- the live table is
 * never observed half-replaced.
 *
 * The live (provider, countyFips) partition must already exist (created
 * per migration 0111's documented pattern, via
 * `lib/source-registry`'s `partitionDdlForProvider()`) -- a list-
 * partitioned parent with no matching partition refuses the INSERT at the
 * database level ("no partition of relation ... found for row"), which
 * surfaces as a thrown error from this function, not a silent no-op.
 *
 * Steps 3 and 4 use raw `DELETE`/`INSERT` and read the statement's own
 * `rowCount` rather than Drizzle's `.returning()` -- `.returning()` would
 * pull every affected row's data into memory (Harris county alone is
 * about 1.5M `source_feature` rows for one provider), which this function
 * never needs: only the COUNT of affected rows is ever used.
 */
export async function swapStagedCounty(
  dbHandle: SourceFeatureSwapDbHandle,
  params: SwapStagedCountyParams,
): Promise<SwapStagedCountyResult> {
  assertValidParams(params);
  const { provider, countyFips, loadRunId, expectedCount } = params;

  return await dbHandle.transaction(async (tx) => {
    // Step 0: serialize against any other swap of this exact county.
    // BLOCKING (pg_advisory_xact_lock, not the _try_ variant) -- this
    // function waits for a peer's transaction to end rather than
    // refusing; see the module header. Transaction-scoped, so it releases
    // automatically on COMMIT or ROLLBACK (including every throw below).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(
            hashtextextended(${swapLockNamespace(provider, countyFips)} || '|' || current_schema(), 0)
          )`,
    );

    const countResult = (await tx.execute(
      sql`SELECT count(*)::int AS n
          FROM ${sourceFeatureStage}
          WHERE ${sourceFeatureStage.provider} = ${provider}
            AND ${sourceFeatureStage.countyFips} = ${countyFips}
            AND ${sourceFeatureStage.loadRunId} = ${loadRunId}`,
    )) as unknown as { rows: Array<{ n: number }> };
    const stagedCount = Number(countResult.rows?.[0]?.n ?? 0);

    if (stagedCount === 0) {
      throw new SourceFeatureSwapEmptyStageError(provider, countyFips, loadRunId);
    }
    if (stagedCount !== expectedCount) {
      throw new SourceFeatureSwapCountMismatchError(
        provider,
        countyFips,
        loadRunId,
        expectedCount,
        stagedCount,
      );
    }

    const deleteLiveResult = (await tx.execute(
      sql`DELETE FROM ${sourceFeature}
          WHERE ${sourceFeature.provider} = ${provider}
            AND ${sourceFeature.countyFips} = ${countyFips}`,
    )) as unknown as { rowCount?: number | null };
    const deletedLiveCount = deleteLiveResult.rowCount ?? 0;

    const insertResult = (await tx.execute(
      sql`INSERT INTO ${sourceFeature}
            (provider, provider_object_id, state_fips, county_fips, vintage,
             fetched_at, load_run_id, source_url, geom, payload)
          SELECT provider, provider_object_id, state_fips, county_fips, vintage,
                 fetched_at, load_run_id, source_url, geom, payload
          FROM ${sourceFeatureStage}
          WHERE ${sourceFeatureStage.provider} = ${provider}
            AND ${sourceFeatureStage.countyFips} = ${countyFips}
            AND ${sourceFeatureStage.loadRunId} = ${loadRunId}`,
    )) as unknown as { rowCount?: number | null };
    const insertedCount = insertResult.rowCount ?? 0;

    if (insertedCount !== stagedCount) {
      throw new SourceFeatureSwapInsertMismatchError(
        provider,
        countyFips,
        loadRunId,
        stagedCount,
        insertedCount,
      );
    }

    await tx
      .delete(sourceFeatureStage)
      .where(
        and(
          eq(sourceFeatureStage.provider, provider),
          eq(sourceFeatureStage.countyFips, countyFips),
          eq(sourceFeatureStage.loadRunId, loadRunId),
        ),
      );

    return {
      provider,
      countyFips,
      loadRunId,
      deletedLiveCount,
      insertedCount,
    };
  });
}
