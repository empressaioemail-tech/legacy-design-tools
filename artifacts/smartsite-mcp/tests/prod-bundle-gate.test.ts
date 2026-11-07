import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { selfTestRenames, undeclaredRenames } from "../scripts/prod-bundle-gate/renames.mjs";

const gateDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scripts/prod-bundle-gate",
);

describe("P-456 production bundle gate (A-301)", () => {
  it("rename detector self-test passes", () => {
    expect(() => selfTestRenames()).not.toThrow();
  });

  it("esbuild production bundle has no undeclared renames in buildAppHtml output", () => {
    process.env.PARCEL_TILES_ORIGIN =
      process.env.PARCEL_TILES_ORIGIN ||
      "https://hauska-artifacts.nyc3.digitaloceanspaces.com";
    const build = spawnSync(process.execPath, ["build-prod.mjs"], {
      cwd: gateDir,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);
    const bundle = fs.readFileSync(
      path.join(gateDir, "prod-mcp-app.mjs"),
      "utf8",
    );
    const page = fs.readFileSync(path.join(gateDir, "app-prod.html"), "utf8");
    const found = undeclaredRenames(bundle, page);
    expect(found).toEqual([]);
  });
});
