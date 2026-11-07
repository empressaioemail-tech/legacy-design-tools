import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cache: string | null = null;

function sourcesNewerThan(baked: string, sources: string[]): boolean {
  const bakedM = statSync(baked).mtimeMs;
  return sources.some((s) => existsSync(s) && statSync(s).mtimeMs > bakedM);
}

export function loadCardIife(): string {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [join(here, "app-entry.ts"), join(here, "panel-lib.ts"), join(here, "answer-first-html.ts"), join(here, "detail-html.ts")];
  const baked = [
    join(here, "card.iife.js"),
    join(here, "../card.iife.js"),
    join(here, "../../dist/card.iife.js"),
    join(here, "../dist/card.iife.js"),
  ];
  for (const p of baked) {
    if (existsSync(p) && !sourcesNewerThan(p, sources)) {
      cache = readFileSync(p, "utf8");
      return cache;
    }
  }
  const entry = join(here, "app-entry.ts");
  if (!existsSync(entry)) {
    throw new Error(`card IIFE missing: no baked file and no ${entry}`);
  }
  const require = createRequire(import.meta.url);
  const esbuild = require("esbuild") as typeof import("esbuild");
  const result = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    minifyWhitespace: true,
    write: false,
    keepNames: false,
  });
  cache = result.outputFiles[0].text;
  return cache;
}
