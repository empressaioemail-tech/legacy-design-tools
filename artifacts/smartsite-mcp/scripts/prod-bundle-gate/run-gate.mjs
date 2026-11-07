import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selfTestRenames, undeclaredRenames } from "./renames.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");

selfTestRenames();

const build = spawnSync(process.execPath, ["build-prod.mjs"], {
  cwd: here,
  stdio: "inherit",
  env: process.env,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const bundle = fs.readFileSync(path.join(here, "prod-mcp-app.mjs"), "utf8");
const page = fs.readFileSync(path.join(here, "app-prod.html"), "utf8");
const renames = undeclaredRenames(bundle, page);
if (renames.length) {
  console.error("undeclaredRenames", JSON.stringify(renames));
  process.exit(1);
}
console.log("undeclaredRenames: []");

const skipBrowser = process.env.PROD_BUNDLE_GATE_SKIP_BROWSER === "1";
if (skipBrowser) {
  console.log("PROD_BUNDLE_GATE_SKIP_BROWSER=1 — skipping Chromium harness");
  process.exit(0);
}

const esbuildInstall = spawnSync(
  "pnpm",
  ["exec", "esbuild", "--version"],
  { cwd: pkgRoot, shell: true, stdio: "pipe" },
);
if (esbuildInstall.status !== 0) {
  spawnSync("pnpm", ["add", "-D", "esbuild", "playwright-core"], {
    cwd: pkgRoot,
    shell: true,
    stdio: "inherit",
  });
}

const harness = spawnSync(process.execPath, ["harness-prod.mjs"], {
  cwd: here,
  stdio: "inherit",
  env: process.env,
});
process.exit(harness.status ?? 1);
