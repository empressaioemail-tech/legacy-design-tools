/**
 * Reader for the publish-gate verdict store PARCEL-B-GATE-SCHED writes
 * (F-01, decision `_decisions/2026-09-02_step7_consumer_c_then_b.md`).
 *
 * CONTRACT (shared with PARCEL-B-GATE-SCHED; coordinate via closes, never a
 * shared checkout per the dispatch). This card ships FIRST and defines the
 * table below; if PARCEL-B-GATE-SCHED's own close proposes a different
 * shape, that is a stop-and-report, not a silent reconciliation.
 *
 *   CREATE TABLE parcel_gate_verdict (
 *     county_fips text NOT NULL,
 *     rail_key text NOT NULL,
 *     verdict text NOT NULL CHECK (verdict IN ('pass', 'refuse', 'excluded')),
 *     unaccounted_count integer NOT NULL DEFAULT 0,
 *     evaluated_at timestamptz NOT NULL,
 *     run_id text NOT NULL,
 *     PRIMARY KEY (county_fips, rail_key)
 *   );
 *
 * Semantics: 'pass' = this rail is live program-wide AND this county has
 * zero unaccounted cells on it. 'refuse' = this rail is live AND this
 * county has >=1 unaccounted cell on it. 'excluded' = this rail is
 * declared-ahead (no earned cell program-wide) -- written explicitly so a
 * reader can distinguish "checked and excluded" from "never evaluated",
 * satisfying "the excludedDeclaredAhead list publishes with every
 * evaluation" at (county, rail) grain even though liveness is itself a
 * global property.
 *
 * This reader treats a MISSING row and a query ERROR (including "relation
 * parcel_gate_verdict does not exist" if the scheduler has not run its
 * first migration yet) identically: no usable verdict. The allowlist
 * (parcelRecordAllowlist.ts) is the only consumer that turns that into a
 * decision, and it fails closed to legacy either way.
 */

import { parcelRecordQueryableFromEnv, type ParcelRecordQueryable } from "./parcelRecordCellRead";

/**
 * PARCEL-B-SLATE1 (F-01): resolves the real verdict-store connection for a
 * serve-cutover wrapper's own test-injection seam. Every wrapper
 * (wellFactServeCutover.ts and siblings) previously called
 * `resolveAllowlist(injectedVerdictStore ?? null, ...)` -- since
 * `injectedVerdictStore` defaults to `undefined` outside tests,
 * `undefined ?? null` is `null` in EVERY production request, meaning the
 * verdict store was never actually connected: resolveAllowlist always
 * fell back to 'legacy' regardless of PARCEL_RECORD_SLATE membership. This
 * was invisible while the slate shipped empty (PARCEL-B-READER) because
 * resolveAllowlist's own synchronous slate-membership check short-circuits
 * before ever reaching the store for an unslated pair -- the gap only
 * matters, and only became reachable, once a real slate entry existed.
 * Callers pass their own `injectedVerdictStore` through unchanged for
 * tests (`undefined` means "no override, use the real env-resolved pool";
 * `null` explicitly means "store not configured", still a valid, testable
 * fail-closed case).
 */
export function resolveVerdictStore(
  injected: ParcelRecordQueryable | null | undefined,
): ParcelRecordQueryable | null {
  if (injected !== undefined) return injected;
  return parcelRecordQueryableFromEnv();
}

export type ParcelGateVerdictKind = "pass" | "refuse" | "excluded";

export type ParcelGateVerdict = {
  countyFips: string;
  railKey: string;
  verdict: ParcelGateVerdictKind;
  unaccountedCount: number;
  evaluatedAt: string;
  runId: string;
};

/** null means: no usable verdict (missing row, query error, or store unset). Never throws. */
export type ParcelGateVerdictRead = ParcelGateVerdict | null;

const SELECT_VERDICT = `
SELECT county_fips, rail_key, verdict, unaccounted_count, evaluated_at, run_id
  FROM parcel_gate_verdict
 WHERE county_fips = $1
   AND rail_key = $2
`;

type VerdictRow = {
  county_fips: string;
  rail_key: string;
  verdict: string;
  unaccounted_count: number;
  evaluated_at: string;
  run_id: string;
};

function isVerdictKind(v: string): v is ParcelGateVerdictKind {
  return v === "pass" || v === "refuse" || v === "excluded";
}

/**
 * Read one (county, rail) verdict. Never throws -- any failure (missing
 * row, missing table, connection error) resolves to null so the allowlist
 * can fail closed without a try/catch of its own.
 */
export async function loadParcelGateVerdict(
  store: ParcelRecordQueryable | null,
  countyFips: string,
  railKey: string,
): Promise<ParcelGateVerdictRead> {
  if (!store) return null;
  try {
    const result = await store.query<VerdictRow>(SELECT_VERDICT, [countyFips, railKey]);
    const row = result.rows[0];
    if (!row) return null;
    if (!isVerdictKind(row.verdict)) return null;
    return {
      countyFips: row.county_fips,
      railKey: row.rail_key,
      verdict: row.verdict,
      unaccountedCount: row.unaccounted_count,
      evaluatedAt: row.evaluated_at,
      runId: row.run_id,
    };
  } catch {
    // Table not yet created by PARCEL-B-GATE-SCHED, connection failure,
    // malformed row -- all collapse to "no usable verdict". This is the
    // one function in this pair permitted to swallow an error, because its
    // whole purpose is to make "unreadable" indistinguishable from
    // "missing" for the fail-closed allowlist.
    return null;
  }
}

/** In-memory verdict store for tests. */
export function memoryParcelGateVerdicts(
  rows: ReadonlyArray<ParcelGateVerdict>,
): ParcelRecordQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (!text.includes("FROM parcel_gate_verdict")) {
        throw new Error(
          "memoryParcelGateVerdicts: refusing a query that is not the verdict SELECT",
        );
      }
      const countyFips = params?.[0];
      const railKey = params?.[1];
      const match = rows.find(
        (r) => r.countyFips === countyFips && r.railKey === railKey,
      );
      if (!match) return { rows: [] as unknown as T[] };
      return {
        rows: [
          {
            county_fips: match.countyFips,
            rail_key: match.railKey,
            verdict: match.verdict,
            unaccounted_count: match.unaccountedCount,
            evaluated_at: match.evaluatedAt,
            run_id: match.runId,
          },
        ] as unknown as T[],
      };
    },
  };
}

/** A store double that always throws, for proving the fail-closed path against a real error, not just a missing row. */
export function memoryParcelGateVerdictsThatFails(): ParcelRecordQueryable {
  return {
    async query() {
      throw new Error(
        'relation "parcel_gate_verdict" does not exist (simulated: PARCEL-B-GATE-SCHED has not created it yet)',
      );
    },
  };
}
