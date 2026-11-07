/**
 * Neon pooler read-only canary.
 *
 * WHY THIS EXISTS. On 2026-08-31 the Neon pooler began injecting
 * `SET default_transaction_read_only = on` for one database. Every write across
 * two production services failed while READS STAYED GREEN, so /health answered ok
 * throughout and nothing alerted. It recurred twice more the same day through
 * deploys that reverted the mitigation. Total undetected time across the three
 * episodes was over thirteen hours.
 *
 * The Neon console cannot see this. Verified 2026-08-31: the operations log holds
 * ZERO entries for the production endpoint across a window that CONTAINS the live
 * incident, because that API tracks compute lifecycle and not proxy-level session
 * injection. Its silence looked identical while writes were broken. So the absence
 * of an alert was never evidence of health, and this canary exists to convert that
 * silence into a signal.
 *
 * WHAT IT CHECKS, and why the `source` column is the point. Reading the VALUE
 * alone cannot distinguish a healthy default `off` from a session-injected `off`.
 * The incident's signature was `source = session`; healthy is `source = default`.
 * So the predicate requires BOTH, and a healthy-looking value from the wrong
 * source fails.
 *
 * IT CHECKS THE POOLED ENDPOINT ON PURPOSE. Production currently runs UNPOOLED on
 * DEPLOYMENT_DATABASE_URL_DIRECT and is not affected by the fault. This canary
 * probes the pooler we are NOT using, so that "is it safe to go back" stops being
 * a guess. Pointing it at the direct endpoint would make it pass forever and
 * measure nothing, which is the starved-mechanism failure this repo keeps finding.
 *
 * FAIL LOUD, NEVER SILENT. Inability to run is a FAILURE, not a pass. A canary
 * that cannot connect and exits 0 is worse than no canary, because it manufactures
 * the same reassuring silence the fault already produces.
 *
 * Usage:
 *   DEPLOYMENT_DATABASE_URL=<pooled uri> node scripts/_neon-pooler-readonly-canary.mjs
 *   node scripts/_neon-pooler-readonly-canary.mjs --selftest
 */

import { execFileSync } from "node:child_process";

/** Databases probed. Both, because the incident's defining evidence was that they DIFFERED. */
export const CANARY_DATABASES = ["neondb", "hauska_mcp"];

/**
 * The predicate. Pure, so it can be tested in both directions without a database.
 *
 * rows: [{ db, setting, source }]. A db that produced no row is NOT healthy: an
 * absent reading is unmeasured, and unmeasured is not clean. Absent, zero and
 * unmeasured are three different states and this collapses none of them.
 */
export function evaluateCanary(rows, expectedDbs = CANARY_DATABASES) {
  const problems = [];
  for (const db of expectedDbs) {
    const row = rows.find((r) => r.db === db);
    if (!row) {
      problems.push({ db, kind: "unmeasured", detail: "no reading returned for this database" });
      continue;
    }
    if (row.setting !== "off") {
      problems.push({
        db,
        kind: "read_only_injected",
        detail: `default_transaction_read_only = ${row.setting} (expected off)`,
      });
      continue;
    }
    if (row.source !== "default") {
      // The incident signature: value looks fine, provenance does not.
      problems.push({
        db,
        kind: "suspicious_source",
        detail: `default_transaction_read_only is off but source = ${row.source} (expected default; the 2026-08-31 incident read "session")`,
      });
    }
  }
  return { healthy: problems.length === 0, problems };
}

const SQL =
  "SELECT setting, source FROM pg_settings WHERE name = 'default_transaction_read_only';";

/** Swap the database in a postgres URI without touching credentials. */
export function withDatabase(uri, db) {
  const u = new URL(uri);
  u.pathname = `/${db}`;
  return u.toString();
}

function readOneDatabase(baseUri, db) {
  const uri = withDatabase(baseUri, db);
  const out = execFileSync("psql", [uri, "-At", "-F", "|", "-c", SQL], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.trim().split("\n").filter(Boolean)[0];
  if (!line) throw new Error("psql returned no row for pg_settings");
  const [setting, source] = line.split("|");
  return { db, setting: (setting ?? "").trim(), source: (source ?? "").trim() };
}

function selftest() {
  const cases = [
    {
      name: "healthy: both off from default",
      rows: [
        { db: "neondb", setting: "off", source: "default" },
        { db: "hauska_mcp", setting: "off", source: "default" },
      ],
      expectHealthy: true,
    },
    {
      name: "THE INCIDENT: injected read-only on one database",
      rows: [
        { db: "neondb", setting: "on", source: "session" },
        { db: "hauska_mcp", setting: "off", source: "default" },
      ],
      expectHealthy: false,
    },
    {
      name: "the subtle one: value is off but provenance is session",
      rows: [
        { db: "neondb", setting: "off", source: "session" },
        { db: "hauska_mcp", setting: "off", source: "default" },
      ],
      expectHealthy: false,
    },
    {
      name: "a database produced no reading at all",
      rows: [{ db: "neondb", setting: "off", source: "default" }],
      expectHealthy: false,
    },
    {
      name: "NOT VACUOUS: an empty result set must not read as healthy",
      rows: [],
      expectHealthy: false,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = evaluateCanary(c.rows).healthy;
    const ok = got === c.expectHealthy;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}  (healthy=${got}, expected=${c.expectHealthy})`);
  }
  if (failed) {
    console.error(`\nSELFTEST FAILED: ${failed} case(s)`);
    process.exit(1);
  }
  console.log("\nSELFTEST PASSED: the predicate accepts health and rejects the incident, a session-sourced off, a missing reading, and an empty result.");
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();

  const uri = process.env.DEPLOYMENT_DATABASE_URL?.trim();
  if (!uri) {
    console.error("FAIL: DEPLOYMENT_DATABASE_URL (the POOLED uri) is required. Cannot run is a failure, not a pass.");
    process.exit(1);
  }
  if (!uri.includes("-pooler")) {
    // Pointing this at the direct endpoint would make it pass forever and measure
    // nothing. Refuse rather than produce a comfortable, meaningless green.
    console.error("FAIL: the supplied uri does not look pooled (no '-pooler' in host). This canary must probe the POOLED endpoint or it measures nothing.");
    process.exit(1);
  }

  const rows = [];
  const errors = [];
  for (const db of CANARY_DATABASES) {
    try {
      rows.push(readOneDatabase(uri, db));
    } catch (err) {
      errors.push(`${db}: ${err.message?.split("\n")[0] ?? String(err)}`);
    }
  }

  const { healthy, problems } = evaluateCanary(rows);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), rows, problems, errors }, null, 2));

  if (errors.length) {
    console.error(`\nFAIL: could not read ${errors.length} database(s). Inability to measure is a failure.\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  if (!healthy) {
    console.error("\nFAIL: the Neon pooler is NOT clean. Do not revert production to the pooled endpoint.");
    for (const p of problems) console.error(`  [${p.kind}] ${p.db}: ${p.detail}`);
    process.exit(1);
  }
  console.log("\nPASS: pooled endpoint reads default_transaction_read_only = off from source = default on every checked database.");
}

main();
