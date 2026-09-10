#!/usr/bin/env node
/**
 * CAD published-identifier backfill CLI. P-124 CTX-HAYS-BACKFILL.
 *
 * Writes ONLY `cad_property.quick_ref_id` and `cad_property.property_number`,
 * onto rows that ALREADY EXIST at the county's DECLARED vintage. It cannot
 * insert, it cannot write an empty string, it cannot touch another column, and
 * it refuses rather than proceeding when it cannot prove the last of those.
 *
 * This is NOT `cad-ingest`. Running a CAD export through `cad-ingest` rebuilds
 * whole rows, which for Hays 48209 and the 2026-08-26 drop means moving
 * market_value on 45,524 of 134,216 accounts. See
 * `publishedIdentifierBackfill.ts` for the measurement and the reasoning.
 *
 * Usage:
 *   pnpm --filter @workspace/cad-ingest cad-backfill-published-identifiers -- \
 *     --county=48209 \
 *     --file=<drop.zip | directory | PROPERTY member .txt> \
 *     [--tax-year=2026]        # OPTIONAL confirmation; must EQUAL the
 *                              #   declared vintage, never overrides it
 *     --record=<path.jsonl>    # REQUIRED unless --dry-run
 *     [--batch-size=1000] [--dry-run]
 *
 * DATABASE_URL must point at the target Postgres.
 *
 * There is deliberately NO --limit and NO --skip-verify. A partial run would
 * leave a county half-populated with a count that reads as complete, and an
 * escape hatch on the untouched-columns digest would teach the next operator
 * to use it. Staging IS the pilot: run it there, read the record, then run the
 * identical invocation against production.
 *
 * Exit-bounded: read, plan, write, verify, summary, exit. 0 on success, 1 on
 * any refusal.
 */

