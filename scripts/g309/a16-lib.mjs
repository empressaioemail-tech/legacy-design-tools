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
 * and the shared classifier #847 exports from lib/codes/src/iccTitles.ts:
 *   isIccRow (code_atoms)   isIccReasoningRow (reasoning_atoms)
 * the same functions the ingest guard and the reader call. They are loaded with
 * the repo's tsx (tsImport) so their imports resolve; Node 20 compatible.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// The repo's own TypeScript loader (tsx, a lib/db devDependency), so
// lib/codes/src/iccTitles.ts loads WITH its imports (@workspace/icc-notice)
// resolved by the workspace, one definition shared with the ingest guard and
// the reader. Works on Node 18+ (CI is Node 20).
const { tsImport } = createRequire(path.join(REPO, "lib/db/package.json"))("tsx/esm/api");

let classifierPromise;
export function loadClassifier() {
  classifierPromise ??= (async () => {
    const titles = await tsImport(
      pathToFileURL(path.join(REPO, "lib/codes/src/iccTitles.ts")).href,
      import.meta.url,
    );
    const notice = await tsImport(
      pathToFileURL(path.join(REPO, "lib/icc-notice/src/index.ts")).href,
      import.meta.url,
    );
    return {
      isIccRow: titles.isIccRow,
      isIccReasoningRow: titles.isIccReasoningRow,
      isIccTitleAtom: titles.isIccTitleAtom,
      isIccSource: notice.isIccSource,
    };
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
  // The shared rule is the verdict; reasons only say which half fired.
  const shared = c.isIccRow({
    sourceUrl: r.source_url,
    jurisdictionKey: r.jurisdiction_key,
    sourceName: r.source_name,
    codeBook: r.code_book,
    sectionNumber: r.section_number,
  });
  if (shared !== reasons.length > 0) throw new Error("classifier drift: isIccRow disagrees with its parts");
  return reasons;
}

/**
 * reasoning_atoms row -> class. There is no code-book column; the row's real
 * code-book field is `edition`, which every writer sets to "<code> <edition>"
 * (lib/codewarm/src/targets.ts manifestEntryToTarget: `${entry.code} ${entry.edition}`,
 * e.g. "IBC 2021", "FBC 2023", "TAS 2012"). Two disjoint classes:
 *   icc-title        edition (as codeBook) or jurisdiction_key is an ICC title (isIccTitleAtom),
 *                    or the jurisdiction is icc-model-code (isIccSource).
 *   icc-source-link  edition is NOT an ICC title, but a sources[] link is ICC
 *                    (isIccSource, as reasoningAtomToCodeSection judges it). TAS, FBC, FBCEB
 *                    and A117.1 rows that were fetched via an iccsafe.org link land here.
 * edition_slug and code_ref are NOT used as code-book or section signals; whether
 * code_ref alone would have matched is returned as `codeRefOnlyTitle` (a diagnostic,
 * never purged).
 */
export function classifyReasoningAtom(c, r) {
  const sources = Array.isArray(r.sources) ? r.sources : [];
  const title = c.isIccRow({ codeBook: r.edition, jurisdictionKey: r.jurisdiction_key });
  const link = sources.some((s) => c.isIccRow({ sourceUrl: s?.url, sourceName: s?.sourceName }));
  // The shared rule (isIccReasoningRow) is the verdict; title/link only name the class.
  if (c.isIccReasoningRow({ edition: r.edition, jurisdictionKey: r.jurisdiction_key, sources }) !== (title || link)) {
    throw new Error("classifier drift: isIccReasoningRow disagrees with its parts");
  }
  const cls = title ? "icc-title" : link ? "icc-source-link" : null;
  const codeRefOnlyTitle =
    !cls && c.isIccTitleAtom({ sectionNumber: r.code_ref, codeBook: r.edition_slug });
  return { cls, codeRefOnlyTitle, sourceAlso: title && link };
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
const REASONING_COLS = ["snippet", "reasoning", "sources", "code_ref", "edition", "edition_slug"];

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
      "SELECT id, jurisdiction_key, code_ref, edition, edition_slug, sources FROM reasoning_atoms ORDER BY id",
    )
  ).rows;
  const raIcc = [];
  let codeRefOnlyTitle = 0;
  for (const r of raScan) {
    const k = classifyReasoningAtom(c, r);
    if (k.codeRefOnlyTitle) codeRefOnlyTitle++;
    if (k.cls) raIcc.push({ id: r.id, cls: k.cls, jur: r.jurisdiction_key, token: leadToken(r.edition) });
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
        class: meta.get(r.id).cls,
        hasText: r.snippet_len !== null || r.reasoning_len !== null,
        cols: { snippet: col(r.snippet_len, r.snippet_sha), reasoning: col(r.reasoning_len, r.reasoning_sha) },
      });
    }
  }
  raRows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const byEditionToken = {};
  const bump = (o, k) => (o[k] = (o[k] ?? 0) + 1);
  const breakdown = { byClass: {}, byTextShape: {}, byClassAndShape: {}, byJurisdiction: {}, byClassAndEditionToken: {} };
  const meta = new Map(raIcc.map((b) => [b.id, b]));
  for (const b of raIcc) bump(byEditionToken, b.token);
  for (const r of raRows) {
    const m = meta.get(r.id);
    const sn = r.cols.snippet.len !== null;
    const re = r.cols.reasoning.len !== null;
    const shape = sn && re ? "both" : sn ? "snippet-only" : re ? "reasoning-only" : "none";
    bump(breakdown.byClass, r.class);
    bump(breakdown.byTextShape, shape);
    bump(breakdown.byClassAndShape, `${r.class}|${shape}`);
    bump(breakdown.byJurisdiction, m.jur);
    bump(breakdown.byClassAndEditionToken, `${r.class}|${m.token}`);
  }

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
        breakdown,
        codeRefOnlyTitleNotPurged: codeRefOnlyTitle,
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

/** reasoning_atoms purge scope: which text columns and which ICC classes an apply may touch. */
export const REASONING_CLASSES = ["icc-title", "icc-source-link"];
export function parseScope(scopeArg, classesArg) {
  const cols = (scopeArg ?? "snippet").split(",").map((x) => x.trim());
  if (!cols.length || cols.some((c) => c !== "snippet" && c !== "reasoning") || !cols.includes("snippet")) {
    throw new Error('--scope must be "snippet" or "snippet,reasoning"');
  }
  const classes = (classesArg ?? REASONING_CLASSES.join(",")).split(",").map((x) => x.trim());
  if (!classes.length || classes.some((c) => !REASONING_CLASSES.includes(c))) {
    throw new Error(`--classes must be a list of: ${REASONING_CLASSES.join(", ")}`);
  }
  return { columns: [...new Set(cols)], classes: [...new Set(classes)] };
}
/** True when a manifest reasoning row holds text in a column this scope would purge. */
export function reasoningRowInScopeWithText(row, scope) {
  if (!scope.classes.includes(row.class)) return false;
  return (
    row.cols.snippet.len !== null || (scope.columns.includes("reasoning") && row.cols.reasoning.len !== null)
  );
}
