#!/usr/bin/env node
/**
 * P-100 item 1 — the three-state event instrument.
 *
 * WHAT IT ANSWERS. For every GTM event type this operation names, which of
 * FOUR states is it in? Absent, zero, and unmeasured are three different
 * findings and this instrument refuses to merge them; the fourth exists
 * because the store holds types no live writer produces, and calling that
 * "rows" would credit a retired writer.
 *
 *   NO_WRITER          named in a spec list, no emit site in source. ABSENT.
 *   WRITER_NEVER_WROTE emit site exists, zero rows all time. UNMEASURED.
 *   WRITER_HAS_ROWS    emit site exists and rows exist. MEASURED.
 *   ROWS_NO_WRITER     rows exist, no emit site in source. ORPHAN.
 *
 * WHY A FILE AND NOT A SHELL LINE. ENFORCEMENT.md: "a load-bearing claim
 * needs a file-based instrument that has been shown to fail." --self-test
 * runs fixtures including three explicit not-vacuous cases and exits 1 if any
 * classification is wrong. Run it before trusting any output.
 *
 * EXCLUSION SET, which is part of the contract (DEV_PROCESS 2.1):
 *   - __tests__/ directories and *.test.ts / *.test.tsx files are NOT emit
 *     sites. A literal in a test proves a test, not a writer.
 *   - Only the source roots passed on the command line are scanned. A type
 *     emitted from a repo not passed in reads as NO_WRITER, and the output
 *     names the roots so that is visible rather than silent.
 *   - A candidate emit site is a source line matching eventType: with a
 *     string literal, or a member of a declared closed union. Some of those
 *     sites are conditional (a webhook handler returns the type and a caller
 *     records it only when an install id is present); this instrument reports
 *     the SITE, never the reachability. Reachability is a code read.
 *
 * USAGE
 *   node scripts/gtm-event-state.mjs --self-test
 *   node scripts/gtm-event-state.mjs --db "$PGURL" --root artifacts/api-server/src --root <pe-app>/src [--json]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const STATES = {
  NO_WRITER: "NO_WRITER",
  WRITER_NEVER_WROTE: "WRITER_NEVER_WROTE",
  WRITER_HAS_ROWS: "WRITER_HAS_ROWS",
  ROWS_NO_WRITER: "ROWS_NO_WRITER",
  MENTION_ONLY: "MENTION_ONLY",
};

/**
 * Site kinds. Only `emit` and `union` count as a writer, and the distinction
 * is load-bearing: the first pass of this instrument counted every
 * `eventType:` literal as an emit site and so reported
 * `brokerageExtensionPublic.ts:103` as a writer of `brief_completed` when
 * that file only COUNTS those rows for a rate limit. A reader scored as a
 * writer is the same defect class as a check that cannot fail.
 *
 *   emit    inside a recordGtmEvent({...}) call
 *   union   a member of a declared closed event-type list
 *   mention an eventType: literal anywhere else — a reader, a handler result,
 *           a rate-limit key. MENTION_ONLY means: go read the code, this
 *           instrument will not guess reachability for you.
 */
export const SITE_KINDS = { EMIT: "emit", UNION: "union", MENTION: "mention" };

/**
 * The SPEC list: every event type the locked handoff
 * (_inbox/2026-08-10_smartsite_humanless_gtm_handoff.md item 6) names, mapped
 * to the concrete type strings this codebase uses for it. A spec name whose
 * string does not exist in code is still listed, so it classifies NO_WRITER
 * rather than disappearing. This is the ONLY hand-declared input and it is
 * declared because its source is prose, not code.
 */
