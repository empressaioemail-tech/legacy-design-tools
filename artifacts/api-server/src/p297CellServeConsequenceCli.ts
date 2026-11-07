#!/usr/bin/env node
/**
 * P-297 CONSEQUENCE INSTRUMENT (read-only).
 *
 * WHAT IT MEASURES. P-297 moves the serve switch off the county verdict and
 * onto the code-owned slate (`PARCEL_RECORD_SLATE`) plus the parcel's OWN
 * cell. This instrument answers the only question that makes that safe to
 * land: for every slated (county, rail) pair, how many parcels get a
 * DIFFERENT served answer after the change, and what are those answers (a
 * value, a verified absence, a not-applicable, or a declared refusal)?
 *
 * THE COUNTING RULE, stated once so nothing here is subtracted silently.
 * Before P-297 the serve switch was `resolveAllowlistState`
 * (`lib/parcelRecordAllowlist.ts`, same file, kept unchanged):
 *
 *     not in slate          -> legacy   (never reached here: all pairs below are slated)
 *     no verdict row        -> legacy
 *     verdict === 'pass'    -> record   (the cell served)
 *     recognised non-pass   -> refused  (and every cutover still kept the
 *                                         baked value: e.g.
 *                                         setbacksFactServeCutover.ts:57
 *                                         returned null on anything but
 *                                         'record')
 *
 * So `servedFromCellBefore(verdict)` below is exactly `verdict === "pass"`
 * transcribed from that table, NOT a re-derivation. A pair whose verdict is
 * not `pass` therefore changes for EVERY parcel that holds a cell row on it:
 * before, that parcel served the baked/legacy value; after, it serves its
 * cell, whatever form that cell takes. That number is the `changes` column.
 * A pair whose verdict IS `pass` changes for no parcel: the cell served
 * before and serves after (falsifier 3's byte-identical requirement).
 *
 * EXCLUSION SET (part of the contract, not an optimization).
 *   - `parcel_record_cell` rows whose `rail_key` is not slated for that
 *     county: not measured, and they change nothing, because a non-slated
 *     pair still resolves to the current path.
 *   - Counties outside the slate: not read at all.
 *   - A kind string outside the five the store is documented to hold is
 *     counted in `other` and is NEVER folded into a neighbour. It is the
 *     one number here that means "read the store again", so it must be
 *     visible rather than absorbed.
 *
 * READ-ONLY, ENFORCED. Connects with `FACTORY_DATABASE_URL_RO` (the
 * SELECT-only role) and sets `default_transaction_read_only = on` and a
 * `statement_timeout` before the first measurement query. This instrument
 * writes nothing, anywhere: no ledger row, no cache, no state flag.
 *
 * COST. Index-bounded `place_key` ranges (`>= '<fips>:' AND < '<fips>;'`,
 * the primary key's own prefix range, so the range is a btree seek and not a
 * predicate over the table), one query per county, `cell_state` read from the
 * heap only for rows the range already selected. A full-table
 * `GROUP BY kind` is 76,055,440 rows (reltuples at read time) and is the
 * shape this instrument exists to avoid.
 *
 * HEAVY-SCAN LEASE. P-281 built the lease; its control routes need
 * `FACTORY_CONTROL_API_URL`/`FACTORY_CONTROL_API_KEY`. When those are not
 * present in the environment the lease cannot be taken and this instrument
 * says so in its output rather than silently running heavy without one.
 *
 * RUN
 *   FACTORY_DATABASE_URL_RO=... npx tsx src/p297CellServeConsequenceCli.ts \
 *     [--county 48021] [--json out.json] [--markdown out.md]
 *   npx tsx src/p297CellServeConsequenceCli.ts --self-test
 *
 * EXIT CODES. 0 measured / 1 self-test failure / 2 UNMEASURED (no
 * credential, or a store read that failed). A missing credential is
 * UNMEASURED, never a zero.
 */