import { parseArgs } from "node:util";
import { mkdtemp, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";
import { resolveCounty } from "./counties";
import { HeaderIndex, readCsvRows } from "./csv";
import { extractCadDrop, ORION_ENTRY_FILTER } from "./zip";
import {
  BackfillRefusal,
  DEFAULT_BACKFILL_BATCH_SIZE,
  createFileRecordWriter,
  createMemoryRecordWriter,
  discriminateOrionPropertyMember,
  readPublishedIdentifiers,
  resolveBackfillTaxYear,
  runPublishedIdentifierBackfill,
  sha256OfFile,
  type BackfillExecutor,
  type MemberDiscrimination,
} from "./publishedIdentifierBackfill";

const { Pool } = pg;

function log(msg: string): void {
  console.log(`[cad-backfill-ids] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[cad-backfill-ids] REFUSED: ${msg}`);
  process.exit(1);
}

async function pathKind(p: string): Promise<"file" | "dir" | "missing"> {
  try {
    const s = await stat(p);
    return s.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

async function headerOf(
  filePath: string,
): Promise<{ header: HeaderIndex; width: number } | null> {
  for await (const row of readCsvRows(filePath)) {
    return { header: new HeaderIndex(row), width: row.length };
  }
  return null;
}

interface Candidate {
  file: string;
  decision: MemberDiscrimination | { accepted: false; decidedBy: string; columnCount: 0; rulesPassed: []; refusal: { rule: string; reason: string; identifiedAs: null } };
}

/**
 * Find THE PROPERTY member among the files extracted from a drop, by SHAPE.
 *
 * Never by name. Every member of a Hays drop is `PropertyDataExport<n>.txt`
 * and the numbering is not mnemonic, so the name carries no record type at
 * all; `extractCadDrop` flattens to basenames, which throws away even the
 * enclosing zip's name. Shape is the only thing left, and shape is the thing
 * that should have been used in the first place.
 *
 * EXACTLY ONE candidate must be accepted. Zero is a refusal. More than one is
 * also a refusal: two PROPERTY-shaped members in one drop is an ambiguity
 * nobody authorised this tool to resolve.
 */
async function selectPropertyMember(files: string[]): Promise<{
  file: string;
  candidates: Candidate[];
}> {
  const candidates: Candidate[] = [];
  for (const f of files) {
    if (!/\.(txt|csv)$/i.test(f)) continue;
    const h = await headerOf(f);
    if (h === null) {
      candidates.push({
        file: f,
        decision: {
          accepted: false,
          decidedBy: "R0 file-has-a-header",
          columnCount: 0,
          rulesPassed: [],
          refusal: { rule: "R0 file-has-a-header", reason: "empty file", identifiedAs: null },
        },
      });
      continue;
    }
    candidates.push({
      file: f,
      decision: discriminateOrionPropertyMember(h.header, h.width),
    });
  }
  for (const c of candidates) {
    const d = c.decision;
    if (d.accepted) {
      log(`candidate ${basename(c.file)} (${d.columnCount} cols): ACCEPTED by ${d.decidedBy}`);
    } else {
      const r = d.refusal;
      log(
        `candidate ${basename(c.file)} (${d.columnCount} cols): refused by ` +
          `${r?.rule}${r?.identifiedAs ? ` — identified as ${r.identifiedAs}` : ""}`,
      );
    }
  }
  const accepted = candidates.filter((c) => c.decision.accepted);
  if (accepted.length === 0) {
    fail(
      "no PROPERTY member found in the input. Every candidate was refused; " +
        "the per-candidate decisions are printed above. A Hays drop names " +
        "every member PropertyDataExport<n>.txt, so this is decided on shape, " +
        "never on the file name.",
    );
  }
  if (accepted.length > 1) {
    fail(
      `${accepted.length} members are PROPERTY-shaped ` +
        `(${accepted.map((c) => basename(c.file)).join(", ")}). Refusing rather ` +
        "than picking one.",
    );
  }
  return { file: (accepted[0] as Candidate).file, candidates };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args,
    options: {
      county: { type: "string" },
      file: { type: "string" },
      "tax-year": { type: "string" },
      record: { type: "string" },
      "batch-size": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.county) {
    fail(
      "usage: cad-backfill-published-identifiers --county=<fips|name> " +
        "--file=<drop.zip|dir|member.txt> --record=<path.jsonl> " +
        "[--tax-year=NNNN] [--batch-size=1000] [--dry-run]",
    );
  }
  if (!values.file) fail("--file is required (the CAD drop or the PROPERTY member)");

  const county = resolveCounty(values.county);
  if (!county) fail(`unknown county "${values.county}"`);

  const dryRun = values["dry-run"] ?? false;
  if (!dryRun && !values.record) {
    fail(
      "--record=<path.jsonl> is required for a real run. A state-changing " +
        "operation leaves a durable record naming the items it acted on; a " +
        "count alone is not a record.",
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!dryRun && !databaseUrl) fail("DATABASE_URL must be set (or pass --dry-run)");
  if (dryRun && !databaseUrl) {
    fail(
      "DATABASE_URL must be set even for --dry-run: the plan is computed " +
        "against the real roll, so a dry run that guessed the roll would be " +
        "measuring nothing.",
    );
  }

  const taxYearArg =
    values["tax-year"] !== undefined ? Number(values["tax-year"]) : undefined;
  if (taxYearArg !== undefined && !Number.isInteger(taxYearArg)) {
    fail(`--tax-year must be an integer, got "${values["tax-year"]}"`);
  }

  // The declared-vintage gate, BEFORE any file work and before any connection.
  let declared;
  try {
    declared = resolveBackfillTaxYear(county.fips, taxYearArg);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  log(
    `county=${county.fips} (${county.name}) declared vintage tax_year=` +
      `${declared.taxYear} tier=${declared.tier}` +
      (taxYearArg !== undefined ? " (--tax-year confirmed)" : ""),
  );

  // The record is opened FIRST, so an unwritable path stops the run before a
  // connection exists rather than after the first batch has landed.
  const record = values.record
    ? createFileRecordWriter(values.record)
    : createMemoryRecordWriter();
  if (record.path) log(`durable record: ${record.path}`);

  const input = values.file;
  if ((await pathKind(input)) === "missing") fail(`input not found: ${input}`);

  let sourceSha256: string | null = null;
  let files: string[];
  const kind = await pathKind(input);
  if (kind === "file" && /\.zip$/i.test(input)) {
    sourceSha256 = sha256OfFile(input);
    log(`archive sha256 ${sourceSha256}`);
    const workDir = await mkdtemp(join(tmpdir(), "cad-backfill-ids-"));
    files = await extractCadDrop(input, workDir, ORION_ENTRY_FILTER, log);
  } else if (kind === "dir") {
    files = (await readdir(input)).map((n) => join(input, n));
  } else {
    sourceSha256 = sha256OfFile(input);
    files = [input];
  }

  const { file: propertyFile } = await selectPropertyMember(files);
  log(`PROPERTY member: ${propertyFile}`);

  const read = await readPublishedIdentifiers(propertyFile);
  log(
    `read ${read.rowsRead} rows: ${read.rows.length} accounts offer an ` +
      `identifier, ${read.rowsWithNoIdentifier} publish neither, ` +
      `${read.duplicateRowsExact} exact duplicate rows, ` +
      `${read.duplicateRowsConflicting} conflicting duplicates refused, ` +
      `${read.blankPropIdRows} blank PropertyID rows`,
  );

  const pool = new Pool({ connectionString: databaseUrl });
  // `pg` types its rows as QueryResultRow; the executor interface is generic
  // so tests can hand back typed fakes. The cast is at the seam, once.
  const exec: BackfillExecutor = {
    async query(text, values) {
      const r = await pool.query(text, values);
      return { rows: r.rows as never[] };
    },
  };
  try {
    const summary = await runPublishedIdentifierBackfill(
      exec,
      read,
      {
        countyFips: county.fips,
        taxYear: declared.taxYear,
        sourceArchive: input,
        sourceMember: basename(propertyFile),
        sourceSha256,
        invocation: `cad-backfill-published-identifiers ${args.join(" ")}`,
        batchSize:
          values["batch-size"] !== undefined
            ? Number(values["batch-size"])
            : DEFAULT_BACKFILL_BATCH_SIZE,
        dryRun,
        record,
      },
    );

    log("---- backfill summary ----");
    log(`county:                    ${summary.countyFips} (${county.name})`);
    log(`tax_year (declared):       ${summary.taxYear}`);
    log(`source archive:            ${summary.sourceArchive}`);
    log(`source member:             ${summary.sourceMember}`);
    log(`mode:                      ${summary.dryRun ? "DRY RUN (no write)" : "APPLIED"}`);
    log(`roll rows at that year:    ${summary.rollRows}`);
    log(`accounts offered:          ${summary.exportAccountsOffered}`);
    log(`rows matched:              ${summary.rowsMatched}`);
    log(`rows updated:              ${summary.rowsUpdated}`);
    log(`skipped, no roll row:      ${summary.rowsSkippedNoRollRow} (never inserted)`);
    log(`skipped, null identifier:  ${summary.rowsSkippedNullIdentifier} (stay NULL)`);
    log(`skipped, conflicting dup:  ${summary.rowsSkippedConflictingDuplicate}`);
    log(`roll rows not written:     ${summary.rollRowsNoWrite} (these stay NULL)`);
    log(`  of which not in export:  ${summary.rollRowsNotInExport}`);
    log(`  of which no identifier:  ${summary.rollRowsInExportWithNoIdentifier}`);
    log(`  of which conflicting:    ${summary.rollRowsInExportRefusedAsConflicting}`);
    log(
      `untouched-columns digest:  ${
        summary.dryRun
          ? "not taken (dry run)"
          : summary.untouchedDigestVerified
            ? `VERIFIED unchanged over ${summary.untouchedDigestBefore?.columns.length} columns`
            : "CHANGED"
      }`,
    );
    if (record.path) log(`record written:            ${record.path}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof BackfillRefusal) {
    console.error(`[cad-backfill-ids] REFUSED (${err.rule}): ${err.message}`);
    console.error(`[cad-backfill-ids] detail: ${JSON.stringify(err.detail)}`);
    process.exit(1);
  }
  console.error("[cad-backfill-ids] FAILED:", err);
  process.exit(1);
});
