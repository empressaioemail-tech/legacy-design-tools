/**
 * G-309 A16 shared module: classify and fingerprint ICC-sourced text in
 * `code_atoms` and `reasoning_atoms`. Used by a16-icc-text-dry-run.mjs and
 * a16-icc-text-apply.mjs. Never reads, returns or prints stored text: only
 * ids, lengths and sha256 digests leave the database layer.
 *
 * ONE DEFINITION OF "ICC". This module does not restate any ICC rule. It loads
 * the repo's own source files and calls them:
 *   - lib/codes/src/iccTitles.ts      isIccTitleAtom   (PR #832, title identifiers)
 *   - lib/icc-notice/src/index.ts     isIccSource      (ICC host / icc-model-code / ICC-named source)
 * and composes them exactly as the reader does in
 *   - artifacts/api-server/src/lib/iccAccess.ts  isIccRow
 * (isIccSource(url, jurisdictionKey, sourceName) OR isIccTitleAtom(codeBook,
 * sectionNumber, jurisdictionKey)). The .ts files are transpiled in memory with
 * the repo's own `typescript` so this runs on any Node version (CI is Node 20).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createRequire } from "node:module";

export const LANE = "G-309-A16";
export const CONFIRM_TOKEN = "G309-A16";
/** The database LDT's env docs name for prod/staging data (STAGING_NEONDB_URL / PRODUCTION_NEONDB_URL). */
export const DEFAULT_EXPECT_DB = "neondb";
export const DEFAULT_ENV_VAR = "DATABASE_URL";

