/**
 * CI grep gate — Master WDLL 3.7 / I-A.
 * Fails if the retired labeling×district multiply reappears in live path.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MULTIPLY_RE = /labeling\.confidence\s*\*\s*district\.confidence/;
const TERRAIN_MESH_IFC_AUTHORING_RE =
  /runIfcWorker|buildTerrainMeshInWorker|buildTerrainMeshGeometry|deriveTerrainMeshGlb/;
const ROOT = join(__dirname, "../..");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "coverage") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("anti-zombie: labeling×district multiply retired (WDLL 3.7)", () => {
  it("no live-path source reintroduces labeling.confidence * district.confidence", () => {
    const hits: string[] = [];
    for (const file of walkTsFiles(ROOT)) {
      // This test file mentions the pattern in the regex / doc strings.
      if (file.endsWith("antiZombieConfidence.test.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (MULTIPLY_RE.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});

describe("anti-zombie: cortex terrain mesh/IFC authoring retired (WDLL item 7 / I-A)", () => {
  it("no live-path api-server source reintroduces mesh/IFC authoring symbols", () => {
    const hits: string[] = [];
    for (const file of walkTsFiles(ROOT)) {
      if (file.endsWith("antiZombieConfidence.test.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (TERRAIN_MESH_IFC_AUTHORING_RE.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
