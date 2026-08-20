#!/usr/bin/env node
/**
 * BOOT-GRAPH IMPORT GUARD — no module reachable from the server entrypoint may
 * statically import a `*Cli` module.
 *
 * WHY THIS EXISTS. On 2026-08-19 a canary deploy of `5688aa31` failed to
 * listen on PORT. `routes/index.ts` imported `countyRailScoreRouter`, which
 * imported the `lib/railScoring` barrel, which re-exported `engine.ts`, which
 * imported `countyCoverageScoreCli.ts`. CLI modules in this repo carry an
 * `isDirectRun()` entrypoint guard, and that guard does not survive bundling:
 * esbuild folds everything into `dist/index.mjs`, so `import.meta.url` inside
 * the bundle IS the bundle's own URL and `argv[1]` is the same path. The guard
 * read TRUE at server boot and the CLI's `main()` exited the process before
 * Express listened.
 *
 * This had already happened once. `src/lib/nodeFacetTier2Constants.ts` exists
 * because "a misfire ran the bake at server boot and process.exit(1)'d before
 * the server could listen". The rule was written down, in a comment, in one
 * file's header, and the next capability reintroduced the same shape through a
 * different import. Prose does not enforce. This does.
 *
 * WHY A GRAPH WALK AND NOT A GREP. The live defect did not appear in
 * `routes/` at all — the CLI was three hops away behind a barrel re-export. A
 * grep over the route directory would have been green through the entire
 * outage. Re-export through an intermediate module is the obvious bypass of a
 * grep, so this control does not have it: it walks the actual static import
 * graph from `src/index.ts` and reports the full path to any CLI it reaches.
 *
 * THIS IS TOOLING, SO IT FAILS LOUD, NOT CLOSED (61_enforcement_doctrine).
 *
 *   exit 0   RESULT=clean           no CLI module is reachable
 *   exit 1   RESULT=violation       a CLI module is reachable; the path is printed
 *   exit 2   RESULT=did-not-run     the INSTRUMENT could not answer
 *
 * SELF-TEST FIRST, IN BOTH DIRECTIONS. Before any verdict on the real tree is
 * trusted, the walker runs over a fixture tree that DOES reach a CLI through a
 * barrel re-export (must be flagged) and one that does not (must be clean).
 * Either failing reports DID-NOT-RUN rather than a verdict.
 *
 * SCOPE, STATED AT THE SCOPE OF THE ENFORCEMENT RATHER THAN THE INTENT:
 *
 *   FOLLOWED     static `import ... from` and `export ... from` with a
 *                RELATIVE specifier, including bare side-effect `import "./x"`.
 *   NOT FOLLOWED `import type` / `export type` statements, because TypeScript
 *                and esbuild erase them and they create no runtime edge.
 *   NOT FOLLOWED bare specifiers (`@workspace/*`, npm packages). A CLI reached
 *                through a workspace package would be missed. Measured
 *                2026-08-19: all 13 `*Cli.ts` files in this repo live under
 *                `artifacts/api-server/src/`, and there are none in any
 *                workspace package, so that gap is currently empty. It is a
 *                gap, not a guarantee, and it reopens the moment a `*Cli.ts`
 *                lands in `lib/`.
 *   NOT FOLLOWED dynamic `await import(...)`. That is deliberate: it is the
 *                sanctioned escape hatch (see `countyRailScoreCli.ts`), because
 *                a dynamic import does not evaluate at module load and so
 *                cannot exit the process during boot.
 *
 * KNOWN OVER-APPROXIMATION: an inline `import { type X } from "./fooCli"` is
 * erased by esbuild but is flagged here, because distinguishing it needs a
 * real TS parser. It errs toward flagging and the remedy — writing
 * `import type` — is the correct form anyway.
 *
 * Usage:
 *   node artifacts/api-server/scripts/checkBootGraphNoCliImports.mjs
 *   node artifacts/api-server/scripts/checkBootGraphNoCliImports.mjs --root <entry.ts>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GATE_ID = "ci-boot-graph-no-cli-import";

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_DID_NOT_RUN = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(API_SERVER_DIR, "..", "..");

/** A module counts as a CLI when its filename ends in `Cli` before the extension. */
const CLI_PATTERN = /Cli\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Relative specifiers with these extensions are data, not code, and end the walk. */
const NON_CODE_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".scss",
  ".svg",
  ".png",
  ".jpg",
  ".sql",
  ".wasm",
  ".txt",
  ".md",
  ".html",
]);

function didNotRun(message) {
  console.error(`GATE-DID-NOT-RUN ${GATE_ID}: ${message}`);
  console.error("RESULT=did-not-run");
  process.exit(EXIT_DID_NOT_RUN);
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i += 1;
      } else {
        out[a.slice(2)] = "true";
      }
    }
  }
  return out;
}

