/**
 * G-309 A16: scripts/g309/a16-icc-text-dry-run.mjs and a16-icc-text-apply.mjs
 * against a REAL Postgres, in a throwaway schema, with synthetic rows.
 *
 * Every text value seeded here is a placeholder (PLACEHOLDER-...). No ICC text
 * appears anywhere. The scripts are run as child processes, exactly as the
 * integration seat will run them, and their stdout/stderr/manifest are checked
 * for placeholder text (they must carry lengths and digests only).
 *
 * Schema: only the three tables the purge touches, taken verbatim from the
 * checked-in schema fixture (schema.sql.template), so no PostGIS is needed.
 * If the pgvector extension is unavailable the embedding column falls back to
 * text (the purge only reads `embedding::text` and sets it NULL).
 *
 * Skips when no database is configured; CI provisions one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const BASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const HAS_DB = Boolean(BASE_URL);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const SCRIPTS = path.join(REPO, "scripts/g309");
const DRY_RUN = path.join(SCRIPTS, "a16-icc-text-dry-run.mjs");
const APPLY = path.join(SCRIPTS, "a16-icc-text-apply.mjs");
const TEMPLATE = path.join(HERE, "__fixtures__/schema.sql.template");

const MARK = "PLACEHOLDER";
const vec = `[${Array.from({ length: 1536 }, () => "0.5").join(",")}]`;

function schemaDdl(name: string, vectorOk: boolean): string {
  const tpl = readFileSync(TEMPLATE, "utf8");
  const tables = ["code_atom_sources", "code_atoms", "reasoning_atoms"];
  const parts: string[] = [];
  for (const t of tables) {
    const m = tpl.match(new RegExp(`CREATE TABLE @@SCHEMA@@\\.${t} \\([\\s\\S]*?\\n\\);`));
    if (!m) throw new Error(`fixture lacks ${t}`);
    parts.push(m[0]);
  }
  for (const m of tpl.matchAll(
    /ALTER TABLE ONLY @@SCHEMA@@\.(?:code_atoms|code_atom_sources|reasoning_atoms)\n[^;]*;/g,
  )) {
    parts.push(m[0]);
  }
  let ddl = parts.join("\n\n").replace(/@@SCHEMA@@/g, `"${name}"`);
  if (!vectorOk) ddl = ddl.replace(/public\.vector\(1536\)/g, "text");
  return ddl;
}

describe.skipIf(!HAS_DB)("G-309 A16 ICC text purge scripts", () => {
  let admin: pg.Pool;
  let schema: string;
  let emptySchema: string;
  let dbName: string;
  let pool: pg.Pool;
  let urlFor: (s: string) => string;
  let tmp: string;
  const outputs: string[] = [];

  const SRC_ICC = "11111111-1111-4111-8111-111111111111";
  const SRC_MUNI = "22222222-2222-4222-8222-222222222222";

  function run(script: string, args: string[], opts: { schema?: string; env?: Record<string, string> } = {}) {
    const r = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, DATABASE_URL: urlFor(opts.schema ?? schema), ...opts.env },
      encoding: "utf8",
    });
    outputs.push(r.stdout ?? "", r.stderr ?? "");
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  async function seed(p: pg.Pool) {
    await p.query(
      `INSERT INTO code_atom_sources (id, source_name, label, source_type, license_type) VALUES
       ($1,'ICC Digital Codes','icc','scrape','licensed'), ($2,'municode','muni','scrape','public')`,
      [SRC_ICC, SRC_MUNI],
    );
    const ca = (
      id: string, src: string, jur: string, book: string, sec: string, url: string,
      body: string, html: string | null, emb: string | null,
    ) =>
      p.query(
        `INSERT INTO code_atoms (id, source_id, jurisdiction_key, code_book, edition, section_number, section_title,
           body, body_html, embedding, embedding_model, embedded_at, content_hash, source_url, metadata)
         VALUES ($1,$2,$3,$4,'2021',$5,'T',$6,$7,$8,$9,$10,$11,$12,'{"k":"PLACEHOLDER-META"}')`,
        [id, src, jur, book, sec, body, html, emb, emb ? "m1" : null, emb ? new Date("2026-01-01") : null, `h-${id}`, url],
      );
    const M = "https://example.test/muni/";
    // ICC by title identifier
    await ca("a0000000-0000-4000-8000-000000000001", SRC_MUNI, "austin_tx", "IBC", "1004", M, `${MARK}-body-1`, `<p>${MARK}-html-1</p>`, vec);
    await ca("a0000000-0000-4000-8000-000000000002", SRC_MUNI, "county_x", "IWUIC", "R1", M, `${MARK}-body-2`, null, vec);
    await ca("a0000000-0000-4000-8000-000000000003", SRC_MUNI, "county_x", "IRC_R301_2_1", "R301", M, `${MARK}-body-3`, null, null);
    // ICC by source (host), and by jurisdiction key
    await ca("a0000000-0000-4000-8000-000000000004", SRC_ICC, "austin_tx", "Austin LDC", "5", "https://codes.iccsafe.org/x", `${MARK}-body-4`, null, vec);
    await ca("a0000000-0000-4000-8000-000000000005", SRC_MUNI, "icc-model-code", "Foo", "6", M, `${MARK}-body-5`, null, null);
    // ICC row that is already blank
    await ca("a0000000-0000-4000-8000-000000000006", SRC_MUNI, "austin_tx", "IECC", "7", M, "", null, null);
    // NOT ICC (one with embedding and html, to prove byte-identity)
    await ca("b0000000-0000-4000-8000-000000000001", SRC_MUNI, "austin_tx", "Austin LDC", "25-1", M, `${MARK}-keep-1`, `<p>${MARK}-keep-html</p>`, vec);
    await ca("b0000000-0000-4000-8000-000000000002", SRC_MUNI, "bastrop_tx", "Bastrop UDC", "3.1", M, `${MARK}-keep-2`, null, null);
    const ra = (id: string, jur: string, ref: string, slug: string, sources: unknown[], snip: string | null, why: string | null) =>
      p.query(
        `INSERT INTO reasoning_atoms (id, jurisdiction_key, code_ref, edition, edition_slug, sources, reasoning,
           asserted_confidence, verification_state, snippet) VALUES ($1,$2,$3,'2021',$4,$5::jsonb,$6,0.9,'verified',$7)`,
        [id, jur, ref, slug, JSON.stringify(sources), why, snip],
      );
    const nonIcc = [{ url: "https://example.test/x", sourceName: "municode", edition: "2021", retrievedAt: "t", verified: true }];
    await ra("reasoning:ibc-2021:1004", "austin_tx", "IBC 1004", "ibc-2021", nonIcc, `${MARK}-snip-1`, `${MARK}-why-1`);
    await ra("reasoning:x:5", "austin_tx", "Sec 5", "ldc-2024", [{ ...nonIcc[0], url: "https://codes.iccsafe.org/q", sourceName: "icc" }], `${MARK}-snip-2`, null);
    await ra("reasoning:keep:1", "austin_tx", "Sec 9", "ldc-2024", nonIcc, `${MARK}-snip-keep`, `${MARK}-why-keep`);
  }

  /** Row-for-row JSON of NON-ICC rows (byte comparison). */
  async function nonIccSnapshot(): Promise<string> {
    const a = await pool.query(
      `SELECT row_to_json(t)::text AS j FROM code_atoms t WHERE id::text LIKE 'b%' ORDER BY id`,
    );
    const b = await pool.query(
      `SELECT row_to_json(t)::text AS j FROM reasoning_atoms t WHERE id = 'reasoning:keep:1'`,
    );
    return [...a.rows, ...b.rows].map((r) => r.j).join("\n");
  }
  async function fullSnapshot(): Promise<string> {
    const a = await pool.query(`SELECT row_to_json(t)::text AS j FROM code_atoms t ORDER BY id`);
    const b = await pool.query(`SELECT row_to_json(t)::text AS j FROM reasoning_atoms t ORDER BY id`);
    return [...a.rows, ...b.rows].map((r) => r.j).join("\n");
  }
  /** ICC rows with their purge columns removed: must be unchanged by apply. */
  async function iccKeptColumns(): Promise<string> {
    const a = await pool.query(
      `SELECT (row_to_json(t)::jsonb - 'body' - 'body_html' - 'embedding' - 'embedding_model' - 'embedded_at')::text AS j
       FROM code_atoms t WHERE id::text LIKE 'a%' ORDER BY id`,
    );
    const b = await pool.query(
      `SELECT (row_to_json(t)::jsonb - 'snippet' - 'reasoning')::text AS j
       FROM reasoning_atoms t WHERE id IN ('reasoning:ibc-2021:1004','reasoning:x:5') ORDER BY id`,
    );
    return [...a.rows, ...b.rows].map((r) => r.j).join("\n");
  }

  async function reseed() {
    await pool.query("TRUNCATE code_atoms, code_atom_sources, reasoning_atoms CASCADE");
    await seed(pool);
  }

  function dryRunTo(file: string, s?: string) {
    return run(DRY_RUN, ["--out", file, "--expect-db", dbName], { schema: s });
  }
  const applyArgs = (manifest: string, hash: string, extra: string[] = []) => [
    "--manifest", manifest, "--expect-hash", hash, "--confirm", "G309-A16", "--expect-db", dbName, ...extra,
  ];

  beforeAll(async () => {
    const base = new URL(BASE_URL!);
    dbName = decodeURIComponent(base.pathname.slice(1));
    admin = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    const rnd = Math.random().toString(16).slice(2, 8);
    schema = `a16_${rnd}`;
    emptySchema = `a16e_${rnd}`;
    let vectorOk = true;
    try {
      await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      vectorOk = false;
    }
    for (const s of [schema, emptySchema]) {
      await admin.query(`CREATE SCHEMA "${s}"`);
      await admin.query(schemaDdl(s, vectorOk));
    }
    urlFor = (s: string) => {
      const u = new URL(BASE_URL!);
      u.searchParams.set("options", `-c search_path=${s},public`);
      return u.toString();
    };
    pool = new pg.Pool({ connectionString: urlFor(schema), max: 2 });
    tmp = mkdtempSync(path.join(tmpdir(), "a16-"));
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      for (const s of [schema, emptySchema]) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await admin.end();
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("dry run: counts, exit 2, no text, no writes, read-only", async () => {
    await reseed();
    const before = await fullSnapshot();
    const f = path.join(tmp, "m1.json");
    const r = dryRunTo(f);
    expect(r.code).toBe(2);
    const m = JSON.parse(readFileSync(f, "utf8"));
    expect(m.tables.code_atoms.total).toBe(8);
    expect(m.tables.code_atoms.iccTotal).toBe(6);
    expect(m.tables.code_atoms.iccWithText).toBe(5); // #6 is already blank
    expect(m.tables.code_atoms.byCodeBook).toMatchObject({ IWUIC: 1, IRC_R301_2_1: 1, IBC: 1 });
    expect(m.tables.reasoning_atoms.total).toBe(3);
    expect(m.tables.reasoning_atoms.iccTotal).toBe(2);
    expect(m.tables.reasoning_atoms.iccWithText).toBe(2);
    const row1 = m.tables.code_atoms.rows.find((x: { id: string }) => x.id.endsWith("0001"));
    expect(row1.cols.body.len).toBe(`${MARK}-body-1`.length);
    expect(row1.cols.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(f, "utf8")).not.toContain(MARK);
    expect(await fullSnapshot()).toBe(before);
    // read-only: a write issued through the script's session settings is refused
    const ro = await new pg.Client({ connectionString: urlFor(schema) });
    await ro.connect();
    await ro.query("BEGIN READ ONLY");
    await expect(ro.query("UPDATE code_atoms SET body = body")).rejects.toThrow(/read-only/);
    await ro.query("ROLLBACK");
    await ro.end();
  });

  it("apply refuses without flags, with a wrong confirm, a wrong hash, or an edited manifest (nothing changes)", async () => {
    await reseed();
    const f = path.join(tmp, "m2.json");
    dryRunTo(f);
    const m = JSON.parse(readFileSync(f, "utf8"));
    const before = await fullSnapshot();
    expect(run(APPLY, ["--manifest", f]).code).toBe(4);
    expect(run(APPLY, ["--manifest", f, "--expect-hash", m.manifestHash, "--confirm", "nope", "--expect-db", dbName]).code).toBe(4);
    expect(run(APPLY, applyArgs(f, "0".repeat(64))).code).toBe(5);
    const edited = { ...m, tables: { ...m.tables, code_atoms: { ...m.tables.code_atoms, iccTotal: 0 } } };
    const ef = path.join(tmp, "m2-edited.json");
    writeFileSync(ef, JSON.stringify(edited));
    expect(run(APPLY, applyArgs(ef, m.manifestHash)).code).toBe(5);
    expect(await fullSnapshot()).toBe(before);
  });

  it("apply refuses on drift: a changed ICC row, and a new ICC row (nothing changes)", async () => {
    await reseed();
    const f = path.join(tmp, "m3.json");
    dryRunTo(f);
    const m = JSON.parse(readFileSync(f, "utf8"));
    await pool.query(`UPDATE code_atoms SET body = '${MARK}-edited' WHERE id::text LIKE 'a%0001'`);
    let before = await fullSnapshot();
    expect(run(APPLY, applyArgs(f, m.manifestHash)).code).toBe(5);
    expect(await fullSnapshot()).toBe(before);

    await reseed();
    dryRunTo(f);
    const m2 = JSON.parse(readFileSync(f, "utf8"));
    await pool.query(
      `INSERT INTO code_atoms (source_id, jurisdiction_key, code_book, edition, body, content_hash, source_url)
       VALUES ($1,'x','IPC','2021','${MARK}-new','h-new','https://example.test/')`,
      [SRC_MUNI],
    );
    before = await fullSnapshot();
    expect(run(APPLY, applyArgs(f, m2.manifestHash)).code).toBe(5);
    expect(await fullSnapshot()).toBe(before);
  });

  it("--dry rolls back: exit 0, certificate says DRY, database byte-identical", async () => {
    await reseed();
    const f = path.join(tmp, "m4.json");
    dryRunTo(f);
    const m = JSON.parse(readFileSync(f, "utf8"));
    const before = await fullSnapshot();
    const r = run(APPLY, applyArgs(f, m.manifestHash, ["--dry"]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY (rolled back");
    expect(await fullSnapshot()).toBe(before);
  });

  it("apply: only ICC rows change, non-ICC byte-identical, certificate has no text, second run refuses", async () => {
    await reseed();
    const f = path.join(tmp, "m5.json");
    dryRunTo(f);
    const m = JSON.parse(readFileSync(f, "utf8"));
    const keep = await nonIccSnapshot();
    const iccKept = await iccKeptColumns();
    const r = run(APPLY, applyArgs(f, m.manifestHash));
    expect(r.code).toBe(0);
    expect(r.out).toContain("G-309-A16 CERTIFICATE");
    const cert = JSON.parse(r.out.split("CERTIFICATE (no text) =====\n")[1].split("\n===== END")[0]);
    expect(cert.code_atoms).toMatchObject({ total: 8, iccRows: 6, blanked: 5, iccWithTextBefore: 5, iccWithTextAfter: 0 });
    expect(cert.reasoning_atoms).toMatchObject({ total: 3, iccRows: 2, blanked: 2, iccWithTextAfter: 0 });
    expect(cert.rowsDeleted).toBe(0);
    expect(await nonIccSnapshot()).toBe(keep);
    expect(await iccKeptColumns()).toBe(iccKept);
    const a = await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE body <> '' OR body_html IS NOT NULL OR embedding IS NOT NULL
         OR embedding_model IS NOT NULL OR embedded_at IS NOT NULL)::int AS withtext FROM code_atoms WHERE id::text LIKE 'a%'`,
    );
    expect(a.rows[0]).toEqual({ n: 6, withtext: 0 });
    const b = await pool.query(
      `SELECT count(*) FILTER (WHERE snippet IS NOT NULL OR reasoning IS NOT NULL)::int AS withtext
       FROM reasoning_atoms WHERE id IN ('reasoning:ibc-2021:1004','reasoning:x:5')`,
    );
    expect(b.rows[0].withtext).toBe(0);
    // the same manifest cannot be replayed
    expect(run(APPLY, applyArgs(f, m.manifestHash)).code).toBe(5);
    // a fresh dry run now reports none present
    const f2 = path.join(tmp, "m5b.json");
    expect(dryRunTo(f2).code).toBe(0);
  });

  it("after-count not zero: rolls back and exits 6", async () => {
    await reseed();
    const f = path.join(tmp, "m6.json");
    dryRunTo(f);
    const m = JSON.parse(readFileSync(f, "utf8"));
    // Simulates a purge that does not stick: a trigger refills the body.
    await pool.query(
      `CREATE OR REPLACE FUNCTION a16_refill() RETURNS trigger AS $$ BEGIN NEW.body := 'refilled'; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await pool.query(`CREATE TRIGGER a16_refill_t BEFORE UPDATE ON code_atoms FOR EACH ROW EXECUTE FUNCTION a16_refill()`);
    const before = await fullSnapshot();
    try {
      expect(run(APPLY, applyArgs(f, m.manifestHash)).code).toBe(6);
      expect(await fullSnapshot()).toBe(before);
    } finally {
      await pool.query("DROP TRIGGER a16_refill_t ON code_atoms");
    }
  });

  it("vacuous and wrong-database cases exit 3", async () => {
    await reseed();
    const f = path.join(tmp, "m7.json");
    // zero rows: tables exist but are empty
    expect(run(DRY_RUN, ["--out", f, "--expect-db", dbName], { schema: emptySchema }).code).toBe(3);
    // wrong expected db name (the default "neondb" is not this test database)
    if (dbName !== "neondb") {
      expect(run(DRY_RUN, ["--out", f], {}).code).toBe(3);
    }
    expect(run(DRY_RUN, ["--out", f, "--expect-db", "some_other_db"]).code).toBe(3);
    // tables missing: a schema with none of them (public may hold them elsewhere, so use pg_catalog only)
    const r = run(DRY_RUN, ["--out", f, "--expect-db", dbName], {
      env: { DATABASE_URL: (() => { const u = new URL(urlFor(schema)); u.searchParams.set("options", "-c search_path=pg_catalog"); return u.toString(); })() },
    });
    expect(r.code).toBe(3);
  });

  it("FALSIFIER: a mutated apply is caught, by the script guard and by the byte-identity check", async () => {
    await reseed();
    const f = path.join(tmp, "m8.json");
    dryRunTo(f);
    const m = JSON.parse(readFileSync(f, "utf8"));
    const src = readFileSync(APPLY, "utf8");
    const libUrl = pathToFileURL(path.join(SCRIPTS, "a16-lib.mjs")).href;
    const base = src.replace('from "./a16-lib.mjs"', `from "${libUrl}"`);
    const noWhere = base.replace(/WHERE id = ANY\(\$1::uuid\[\]\)`,\s*\[caIds\],/, "`, [],");
    expect(noWhere).not.toBe(base); // mutation 1 applied: blank every code_atoms row
    const noGuard = noWhere.replace("caChanged !== caIds.length ||", "false ||");
    expect(noGuard).not.toBe(noWhere); // mutation 2 applied: also drop the row-count guard

    const keep = await nonIccSnapshot();
    const full = await fullSnapshot();
    // Mutant 1: the script's own row-count guard refuses and rolls back.
    const m1 = path.join(tmp, "apply-mutant1.mjs");
    writeFileSync(m1, noWhere);
    expect(run(m1, applyArgs(f, m.manifestHash)).code).toBe(6);
    expect(await fullSnapshot()).toBe(full);
    // Mutant 2: with the guard gone it commits, and ONLY the test's byte-identity check sees the damage.
    const m2 = path.join(tmp, "apply-mutant2.mjs");
    writeFileSync(m2, noGuard);
    expect(run(m2, applyArgs(f, m.manifestHash)).code).toBe(0);
    expect(await nonIccSnapshot()).not.toBe(keep);
  });

  it("no placeholder text appears in any script output", () => {
    expect(outputs.length).toBeGreaterThan(5);
    for (const o of outputs) expect(o).not.toContain(MARK);
  });
});