export const SPEC_EVENT_TYPES = [
  { spec: "browse started", types: ["pe_browse_started"] },
  { spec: "parcel inspected", types: ["pe_parcel_inspected"] },
  { spec: "signup", types: ["pe_signup_intent", "pe_signup_completed"] },
  { spec: "property saved", types: ["pe_save_property"] },
  { spec: "paywall hit", types: ["pe_paywall_hit", "paywall_hit"] },
  { spec: "unlock started", types: ["pe_upgrade_started", "upgrade_started"] },
  {
    spec: "subscription created",
    types: ["pe_subscription_active", "subscription_active", "pe_property_unlock"],
  },
  { spec: "share created", types: ["share_created"] },
  { spec: "share viewed", types: ["share_viewed"] },
  { spec: "churn", types: ["pe_churned", "churned"] },
];

const SOURCE_EXT = new Set([".ts", ".tsx"]);

function isExcluded(path) {
  const p = path.split(sep).join("/");
  return (
    p.includes("/__tests__/") ||
    p.endsWith(".test.ts") ||
    p.endsWith(".test.tsx") ||
    p.includes("/node_modules/")
  );
}

function walk(root, out = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      walk(full, out);
    } else if (SOURCE_EXT.has(name.slice(name.lastIndexOf(".")))) {
      if (!isExcluded(full)) out.push(full);
    }
  }
  return out;
}

/**
 * Derive emit sites from source text. Two shapes are recognised:
 *   eventType: "x"    — a direct emit, or a handler result a caller records
 *   a bare "x" line inside a declared closed union or allowlist array
 * The second is why the union constants (PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES,
 * GTM_MCP_EVENT_TYPES, PeFunnelEventType) are picked up without a hand list.
 */
