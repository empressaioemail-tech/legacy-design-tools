/**
 * P-456c. Gate the page printed by the production server artifact.
 * Builds exactly as the Dockerfile, runs `node dist/server.mjs --print-app-html`,
 * then renders that HTML in headless Chromium.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(pkgRoot, "../..");
const distDir = path.join(pkgRoot, "dist");
const htmlPath = path.join(here, "app-from-server.html");

const ESBUILD_SERVER = [
  "exec",
  "esbuild",
  "src/index.ts",
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=esm",
  "--outfile=dist/server.mjs",
  "--external:dotenv",
  "--external:express",
  "--external:jose",
  "--external:drizzle-orm",
  "--external:pg",
  "--external:zod",
  "--external:@modelcontextprotocol/*",
  "--external:esbuild",
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: pkgRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  return r.status ?? 1;
}

function ensureEsbuild() {
  const ver = spawnSync("pnpm", ["exec", "esbuild", "--version"], {
    cwd: pkgRoot,
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  if (ver.status === 0) return;
  const add = spawnSync("pnpm", ["add", "-D", "esbuild"], {
    cwd: pkgRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (add.status !== 0) process.exit(add.status ?? 1);
}

fs.mkdirSync(distDir, { recursive: true });
ensureEsbuild();

const cardEntry = path.join(pkgRoot, "src/card/app-entry.ts");
if (fs.existsSync(cardEntry)) {
  const card = run("pnpm", [
    "exec",
    "esbuild",
    "src/card/app-entry.ts",
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--minify-whitespace",
    "--outfile=dist/card.iife.js",
  ]);
  if (card !== 0) process.exit(card);
}

const server = run("pnpm", ESBUILD_SERVER);
if (server !== 0) process.exit(server);

const env = {
  ...process.env,
  PARCEL_TILES_ORIGIN:
    process.env.PARCEL_TILES_ORIGIN ||
    "https://hauska-artifacts.nyc3.digitaloceanspaces.com",
};

const printed = spawnSync(process.execPath, ["dist/server.mjs", "--print-app-html"], {
  cwd: pkgRoot,
  env,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
if (printed.status !== 0) {
  process.stderr.write(printed.stderr || "");
  console.error("print-app-html failed", printed.status);
  process.exit(printed.status ?? 1);
}
const html = printed.stdout || "";
if (!html.includes("<!DOCTYPE html>") && !html.includes("<html")) {
  console.error("print-app-html did not emit a page");
  process.exit(1);
}
fs.writeFileSync(htmlPath, html, "utf8");
console.log(`printed ${html.length} bytes from dist/server.mjs --print-app-html`);

if (process.env.ARTIFACT_HTML_GATE_SKIP_BROWSER === "1") {
  console.log("ARTIFACT_HTML_GATE_SKIP_BROWSER=1 — skipping Chromium");
  process.exit(0);
}

const harness = spawnSync(
  process.execPath,
  [path.join(here, "harness.mjs")],
  {
    cwd: here,
    stdio: "inherit",
    env: { ...env, APP_HTML_PATH: htmlPath },
  },
);
process.exit(harness.status ?? 1);