export const EXIT = {
  OK_NONE: 0,
  PRESENT: 2,
  VACUOUS: 3,
  ERROR: 4,
  DRIFT: 5,
  AFTER_COUNT: 6,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
// pg is a lib/db dependency, not a root one: resolve it from there.
const pg = createRequire(path.join(REPO, "lib/db/package.json"))("pg");

async function loadTs(rel) {
  const src = readFileSync(path.join(REPO, rel), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

let classifierPromise;
export function loadClassifier() {
  classifierPromise ??= (async () => {
    const titles = await loadTs("lib/codes/src/iccTitles.ts");
    const notice = await loadTs("lib/icc-notice/src/index.ts");
    return { isIccTitleAtom: titles.isIccTitleAtom, isIccSource: notice.isIccSource };
  })();
  return classifierPromise;
}

/** code_atoms row (joined to its source) -> reasons it is ICC, [] when not. Mirrors iccAccess.isIccRow. */
export function classifyCodeAtom(c, r) {
  const reasons = [];
  if (
    c.isIccSource({
      sourceUrl: r.source_url,
      jurisdictionKey: r.jurisdiction_key,
      sourceName: r.source_name,
    })
  ) {
    reasons.push("source");
  }
  if (
    c.isIccTitleAtom({
      codeBook: r.code_book,
      sectionNumber: r.section_number,
      jurisdictionKey: r.jurisdiction_key,
    })
  ) {
    reasons.push("title");
  }
  return reasons;
}

/**
 * reasoning_atoms row -> reasons. Source links are judged as the reader does
 * (reasoningAtomToCodeSection: sources.some(isIccSource)). The row's
 * edition_slug / code_ref go through isIccTitleAtom as codeBook / sectionNumber.
 */
export function classifyReasoningAtom(c, r) {
  const reasons = [];
  const sources = Array.isArray(r.sources) ? r.sources : [];
  if (sources.some((s) => c.isIccSource(s)) || c.isIccSource({ jurisdictionKey: r.jurisdiction_key })) {
    reasons.push("source");
  }
  if (
    c.isIccTitleAtom({
      codeBook: r.edition_slug,
      sectionNumber: r.code_ref,
      jurisdictionKey: r.jurisdiction_key,
    })
  ) {
    reasons.push("title");
  }
  return reasons;
}

function leadToken(v) {
  return typeof v === "string" ? (v.toUpperCase().match(/^[A-Z]+/)?.[0] ?? "(none)") : "(none)";
}

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

export function computeManifestHash(m) {
  return sha256Hex(
    canonicalJson({ manifestVersion: m.manifestVersion, database: m.database, tables: m.tables }),
  );
}

export function scrub(s) {
  return String(s).replace(/postgres(?:ql)?:\/\/\S+/gi, "[dsn-redacted]");
}

export function parseArgs(argv, valueFlags, boolFlags) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (boolFlags.includes(k)) out[k] = true;
    else if (valueFlags.includes(k)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      out[k] = v;
    } else throw new Error(`unknown flag --${k}`);
  }
  return out;
}

export async function connect(envVar) {
  const url = process.env[envVar]?.trim();
  if (!url) throw new Error(`${envVar} is not set`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

const CODE_COLS = ["body", "body_html", "embedding", "embedding_model", "embedded_at", "source_id", "metadata"];
const REASONING_COLS = ["snippet", "reasoning", "sources", "code_ref", "edition_slug"];

/** Throws Vacuous(...) when the schema is not the one this purge is for. */
export class Vacuous extends Error {}

export async function assertSchema(client, expectDb) {
  const { rows: d } = await client.query("SELECT current_database() AS db");
  const db = d[0].db;
  if (db !== expectDb) {
    throw new Vacuous(`database name mismatch: connected to "${db}", expected "${expectDb}"`);
  }
  const { rows: t } = await client.query(
    "SELECT to_regclass('code_atoms') IS NOT NULL AS ca, to_regclass('code_atom_sources') IS NOT NULL AS cas, to_regclass('reasoning_atoms') IS NOT NULL AS ra",
  );
  if (!t[0].ca || !t[0].cas || !t[0].ra) {
    throw new Vacuous(
      `tables missing (code_atoms=${t[0].ca}, code_atom_sources=${t[0].cas}, reasoning_atoms=${t[0].ra})`,
    );
  }
  const { rows: cols } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ('code_atoms','reasoning_atoms')`,
  );
  const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
  const missing = [
    ...CODE_COLS.map((c) => `code_atoms.${c}`),
    ...REASONING_COLS.map((c) => `reasoning_atoms.${c}`),
  ].filter((k) => !have.has(k));
  if (missing.length) throw new Vacuous(`columns missing: ${missing.join(", ")}`);
  return db;
}

const fp = (col) =>
  `(CASE WHEN ${col} IS NULL THEN NULL ELSE length(${col}::text) END) AS ${col.replace(/\W/g, "_")}_len,
   (CASE WHEN ${col} IS NULL THEN NULL ELSE encode(sha256(convert_to(${col}::text,'UTF8')),'hex') END) AS ${col.replace(/\W/g, "_")}_sha`;

const col = (len, sha) => ({ len: len ?? null, sha256: sha ?? null });

function chunks(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

/**
 * Build the manifest from the current database state. Two passes: a scan of
 * identifier columns only (no text columns selected) to classify, then
 * length/sha256 fingerprints for the classified ids only.
 */
export async function buildManifest(client, expectDb) {
  const c = await loadClassifier();
  const database = await assertSchema(client, expectDb);

  // ---- code_atoms
  const caTotal = Number((await client.query("SELECT count(*) AS n FROM code_atoms")).rows[0].n);
  const caScan = (
    await client.query(
      `SELECT a.id::text AS id, a.jurisdiction_key, a.code_book, a.section_number, a.source_url, s.source_name
       FROM code_atoms a LEFT JOIN code_atom_sources s ON s.id = a.source_id
       ORDER BY a.id`,
    )
  ).rows;
  const caIcc = [];
  for (const r of caScan) {
    const reasons = classifyCodeAtom(c, r);
    if (reasons.length) caIcc.push({ id: r.id, reasons, book: r.code_book, token: leadToken(r.code_book) });
  }
  const caRows = [];
  for (const batch of chunks(caIcc, 500)) {
    const { rows } = await client.query(
      `SELECT id::text AS id, ${fp("body")}, ${fp("body_html")}, ${fp("embedding")}, ${fp("metadata")},
              (embedding_model IS NOT NULL) AS has_model, (embedded_at IS NOT NULL) AS has_embedded_at
       FROM code_atoms WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [batch.map((b) => b.id)],
    );
    const meta = new Map(batch.map((b) => [b.id, b]));
    for (const r of rows) {
      const hasText =
        (r.body_len ?? 0) > 0 ||
        r.body_html_len !== null ||
        r.embedding_len !== null ||
        r.has_model ||
        r.has_embedded_at;
      caRows.push({
        id: r.id,
        reasons: meta.get(r.id).reasons,
        hasText,
        cols: {
          body: col(r.body_len, r.body_sha),
          body_html: col(r.body_html_len, r.body_html_sha),
          embedding: col(r.embedding_len, r.embedding_sha),
          metadata: col(r.metadata_len, r.metadata_sha),
          embedding_model_present: r.has_model,
          embedded_at_present: r.has_embedded_at,
        },
      });
    }
  }
  caRows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const byCodeBook = {};
  for (const b of caIcc) byCodeBook[b.book] = (byCodeBook[b.book] ?? 0) + 1;

  // ---- reasoning_atoms
  const raTotal = Number((await client.query("SELECT count(*) AS n FROM reasoning_atoms")).rows[0].n);
  const raScan = (
    await client.query(
      "SELECT id, jurisdiction_key, code_ref, edition_slug, sources FROM reasoning_atoms ORDER BY id",
    )
  ).rows;
  const raIcc = [];
  for (const r of raScan) {
    const reasons = classifyReasoningAtom(c, r);
    if (reasons.length) raIcc.push({ id: r.id, reasons, token: leadToken(r.edition_slug) });
  }
  const raRows = [];
  for (const batch of chunks(raIcc, 500)) {
    const { rows } = await client.query(
      `SELECT id, ${fp("snippet")}, ${fp("reasoning")} FROM reasoning_atoms WHERE id = ANY($1::text[]) ORDER BY id`,
      [batch.map((b) => b.id)],
    );
    const meta = new Map(batch.map((b) => [b.id, b]));
    for (const r of rows) {
      raRows.push({
        id: r.id,
        reasons: meta.get(r.id).reasons,
        hasText: r.snippet_len !== null || r.reasoning_len !== null,
        cols: { snippet: col(r.snippet_len, r.snippet_sha), reasoning: col(r.reasoning_len, r.reasoning_sha) },
      });
    }
  }
  raRows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const byEditionToken = {};
  for (const b of raIcc) byEditionToken[b.token] = (byEditionToken[b.token] ?? 0) + 1;

  const manifest = {
    manifestVersion: 1,
    lane: LANE,
    database,
    classifier: {
      titles: "lib/codes/src/iccTitles.ts isIccTitleAtom (PR #832)",
      source: "lib/icc-notice/src/index.ts isIccSource",
      composition: "artifacts/api-server/src/lib/iccAccess.ts isIccRow",
    },
    tables: {
      code_atoms: {
        total: caTotal,
        iccTotal: caRows.length,
        iccWithText: caRows.filter((r) => r.hasText).length,
        byCodeBook,
        purgeColumns: ["body", "body_html", "embedding", "embedding_model", "embedded_at"],
        rows: caRows,
      },
      reasoning_atoms: {
        total: raTotal,
        iccTotal: raRows.length,
        iccWithText: raRows.filter((r) => r.hasText).length,
        byEditionToken,
        purgeColumns: ["snippet", "reasoning"],
        rows: raRows,
      },
    },
  };
  manifest.manifestHash = computeManifestHash(manifest);
  manifest.generatedAt = new Date().toISOString();
  return manifest;
}

export function totals(m) {
  const t = m.tables;
  return {
    rows: t.code_atoms.total + t.reasoning_atoms.total,
    icc: t.code_atoms.iccTotal + t.reasoning_atoms.iccTotal,
    withText: t.code_atoms.iccWithText + t.reasoning_atoms.iccWithText,
  };
}
