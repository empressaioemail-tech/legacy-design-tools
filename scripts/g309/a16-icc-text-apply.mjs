#!/usr/bin/env node
/**
 * G-309 A16 APPLY (hash-locked): blank the ICC-sourced text in code_atoms and
 * reasoning_atoms that the dry-run manifest listed.
 *
 *   DATABASE_URL=<unpooled neondb> node scripts/g309/a16-icc-text-apply.mjs \
 *       --manifest <manifest.json> --expect-hash <manifestHash> --confirm G309-A16 [--dry]
 *       [--scope snippet|snippet,reasoning] [--classes icc-title,icc-source-link] [--expect-db neondb] [--env-var DATABASE_URL] [--timeout-ms 300000]
 *
 * CHOICE: BLANK, DO NOT DELETE.
 *   code_atoms:      body = '' (column is NOT NULL), body_html = NULL, embedding = NULL,
 *                    embedding_model = NULL, embedded_at = NULL. Row, id, content_hash,
 *                    source_id, source_url, edition, section_number/title, fetched_at,
 *                    metadata are kept.
 *   reasoning_atoms: snippet = NULL by default (--scope snippet); reasoning = NULL only with
 *                    --scope snippet,reasoning. Row, sources[] and calibration kept.
 *   reasoning is a template written by our code (snippet.ts reasoningSummaryFromFetch and
 *   persist.ts overlay/deeplink strings), no model and no source text, so the default
 *   leaves it. snippet is the first 600 chars of the fetched section text.
 *   --classes picks icc-title and/or icc-source-link rows (default both).
 *   Why: (1) citations are by atom id and resolve through these rows
 *   (provenanceEnvelope joins code_atoms to code_atom_sources for deeplink/edition/
 *   retrievedAt; engine signals and corpus coverage read them), so deleting would
 *   drop existing citations; (2) the orchestrator inserts with
 *   ON CONFLICT (content_hash) DO NOTHING, so a kept content_hash stops a re-warm from
 *   re-inserting the same ICC text, while a delete would let it come back;
 *   (3) readers already return citation fields only for ICC rows (#832).
 *
 * Treatment of whole-atom exclusions: an ICC-title atom is blanked in full, so the
 * 61 IWUIC and 14 IRC_R301_2_1 atoms lose any county amendment text inside them, as
 * #832 excluded them. Re-sourcing county amendments is a separate card.
 *
 * Exit codes: 0 applied (or --dry rolled back clean), 3 wrong db / vacuous,
 * 4 usage or error, 5 hash mismatch or drift (nothing changed), 6 after-counts not zero
 * (rolled back). There is no rollback after a commit, by design.
 */
import { readFileSync } from "node:fs";
import {
  CONFIRM_TOKEN,
  DEFAULT_ENV_VAR,
  DEFAULT_EXPECT_DB,
  EXIT,
  LANE,
  Vacuous,
  buildManifest,
  computeManifestHash,
  connect,
  parseArgs,
  parseScope,
  reasoningRowInScopeWithText,
  scrub,
  totals,
} from "./a16-lib.mjs";

class Refusal extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

