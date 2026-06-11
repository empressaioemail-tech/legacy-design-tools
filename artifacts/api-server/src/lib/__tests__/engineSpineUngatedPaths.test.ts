/**
 * ADR-008 / C3 — no ungated path to a reasoning engine remains in cortex-api.
 *
 * Route handlers must delegate through engineSpineRouting / engineSpineHydrology
 * (gate-front seam). Direct imports of local generate* entry points are forbidden.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(import.meta.dirname, "../../routes");

const FORBIDDEN_LOCAL_ENGINE_IMPORTS = [
  'from "@workspace/finding-engine"',
  "from '@workspace/finding-engine'",
  'from "@workspace/briefing-engine"',
  "from '@workspace/briefing-engine'",
] as const;

const FORBIDDEN_LOCAL_ENGINE_CALLS = [
  "generateFindings(",
  "generateOrchestratedFindings(",
  "generateBriefing(",
  "runHydrologyWorker(",
  "fetchUsgs3depDem(",
  "resolveRainfallForcing(",
] as const;

/** Route files allowed to import engine packages (types-only; no generate* calls). */
const ALLOWED_ENGINE_IMPORT_FILES = new Set([
  "findings.ts",
  "parcelBriefings.ts",
  "communications.ts",
]);

function isTypeOnlyEngineImport(content: string): boolean {
  const lines = content.split(/\r?\n/);
  return lines
    .filter((line) =>
      FORBIDDEN_LOCAL_ENGINE_IMPORTS.some((imp) => line.includes(imp)),
    )
    .every((line) => /import\s+type\s/.test(line));
}

function listRouteFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRouteFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("engine spine ungated-path audit", () => {
  it("route files do not call local reasoning-engine entry points", () => {
    const violations: string[] = [];
    for (const file of listRouteFiles(ROUTES_DIR)) {
      const base = file.split(/[/\\]/).pop() ?? file;
      const content = readFileSync(file, "utf8");

      for (const call of FORBIDDEN_LOCAL_ENGINE_CALLS) {
        if (content.includes(call)) {
          violations.push(`${base}: calls ${call}`);
        }
      }

      const hasEngineImport = FORBIDDEN_LOCAL_ENGINE_IMPORTS.some((imp) =>
        content.includes(imp),
      );
      if (
        hasEngineImport &&
        !ALLOWED_ENGINE_IMPORT_FILES.has(base) &&
        !isTypeOnlyEngineImport(content)
      ) {
        violations.push(`${base}: imports local engine package`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("findings and briefings routes use spine routing helpers", () => {
    const findings = readFileSync(join(ROUTES_DIR, "findings.ts"), "utf8");
    const briefings = readFileSync(join(ROUTES_DIR, "parcelBriefings.ts"), "utf8");

    expect(findings).toContain("routeGenerateFindings");
    expect(findings).toContain("routeGenerateOrchestratedFindings");
    expect(briefings).toContain("routeGenerateBriefing");
    expect(findings).not.toContain("generateFindings(");
    expect(briefings).not.toContain("generateBriefing(");
  });
});