/**
 * Blank out comments and string/template bodies, preserving offsets and
 * newlines so the import regex below can never match a module's own
 * documentation.
 *
 * This is not fussiness. `lib/railScoring/engine.ts` documents in its header
 * the very import this gate forbids, and `pr-checks.yml` already carries two
 * greps whose comments record that matching your own documentation makes a
 * gate permanently red — a dead gate, which enforces nothing.
 *
 * String bodies are blanked too, so a specifier is only ever read from the
 * quote characters this scanner itself identified.
 */
function maskCommentsAndStrings(src) {
  const out = Array.from(src);
  const n = src.length;
  let i = 0;
  // Quote positions are preserved; only the BODY between them is blanked, so
  // the import regex still sees `from "..."` with a readable specifier.
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        if (quote === "`" && src[j] === "$" && src[j + 1] === "{") {
          // Template expressions can contain anything, including quotes. The
          // scanner does not try to parse them; it blanks to the closing
          // backtick and accepts that a specifier inside a template literal is
          // not readable — which is correct, because a computed specifier is
          // not a static import.
        }
        j += 1;
      }
      // Leave the quotes, blank the body.
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Extract the static, runtime-bearing relative import specifiers of a file.
 *
 * The specifier text is read from the ORIGINAL source at the offsets the masked
 * scan identified, because the mask blanks string bodies.
 */