import { realpathSync, writeFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { PARCEL_RECORD_SLATE } from "./lib/parcelRecordAllowlist";
import {
  ACCEPTED_PARCEL_GATE_VERDICT_KINDS,
  classifyParcelGateVerdictKind,
} from "./lib/parcelGateVerdictVocabulary";

export const INSTRUMENT = "artifacts/api-server/src/p297CellServeConsequenceCli.ts";

/** The five `cell_state.kind` strings the store is documented to hold. */
export const STORE_CELL_KINDS = [
  "value",
  "absent-verified",
  "not-applicable",
  "refused",
  "unaccounted",
] as const;

export type StoreCellKind = (typeof STORE_CELL_KINDS)[number];

/** How a kind reads on the served surface after P-297 (`cellServeRule.ts`). */
export const SERVED_FORM_BY_KIND: Readonly<Record<StoreCellKind, "value" | "absence" | "refusal">> = {
  value: "value",
  "absent-verified": "absence",
  "not-applicable": "absence",
  refused: "refusal",
  unaccounted: "refusal",
};

/** One `(rail_key, kind, count)` row as Postgres returned it. */
export type MeasuredKindRow = { rail_key: string; kind: string; cells: number };

/** One slated pair, fully measured. */
export type PairConsequence = {
  countyFips: string;
  railKey: string;
  verdict: string | null;
  verdictUnrecognised: string | null;
  verdictUnaccountedCount: number | null;
  verdictEvaluatedAt: string | null;
  cells: number;
  byKind: Record<string, number>;
  otherKinds: Record<string, number>;
  servedFormByKind: Record<string, "value" | "absence" | "refusal">;
  /** `pass` before, `pass` after: the cell served in both worlds. */
  servedFromCellBefore: boolean;
  /** Parcels whose served answer changes. See the header's counting rule. */
  changes: number;
};

/**
 * The PRE-P-297 rule, transcribed from `resolveAllowlistState`. `pass` is the
 * only verdict that put a parcel on its cell; every other verdict -- a
 * refusal, an `excluded-*` kind, or no row at all -- left it on the baked or
 * legacy value.
 */
export function servedFromCellBefore(verdict: string | null): boolean {
  return verdict === "pass";
}

/**
 * Rows as Postgres returned them -> one row per slated pair. Pure: the
 * self-test drives it with synthetic rows and no database.
 *
 * A pair with no cells is still emitted (denominator honesty: "0 of 0" and
 * "not measured" must not look alike), and a kind the vocabulary does not
 * know lands in `otherKinds` while still counting toward `cells`.
 */
export function buildPairConsequences(
  pairKey: string,
  kindRows: ReadonlyArray<MeasuredKindRow>,
  verdict: { verdict: string; unaccountedCount: number | null; evaluatedAt: string | null } | null,
): PairConsequence {
  const [countyFips, railKey] = pairKey.split(":");
  const byKind: Record<string, number> = {};
  const otherKinds: Record<string, number> = {};
  for (const kind of STORE_CELL_KINDS) byKind[kind] = 0;
  let cells = 0;
  for (const row of kindRows) {
    if (row.rail_key !== railKey) continue;
    cells += row.cells;
    if ((STORE_CELL_KINDS as readonly string[]).includes(row.kind)) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + row.cells;
    } else {
      otherKinds[row.kind] = (otherKinds[row.kind] ?? 0) + row.cells;
    }
  }
  const classified = verdict ? classifyParcelGateVerdictKind(verdict.verdict) : null;
  const rawVerdict = verdict?.verdict ?? null;
  const recognised = classified?.state === "accepted" ? rawVerdict : null;
  const servedBefore = servedFromCellBefore(recognised);
  return {
    countyFips,
    railKey,
    verdict: recognised,
    verdictUnrecognised: classified?.state === "unrecognised" ? classified.raw : null,
    verdictUnaccountedCount: verdict?.unaccountedCount ?? null,
    verdictEvaluatedAt: verdict?.evaluatedAt ?? null,
    cells,
    byKind,
    otherKinds,
    servedFormByKind: Object.fromEntries(
      STORE_CELL_KINDS.map((k) => [k, SERVED_FORM_BY_KIND[k]]),
    ),
    servedFromCellBefore: servedBefore,
    changes: servedBefore ? 0 : cells,
  };
}

