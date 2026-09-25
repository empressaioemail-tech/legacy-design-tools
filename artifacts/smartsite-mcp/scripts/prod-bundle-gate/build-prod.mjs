/**
 * Bundle mcp-app.ts the same way production does (Dockerfile esbuild flags), then buildAppHtml.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const outFile = path.join(here, "prod-mcp-app.mjs");

process.env.PARCEL_TILES_ORIGIN =
  process.env.PARCEL_TILES_ORIGIN ||
  "https://hauska-artifacts.nyc3.digitaloceanspaces.com";

await esbuild.build({
  entryPoints: [path.join(pkgRoot, "src/mcp-app.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: outFile,
  external: [
    "dotenv",
    "express",
    "jose",
    "drizzle-orm",
    "pg",
    "zod",
    "@modelcontextprotocol/*",
  ],
  logLevel: "warning",
});

const mod = await import(pathToFileURL(outFile).href);
const html = mod.buildAppHtml();
fs.writeFileSync(path.join(here, "app-prod.html"), html);
console.log(
  JSON.stringify({
    bundle: outFile,
    htmlBytes: html.length,
    __nameCalls: (html.match(/__name\(/g) || []).length,
  }),
);