async function main() {
  const args = parseArgs(
    process.argv.slice(2),
    ["manifest", "expect-hash", "confirm", "expect-db", "env-var", "timeout-ms", "scope", "classes"],
    ["dry"],
  );
  if (!args.manifest || !args["expect-hash"] || args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--manifest, --expect-hash and --confirm ${CONFIRM_TOKEN} are all required`);
  }
  const timeoutMs = Number(args["timeout-ms"] ?? 300000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  const expectDb = args["expect-db"] ?? DEFAULT_EXPECT_DB;
  const dry = Boolean(args.dry);
  const scope = parseScope(args.scope, args.classes);

  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  const recomputed = computeManifestHash(manifest);
  if (recomputed !== manifest.manifestHash) {
    throw new Refusal(EXIT.DRIFT, "manifest file does not match its own manifestHash (edited or corrupt)");
  }
  if (recomputed !== args["expect-hash"]) {
    throw new Refusal(EXIT.DRIFT, "manifestHash does not match --expect-hash");
  }

  const client = await connect(args["env-var"] ?? DEFAULT_ENV_VAR);
  let cert;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query("SET LOCAL lock_timeout = 10000");
    // Writers wait; readers continue. Holds until COMMIT/ROLLBACK so the re-select cannot drift.
    await client.query("LOCK TABLE code_atoms, reasoning_atoms IN SHARE ROW EXCLUSIVE MODE");

    const before = await buildManifest(client, expectDb);
    if (before.manifestHash !== manifest.manifestHash) {
      throw new Refusal(EXIT.DRIFT, "database no longer matches the manifest (drift); nothing was changed");
    }
    const tb = totals(before);
    if (tb.rows === 0) throw new Vacuous("zero total rows");

    const caIds = before.tables.code_atoms.rows.filter((r) => r.hasText).map((r) => r.id);
    const raIds = before.tables.reasoning_atoms.rows
      .filter((r) => reasoningRowInScopeWithText(r, scope))
      .map((r) => r.id);

    let caChanged = 0;
    let raChanged = 0;
    if (caIds.length) {
      caChanged = (
        await client.query(
          `UPDATE code_atoms SET body = '', body_html = NULL, embedding = NULL,
                  embedding_model = NULL, embedded_at = NULL
           WHERE id = ANY($1::uuid[])`,
          [caIds],
        )
      ).rowCount;
    }
    if (raIds.length) {
      raChanged = (
        await client.query(
          `UPDATE reasoning_atoms SET snippet = NULL${scope.columns.includes("reasoning") ? ", reasoning = NULL" : ""} WHERE id = ANY($1::text[])`,
          [raIds],
        )
      ).rowCount;
    }
    if (caChanged !== caIds.length || raChanged !== raIds.length) {
      throw new Refusal(EXIT.AFTER_COUNT, "updated row counts differ from the manifest; rolled back");
    }

    const after = await buildManifest(client, expectDb);
    const ta = totals(after);
    const raLeft = after.tables.reasoning_atoms.rows.filter((r) => reasoningRowInScopeWithText(r, scope)).length;
    const sameShape =
      after.tables.code_atoms.total === before.tables.code_atoms.total &&
      after.tables.reasoning_atoms.total === before.tables.reasoning_atoms.total &&
      after.tables.code_atoms.iccTotal === before.tables.code_atoms.iccTotal &&
      after.tables.reasoning_atoms.iccTotal === before.tables.reasoning_atoms.iccTotal;
    const caLeft = after.tables.code_atoms.iccWithText;
    if (caLeft !== 0 || raLeft !== 0 || !sameShape) {
      throw new Refusal(
        EXIT.AFTER_COUNT,
        `after-counts not clean (code_atoms ICC rows with text: ${caLeft}; reasoning_atoms in-scope rows with text: ${raLeft}; row totals unchanged: ${sameShape}); rolled back`,
      );
    }

    cert = {
      mode: dry ? "DRY (rolled back, nothing changed)" : "APPLIED (committed)",
      database: before.database,
      manifestHash: manifest.manifestHash,
      code_atoms: {
        total: before.tables.code_atoms.total,
        iccRows: before.tables.code_atoms.iccTotal,
        blanked: caChanged,
        iccWithTextBefore: before.tables.code_atoms.iccWithText,
        iccWithTextAfter: after.tables.code_atoms.iccWithText,
        byCodeBook: before.tables.code_atoms.byCodeBook,
      },
      reasoning_atoms: {
        total: before.tables.reasoning_atoms.total,
        iccRows: before.tables.reasoning_atoms.iccTotal,
        blanked: raChanged,
        iccWithTextBefore: before.tables.reasoning_atoms.iccWithText,
        inScopeWithTextBefore: raIds.length,
        inScopeWithTextAfter: raLeft,
        iccWithTextAfter: after.tables.reasoning_atoms.iccWithText,
        breakdownBefore: before.tables.reasoning_atoms.breakdown,
      },
      reasoningScope: { columns: scope.columns, classes: scope.classes },
      rowsDeleted: 0,
    };
    await client.query(dry ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }

  console.log(`===== ${LANE} CERTIFICATE (no text) =====`);
  console.log(JSON.stringify(cert, null, 2));
  console.log(`===== END ${LANE} CERTIFICATE =====`);
  return EXIT.OK_NONE;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof Refusal) {
      console.error(`REFUSED: ${scrub(e.message)}`);
      process.exit(e.code);
    }
    if (e instanceof Vacuous) {
      console.error(`VACUOUS: ${scrub(e.message)}`);
      process.exit(EXIT.VACUOUS);
    }
    console.error(`ERROR: ${scrub(e.message ?? e)}`);
    process.exit(EXIT.ERROR);
  },
);