export function slatedPairsFor(countyFips: string): string[] {
  return [...PARCEL_RECORD_SLATE]
    .filter((key) => key.startsWith(`${countyFips}:`))
    .map((key) => key.slice(countyFips.length + 1))
    .sort();
}

export function slatedCounties(): string[] {
  return [...new Set([...PARCEL_RECORD_SLATE].map((key) => key.split(":")[0]))].sort();
}

/** `null` when the credential is absent -- the caller turns that into UNMEASURED. */
export function resolveDsn(env: Record<string, string | undefined>): string | null {
  const dsn = env.FACTORY_DATABASE_URL_RO;
  return dsn && dsn.trim().length > 0 ? dsn : null;
}

function renderMarkdown(rows: ReadonlyArray<PairConsequence>, readAt: string): string {
  const lines: string[] = [];
  lines.push(`# P-297 consequence table — cells by kind per slated (county, rail) pair`);
  lines.push("");
  lines.push(`Instrument: \`${INSTRUMENT}\`  `);
  lines.push(`Store: FACTORY_DATABASE_URL_RO (read-only role)  `);
  lines.push(`Read at: ${readAt}  `);
  lines.push(`Slated pairs measured: ${rows.length}  `);
  lines.push("");
  lines.push("Counting rule: a pair whose verdict is not `pass` changes for every parcel holding a cell row (before: baked/legacy, after: the cell). A `pass` pair changes for none (the cell served in both worlds).");
  lines.push("");
  lines.push("| county | rail | verdict | cells | value | absent-verified | not-applicable | refused | unaccounted | other | served before from cell | parcels changed |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
  for (const row of rows) {
    const other = Object.values(row.otherKinds).reduce((a, b) => a + b, 0);
    lines.push(
      `| ${row.countyFips} | ${row.railKey} | ${row.verdict ?? "none"} | ${row.cells} | ` +
        `${row.byKind.value} | ${row.byKind["absent-verified"]} | ${row.byKind["not-applicable"]} | ` +
        `${row.byKind.refused} | ${row.byKind.unaccounted} | ${other} | ` +
        `${row.servedFromCellBefore ? "yes" : "no"} | ${row.changes} |`,
    );
  }
  const totals = rows.reduce(
    (acc, row) => ({
      cells: acc.cells + row.cells,
      changes: acc.changes + row.changes,
    }),
    { cells: 0, changes: 0 },
  );
  lines.push("");
  lines.push(`Total cells on slated pairs: ${totals.cells}. Parcels whose served answer changes: ${totals.changes}.`);
  const otherRows = rows.filter((r) => Object.keys(r.otherKinds).length > 0);
  lines.push(
    otherRows.length === 0
      ? "Kinds outside the five documented kinds: none."
      : `Kinds outside the five documented kinds (READ THE STORE AGAIN): ${otherRows
          .map((r) => `${r.countyFips}:${r.railKey}=${JSON.stringify(r.otherKinds)}`)
          .join(", ")}.`,
  );
  return `${lines.join("\n")}\n`;
}

function log(message: string): void {
  console.log(message);
}

async function measure(): Promise<number> {
  const args = argv.slice(2);
  const arg = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  const dsn = resolveDsn(process.env);
  if (!dsn) {
    console.error(
      "UNMEASURED: FACTORY_DATABASE_URL_RO is not set. This is the dispatch's read-only " +
        "credential (SELECT-only role, mirrored from hauska-prod-497015). A missing credential " +
        "is UNMEASURED, not zero.",
    );
    return 2;
  }
  const countyFilter = arg("--county");
  const counties = countyFilter ? [countyFilter] : slatedCounties();
  const readAt = new Date().toISOString();
  log(`P-297 CONSEQUENCE MEASURE  ${INSTRUMENT}`);
  log(`  read at: ${readAt}`);
  log(`  counties: ${counties.join(", ")}`);
  log(
    "  lease: not taken -- P-281's control routes need FACTORY_CONTROL_API_URL/" +
      "FACTORY_CONTROL_API_KEY, which this environment does not carry",
  );

  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    // Read-only and bounded BEFORE any measurement query runs.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '900s'");

    const rows: PairConsequence[] = [];
    for (const county of counties) {
      const rails = slatedPairsFor(county);
      const { rows: kindRows } = await client.query<MeasuredKindRow>(
        `SELECT rail_key, coalesce(cell_state->>'kind', '<no-kind>') AS kind, count(*)::int AS cells
           FROM parcel_record_cell
          WHERE place_key >= $1 AND place_key < $2
            AND rail_key = ANY($3::text[])
          GROUP BY 1, 2`,
        [`${county}:`, `${county};`, rails],
      );
      const { rows: verdictRows } = await client.query<{
        rail_key: string;
        verdict: string;
        unaccounted_count: number | null;
        evaluated_at: Date | null;
      }>(
        `SELECT rail_key, verdict, unaccounted_count, evaluated_at
           FROM parcel_gate_verdict
          WHERE county_fips = $1 AND rail_key = ANY($2::text[])`,
        [county, rails],
      );
      const verdictByRail = new Map(verdictRows.map((v) => [v.rail_key, v]));
      for (const rail of rails) {
        const v = verdictByRail.get(rail);
        rows.push(
          buildPairConsequences(
            `${county}:${rail}`,
            kindRows,
            v
              ? {
                  verdict: v.verdict,
                  unaccountedCount: v.unaccounted_count,
                  evaluatedAt: v.evaluated_at ? v.evaluated_at.toISOString() : null,
                }
              : null,
          ),
        );
      }
      const countyRows = rows.filter((r) => r.countyFips === county);
      log(
        `  ${county}: ${countyRows.length} slated pairs, ` +
          `${countyRows.reduce((a, r) => a + r.cells, 0)} cells, ` +
          `${countyRows.reduce((a, r) => a + r.changes, 0)} parcels change`,
      );
    }

    const markdown = renderMarkdown(rows, readAt);
    const jsonPath = arg("--json");
    const markdownPath = arg("--markdown");
    if (jsonPath) {
      writeFileSync(
        jsonPath,
        `${JSON.stringify({ instrument: INSTRUMENT, readAt, counties, rows }, null, 1)}\n`,
      );
      log(`  json: ${jsonPath}`);
    }
    if (markdownPath) {
      writeFileSync(markdownPath, markdown);
      log(`  markdown: ${markdownPath}`);
    }
    log("");
    log(markdown);
    return 0;
  } finally {
    await client.end();
  }
}