export function emitSitesFromText(text, label) {
  const sites = [];
  const lines = text.split(/\r?\n/);
  let inUnion = false;
  let emitDepth = 0; // > 0 while inside a recordGtmEvent({ ... }) call
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/EVENT_TYPES\s*=\s*\[/.test(line) || /type\s+\w*FunnelEventType\s*=/.test(line)) {
      inUnion = true;
    }
    if (/recordGtmEvent\(\{/.test(line)) emitDepth = 1;

    const direct = line.match(/eventType:\s*["']([a-z0-9_]+)["']/i);
    if (direct) {
      sites.push({
        eventType: direct[1],
        at: label + ":" + (i + 1),
        via: emitDepth > 0 ? SITE_KINDS.EMIT : SITE_KINDS.MENTION,
      });
    }
    if (emitDepth > 0 && /^\s*\}\)/.test(line)) emitDepth = 0;

    if (inUnion) {
      const member = line.match(/^\s*\|?\s*["']([a-z0-9_]+)["'],?\s*$/i);
      if (member) {
        sites.push({ eventType: member[1], at: label + ":" + (i + 1), via: SITE_KINDS.UNION });
      }
      if (/\]\s*as const/.test(line) || /^\s*$/.test(line)) inUnion = false;
    }
  }
  return sites;
}

/** A type has a writer only when an emit or union site names it. */
export function hasWriter(sites) {
  return sites.some((s) => s.via === SITE_KINDS.EMIT || s.via === SITE_KINDS.UNION);
}

export function scanRoots(roots, cwd = process.cwd()) {
  const byType = new Map();
  for (const root of roots) {
    for (const file of walk(root)) {
      const label = relative(cwd, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      for (const site of emitSitesFromText(text, label)) {
        if (!byType.has(site.eventType)) byType.set(site.eventType, []);
        byType.get(site.eventType).push(site);
      }
    }
  }
  return byType;
}

/**
 * The classifier. codeSites maps eventType -> site[]; storeRows maps
 * eventType -> all-time row count. Absence from storeRows and a zero in
 * storeRows are treated the SAME (both mean no row has ever existed); that
 * collapse is deliberate and is the only one, because "the store has never
 * held this type" is one fact however it is spelled. The three states the
 * card forbids merging are kept apart by the WRITER axis.
 */
export function classify(eventType, codeSites, storeRows) {
  const sites = codeSites.get(eventType) ?? [];
  const rows = storeRows.get(eventType) ?? 0;
  const writer = hasWriter(sites);
  if (!writer && sites.length > 0 && rows === 0) return STATES.MENTION_ONLY;
  if (!writer && sites.length === 0 && rows === 0) return STATES.NO_WRITER;
  if (!writer && rows > 0) return STATES.ROWS_NO_WRITER;
  if (rows === 0) return STATES.WRITER_NEVER_WROTE;
  return STATES.WRITER_HAS_ROWS;
}

// ---------------------------------------------------------------------------
// Self-test. Both directions, per ENFORCEMENT "verify a check by violating it".
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const expect = (name, actual, want) => {
    if (actual !== want) failures.push(name + ": got " + actual + ", want " + want);
  };

  const sites = new Map([
    ["share_created", [{ eventType: "share_created", at: "a.ts:1", via: SITE_KINDS.EMIT }]],
    ["share_viewed", [{ eventType: "share_viewed", at: "b.ts:2", via: SITE_KINDS.EMIT }]],
    // A reader, not a writer. This is the brokerageExtensionPublic.ts shape
    // that the first pass of this instrument scored as an emit site.
    ["brief_failed", [{ eventType: "brief_failed", at: "r.ts:9", via: SITE_KINDS.MENTION }]],
  ]);
  const rows = new Map([
    ["share_created", 7],
    ["radar_autorun", 1],
  ]);

  expect("writer+rows", classify("share_created", sites, rows), STATES.WRITER_HAS_ROWS);
  expect("writer+zero", classify("share_viewed", sites, rows), STATES.WRITER_NEVER_WROTE);
  expect("rows+no writer", classify("radar_autorun", sites, rows), STATES.ROWS_NO_WRITER);
  expect("neither", classify("pe_parcel_inspected", sites, rows), STATES.NO_WRITER);
  expect("mention only", classify("brief_failed", sites, rows), STATES.MENTION_ONLY);

  // NOT VACUOUS 1: the classifier must not answer the same thing for
  // everything. Without this, the expectations above would still pass
  // against a stub that returned a constant for one of them.
  const distinct = new Set([
    classify("share_created", sites, rows),
    classify("share_viewed", sites, rows),
    classify("radar_autorun", sites, rows),
    classify("pe_parcel_inspected", sites, rows),
    classify("brief_failed", sites, rows),
  ]);
  if (distinct.size !== 5) {
    failures.push("not-vacuous-1: only " + distinct.size + " distinct states, want 5");
  }

  // NOT VACUOUS 4: a reader must NOT be scored as a writer. This is the
  // incident fixture: an eventType: literal outside a recordGtmEvent call.
  const readerSites = emitSitesFromText(
    'return {\n  ok: false,\n  eventType: "brief_completed",\n};\n',
    "reader.ts",
  );
  if (readerSites.length !== 1 || readerSites[0].via !== SITE_KINDS.MENTION) {
    failures.push("not-vacuous-4 reader: " + JSON.stringify(readerSites));
  }
  const writerSites = emitSitesFromText(
    'recordGtmEvent({\n  installId,\n  eventType: "brief_completed",\n});\n',
    "writer.ts",
  );
  if (writerSites.length !== 1 || writerSites[0].via !== SITE_KINDS.EMIT) {
    failures.push("not-vacuous-4 writer: " + JSON.stringify(writerSites));
  }

  // NOT VACUOUS 2: the scanner finds a real literal AND does not invent one.
  const found = emitSitesFromText(
    'recordGtmEvent({\n  eventType: "share_created",\n});\n',
    "x.ts",
  );
  if (found.length !== 1 || found[0].eventType !== "share_created" || found[0].at !== "x.ts:2") {
    failures.push("not-vacuous-2 positive: " + JSON.stringify(found));
  }
  const none = emitSitesFromText(
    "const x = 1;\n// eventType is mentioned in prose only\n",
    "y.ts",
  );
  if (none.length !== 0) {
    failures.push("not-vacuous-2 negative: " + JSON.stringify(none));
  }

  // NOT VACUOUS 3: the union reader picks up a closed list, and stops at its end.
  const union = emitSitesFromText(
    'export const PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES = [\n  "pe_browse_started",\n  "pe_save_property",\n] as const;\n\n  "not_a_member",\n',
    "u.ts",
  );
  if (union.length !== 2) {
    failures.push("not-vacuous-3 union reader: " + JSON.stringify(union));
  }

  if (failures.length) {
    console.error("SELF-TEST FAILED");
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED (5 classifier fixtures + 4 not-vacuous cases)");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const STORE_QUERY =
  "SELECT event_type, source_surface, count(*)::bigint AS rows," +
  " min(created_at) AS first_seen, max(created_at) AS last_seen," +
  " count(*) FILTER (WHERE consent_version IS NULL)::bigint AS consent_null" +
  " FROM gtm_events GROUP BY 1,2 ORDER BY 1,2";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const roots = [];
  let db = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") roots.push(argv[++i]);
    else if (argv[i] === "--db") db = argv[++i];
  }
  if (roots.length === 0) {
    console.error("no --root given; refusing to report a scan of nothing");
    process.exit(2);
  }

  const codeSites = scanRoots(roots);
  const storeRows = new Map();
  const surfaces = new Map();
  let snapshot = "UNMEASURED: no --db given";

  if (db) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: db });
    await client.connect();
    const r = await client.query(STORE_QUERY);
    const now = await client.query("SELECT now() AS t, current_database() AS d");
    snapshot = "db=" + now.rows[0].d + " at=" + now.rows[0].t.toISOString();
    for (const row of r.rows) {
      const n = Number(row.rows);
      storeRows.set(row.event_type, (storeRows.get(row.event_type) ?? 0) + n);
      if (!surfaces.has(row.event_type)) surfaces.set(row.event_type, []);
      surfaces.get(row.event_type).push({
        surface: row.source_surface,
        rows: n,
        consentNull: Number(row.consent_null),
        lastSeen: row.last_seen,
      });
    }
    await client.end();
  }

  const all = new Set([...codeSites.keys(), ...storeRows.keys()]);
  for (const g of SPEC_EVENT_TYPES) for (const t of g.types) all.add(t);

  const table = [...all].sort().map((eventType) => ({
    eventType,
    state: db ? classify(eventType, codeSites, storeRows) : "UNMEASURED_NO_DB",
    rowsAllTime: db ? storeRows.get(eventType) ?? 0 : null,
    surfaces: surfaces.get(eventType) ?? [],
    writerSites: (codeSites.get(eventType) ?? []).filter((s) => s.via !== SITE_KINDS.MENTION).map((s) => s.at + " [" + s.via + "]"),
    mentionSites: (codeSites.get(eventType) ?? []).filter((s) => s.via === SITE_KINDS.MENTION).map((s) => s.at),
    spec: SPEC_EVENT_TYPES.filter((g) => g.types.includes(eventType)).map((g) => g.spec),
  }));

  const out = {
    snapshot,
    roots,
    query: STORE_QUERY,
    exclusions: ["__tests__/", "*.test.ts", "*.test.tsx", "node_modules/", "dist/"],
    table,
  };
  if (argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log("snapshot: " + snapshot);
  console.log("roots: " + roots.join(", "));
  console.log("");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("event_type", 26) + " " + pad("state", 20) + " " + pad("rows", 7) + " emit sites");
  for (const r of table) {
    console.log(
      pad(r.eventType, 26) +
        " " +
        pad(r.state, 20) +
        " " +
        pad(r.rowsAllTime ?? "-", 7) +
        " " +
        (r.writerSites.slice(0, 2).join(", ") || (r.mentionSites.length ? "mention: " + r.mentionSites[0] : "(none)")),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
