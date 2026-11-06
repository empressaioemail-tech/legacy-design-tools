#!/usr/bin/env node
/**
 * G-309 A16 DRY RUN (read-only): list ICC-classified rows in code_atoms and
 * reasoning_atoms with the length and sha256 of each text column, never the
 * text. Writes a manifest JSON whose `manifestHash` locks the apply script.
 *
 *   DATABASE_URL=<unpooled neondb> node scripts/g309/a16-icc-text-dry-run.mjs \
 *       --out <manifest.json> [--expect-db neondb] [--env-var DATABASE_URL] [--timeout-ms 120000]
 *
 * Exit codes: 0 no ICC text present, 2 ICC text present, 3 vacuous (wrong
 * database name, tables or columns missing, zero total rows), 4 error.
 *
 * Connection: the connection is opened read-only (BEGIN READ ONLY plus
 * default_transaction_read_only) with a statement_timeout. The DSN is never
 * printed. Run it against a direct (non-pooler) URL.
 */
import { writeFileSync } from "node:fs";
import {
  DEFAULT_ENV_VAR,
  DEFAULT_EXPECT_DB,
  EXIT,
  Vacuous,
  buildManifest,
  connect,
  parseArgs,
  scrub,
  totals,
} from "./a16-lib.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2), ["out", "expect-db", "env-var", "timeout-ms"], []);
  if (!args.out) throw new Error("--out <manifest.json> is required");
  const timeoutMs = Number(args["timeout-ms"] ?? 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  const expectDb = args["expect-db"] ?? DEFAULT_EXPECT_DB;

  const client = await connect(args["env-var"] ?? DEFAULT_ENV_VAR);
  let manifest;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query("SET LOCAL lock_timeout = 5000");
    manifest = await buildManifest(client, expectDb);
    await client.query("ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }

  const t = totals(manifest);
  if (t.rows === 0) throw new Vacuous("zero total rows in code_atoms and reasoning_atoms: wrong database or empty tables");

  writeFileSync(args.out, JSON.stringify(manifest, null, 2) + "\n");
  const ca = manifest.tables.code_atoms;
  const ra = manifest.tables.reasoning_atoms;
  console.log(`G-309 A16 dry run  database=${manifest.database}`);
  console.log(`  code_atoms       total=${ca.total} icc=${ca.iccTotal} icc_with_text=${ca.iccWithText}`);
  console.log(`  reasoning_atoms  total=${ra.total} icc=${ra.iccTotal} icc_with_text=${ra.iccWithText}`);
  console.log(`  code_atoms ICC rows by code_book: ${JSON.stringify(ca.byCodeBook)}`);
  const bd = ra.breakdown;
  console.log(`  reasoning_atoms ICC rows by class: ${JSON.stringify(bd.byClass)}`);
  console.log(`  reasoning_atoms ICC rows by text column: ${JSON.stringify(bd.byTextShape)}`);
  console.log(`  reasoning_atoms class x text column: ${JSON.stringify(bd.byClassAndShape)}`);
  console.log(`  reasoning_atoms class x edition token: ${JSON.stringify(bd.byClassAndEditionToken)}`);
  console.log(`  reasoning_atoms ICC rows by city (jurisdiction_key): ${JSON.stringify(bd.byJurisdiction)}`);
  console.log(`  reasoning_atoms matching only by code_ref (diagnostic, not purged): ${ra.codeRefOnlyTitleNotPurged}`);
  console.log(`  manifest=${args.out}`);
  console.log(`  manifestHash=${manifest.manifestHash}`);
  return t.withText > 0 ? EXIT.PRESENT : EXIT.OK_NONE;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof Vacuous) {
      console.error(`VACUOUS: ${scrub(e.message)}`);
      process.exit(EXIT.VACUOUS);
    }
    console.error(`ERROR: ${scrub(e.message ?? e)}`);
    process.exit(EXIT.ERROR);
  },
);