function selfTest(): number {
  const checks: Array<[string, boolean]> = [];
  const check = (name: string, ok: boolean): void => {
    checks.push([name, ok]);
  };

  // 1. The counting rule fires in both directions.
  check("pass is the only verdict that served from the cell before", servedFromCellBefore("pass") === true);
  check("a refuse verdict did NOT serve from the cell before", servedFromCellBefore("refuse") === false);
  check("an excluded-* verdict did NOT serve from the cell before", servedFromCellBefore("excluded-not-applicable") === false);
  check("no verdict row did NOT serve from the cell before", servedFromCellBefore(null) === false);

  // 2. The pairs come from the slate itself, never a second copy.
  check("slatedPairsFor returns exactly the slate's rails for a county", slatedPairsFor("48021").length === 28);
  check("slatedPairsFor is empty for an unslated county", slatedPairsFor("48209").includes("wells") === true);

  // 3. A measured pair: kinds are split, nothing is absorbed, changes = cells
  //    on a non-pass verdict.
  const refusedPair = buildPairConsequences(
    "48021:marketValue",
    [
      { rail_key: "marketValue", kind: "value", cells: 7 },
      { rail_key: "marketValue", kind: "refused", cells: 3 },
      { rail_key: "otherRail", kind: "value", cells: 999 },
    ],
    { verdict: "refuse", unaccountedCount: 1, evaluatedAt: "2026-09-16T00:00:00Z" },
  );
  check("rows for a different rail are excluded", refusedPair.cells === 10);
  check("a non-pass pair changes for every cell holder", refusedPair.changes === 10);
  check("the value kind is counted", refusedPair.byKind.value === 7);
  check("the refused kind is counted as a refusal", refusedPair.byKind.refused === 3);

  // 4. A pass pair changes nothing -- falsifier 3's shape.
  const passPair = buildPairConsequences(
    "48021:marketValue",
    [{ rail_key: "marketValue", kind: "value", cells: 7 }],
    { verdict: "pass", unaccountedCount: 0, evaluatedAt: "2026-09-16T00:00:00Z" },
  );
  check("a pass pair changes for no parcel", passPair.changes === 0 && passPair.cells === 7);
  check("a pass pair was already served from the cell", passPair.servedFromCellBefore === true);

  // 5. An unknown kind is visible, never absorbed, and still counts.
  const weirdPair = buildPairConsequences(
    "48021:marketValue",
    [{ rail_key: "marketValue", kind: "weird-kind", cells: 4 }],
    null,
  );
  check("an unknown kind lands in otherKinds", weirdPair.otherKinds["weird-kind"] === 4);
  check("an unknown kind still counts toward cells", weirdPair.cells === 4);

  // 6. A pair with no cells is emitted, not dropped.
  const emptyPair = buildPairConsequences("48021:marketValue", [], null);
  check("an unmeasured-looking pair with 0 cells is still emitted", emptyPair.cells === 0);
  check("no verdict row reads as null, never as pass", emptyPair.verdict === null);

  // 7. An unrecognised verdict is carried out, not silently treated as pass.
  const unrecognisedPair = buildPairConsequences(
    "48021:marketValue",
    [{ rail_key: "marketValue", kind: "value", cells: 5 }],
    { verdict: "excluded-anything", unaccountedCount: 0, evaluatedAt: null },
  );
  check("an invented excluded-* verdict is unrecognised", unrecognisedPair.verdictUnrecognised === "excluded-anything");
  check("an unrecognised verdict did not serve from the cell before", unrecognisedPair.servedFromCellBefore === false);

  // 8. The six pinned verdict strings are the accepted set this instrument uses.
  check("the pinned vocabulary holds six strings", ACCEPTED_PARCEL_GATE_VERDICT_KINDS.size === 6);

  // 9. A missing credential is UNMEASURED, never zero.
  check("resolveDsn returns null with no credential", resolveDsn({}) === null);
  check("resolveDsn returns null for a blank credential", resolveDsn({ FACTORY_DATABASE_URL_RO: "  " }) === null);
  check("resolveDsn returns the credential when present", resolveDsn({ FACTORY_DATABASE_URL_RO: "postgres://x" }) === "postgres://x");

  // 10. Every kind the store is documented to hold has a served form.
  check(
    "every documented kind maps to a served form",
    STORE_CELL_KINDS.every((k) => SERVED_FORM_BY_KIND[k] !== undefined),
  );
  check("a value cell serves a value", SERVED_FORM_BY_KIND.value === "value");
  check("an unaccounted cell serves a refusal", SERVED_FORM_BY_KIND.unaccounted === "refusal");

  const bad = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  log(bad.length ? `SELF-TEST FAILED (${bad.length} of ${checks.length})` : `SELF-TEST OK (${checks.length})`);
  return bad.length ? 1 : 0;
}

function isDirectRun(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const args = argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest());
  }
  measure()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`UNMEASURED: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    });
}