function staticImportSpecifiers(src) {
  const masked = maskCommentsAndStrings(src);
  const specs = [];

  // `import ... from "x"` and `export ... from "x"`, clause may span lines.
  const fromRe =
    /^[ \t]*(import|export)\b((?:(?!\bfrom\b)[\s\S])*?)\bfrom[ \t]*(['"])/gm;
  let m;
  while ((m = fromRe.exec(masked)) !== null) {
    const clause = m[2];
    if (/^\s*type\b/.test(clause)) continue; // erased at build; no runtime edge
    const quote = m[3];
    const start = m.index + m[0].length;
    const end = src.indexOf(quote, start);
    if (end === -1) continue;
    specs.push(src.slice(start, end));
  }

  // Bare side-effect import: `import "x";`
  const bareRe = /^[ \t]*import[ \t]*(['"])/gm;
  while ((m = bareRe.exec(masked)) !== null) {
    const quote = m[1];
    const start = m.index + m[0].length;
    const end = src.indexOf(quote, start);
    if (end === -1) continue;
    specs.push(src.slice(start, end));
  }

  return specs;
}

/** Resolve a relative specifier to a file on disk, or null. */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [];
  // An explicit `.js`/`.mjs` specifier in TS source means the sibling TS file.
  if (/\.m?js$/.test(base)) {
    candidates.push(base.replace(/\.m?js$/, ".ts"));
    candidates.push(base.replace(/\.m?js$/, ".tsx"));
  }
  candidates.push(
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  );
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Walk the static import graph from `root`.
 *
 * Returns { visited: Map<file, parentFile|null>, violations: [file] }.
 * Throws an Error tagged `instrument` when it cannot answer, which the caller
 * turns into DID-NOT-RUN rather than into a verdict.
 */
function walk(root) {
  if (!fs.existsSync(root)) {
    const e = new Error(`root entry ${root} does not exist`);
    e.instrument = true;
    throw e;
  }
  const parent = new Map([[root, null]]);
  const queue = [root];
  const violations = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (CLI_PATTERN.test(file)) {
      violations.push(file);
      // Do not walk INTO the CLI; the edge that reached it is the finding.
      continue;
    }
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch (err) {
      const e = new Error(`could not read ${file}: ${err.message}`);
      e.instrument = true;
      throw e;
    }
    for (const spec of staticImportSpecifiers(src)) {
      if (!spec.startsWith(".")) continue; // bare specifier: declared out of scope
      const ext = path.extname(spec);
      if (NON_CODE_EXTENSIONS.has(ext)) continue;
      const resolved = resolveRelative(file, spec);
      if (!resolved) {
        const e = new Error(
          `relative specifier '${spec}' in ${file} resolves to no file on disk; the walk has a blind spot and cannot report a clean tree`,
        );
        e.instrument = true;
        throw e;
      }
      if (parent.has(resolved)) continue;
      parent.set(resolved, file);
      queue.push(resolved);
    }
  }
  return { visited: parent, violations };
}

function pathFromRoot(parent, file) {
  const chain = [];
  let cur = file;
  while (cur) {
    chain.unshift(cur);
    cur = parent.get(cur) ?? null;
  }
  return chain;
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join("/");
}

function currentCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return "unknown (git rev-parse failed)";
}

// ---- SELF-TEST FIXTURES ---------------------------------------------------

function buildFixtures(dir) {
  const mk = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  // Violating tree: the CLI is reached through a BARREL RE-EXPORT, three hops
  // from the entry. This is the exact shape of the live defect, and the shape a
  // per-file grep over routes/ cannot see.
  mk(
    "dirty/fooCli.ts",
    "export function classify() { return 1; }\nif (process.argv[1]) { process.exit(1); }\n",
  );
  mk("dirty/engine.ts", 'import { classify } from "./fooCli";\nexport { classify };\n');
  mk("dirty/index-barrel.ts", 'export * from "./engine";\n');
  mk("dirty/route.ts", 'import { classify } from "./index-barrel";\nexport const r = classify;\n');
  const dirtyRoot = mk("dirty/entry.ts", 'import { r } from "./route";\nexport default r;\n');

  // Clean tree: same shape, and it also carries a `import type` from the CLI
  // plus a comment that NAMES the forbidden import, so the fixture proves the
  // gate does not fire on erased type edges or on its own documentation.
  mk("clean/fooCli.ts", "export type Classification = string;\nexport function classify() { return 1; }\n");
  mk("clean/pure.ts", "export function classify() { return 1; }\n");
  mk(
    "clean/engine.ts",
    [
      "/**",
      ' * This header deliberately mentions import { classify } from "./fooCli";',
      " * A gate that matches its own documentation is a dead gate.",
      " */",
      'import type { Classification } from "./fooCli";',
      'import { classify } from "./pure";',
      "export { classify };",
      "export type { Classification };",
      "",
    ].join("\n"),
  );
  mk("clean/index-barrel.ts", 'export * from "./engine";\n');
  mk("clean/route.ts", 'import { classify } from "./index-barrel";\nexport const r = classify;\n');
  const cleanRoot = mk("clean/entry.ts", 'import { r } from "./route";\nexport default r;\n');

  return { dirtyRoot, cleanRoot };
}

// ---- MAIN -----------------------------------------------------------------

function main() {
  const args = parseArgv(process.argv.slice(2));
  const rootArg = args.root ?? path.join("src", "index.ts");
  const root = path.isAbsolute(rootArg)
    ? rootArg
    : path.resolve(API_SERVER_DIR, rootArg);

  console.log(`${GATE_ID}: commit ${currentCommit()}`);
  console.log(`${GATE_ID}: root   ${rel(root)}`);

  // ---- SELF-TEST, BOTH DIRECTIONS ---------------------------------------
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-graph-"));
  try {
    const { dirtyRoot, cleanRoot } = buildFixtures(fixtureDir);

    let dirty;
    try {
      dirty = walk(dirtyRoot);
    } catch (err) {
      didNotRun(`self-test A could not run: ${err.message}`);
    }
    if (dirty.violations.length === 0) {
      didNotRun(
        "self-test A failed: the walker did not flag a CLI reached through a barrel re-export, so a clean verdict would be meaningless",
      );
    }

    let clean;
    try {
      clean = walk(cleanRoot);
    } catch (err) {
      didNotRun(`self-test B could not run: ${err.message}`);
    }
    if (clean.violations.length > 0) {
      didNotRun(
        `self-test B failed: the walker flagged a compliant tree (${clean.violations
          .map((v) => path.basename(v))
          .join(", ")}), so this gate is permanently red and enforces nothing`,
      );
    }
    console.log(`${GATE_ID}: self-test passed in both directions`);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  // ---- VERDICT ON THE REAL TREE -----------------------------------------
  let result;
  try {
    result = walk(root);
  } catch (err) {
    if (err.instrument) didNotRun(err.message);
    didNotRun(`the walker threw: ${err.stack ?? err}`);
  }

  console.log(
    `${GATE_ID}: walked ${result.visited.size} modules reachable from ${rel(root)}`,
  );

  if (result.violations.length > 0) {
    for (const v of result.violations) {
      console.error("");
      console.error(`  CLI in the boot graph: ${rel(v)}`);
      const chain = pathFromRoot(result.visited, v);
      chain.forEach((step, i) => {
        console.error(`    ${i === 0 ? "" : "-> "}${rel(step)}`);
      });
    }
    console.error("");
    console.error(
      `FAIL ${GATE_ID}: ${result.violations.length} CLI module(s) are statically reachable from the server entrypoint. A CLI's isDirectRun() guard does NOT survive esbuild bundling — import.meta.url becomes the bundle's own URL — so its main() runs at server boot and can exit the process before Express listens. Extract the shared pure functions into a leaf module (see src/lib/countyCoverageClassification.ts and src/lib/nodeFacetTier2Constants.ts) and import that instead, or load the CLI with a dynamic import.`,
    );
    console.error("RESULT=violation");
    process.exit(EXIT_VIOLATION);
  }

  console.log(`${GATE_ID}: clean`);
  console.log("RESULT=clean");
  process.exit(EXIT_CLEAN);
}

main();
