import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { COUNTY_RAIL_STATIC_DECLARATION } from "../schema/countyRailStatic";
import {
  RAIL_ENGINE_BINDINGS,
  RAIL_ENGINE_BINDING_BY_KEY,
} from "../schema/railEngineBinding";
import {
  resolveEngineRoot,
  resolveLdtRoot,
} from "../railManifestDerivation";

describe("railEngineBindingCoverage (CI)", () => {
  const engineRoot = resolveEngineRoot();
  const ldtRoot = resolveLdtRoot();
  const engineRootOnDisk = existsSync(engineRoot);

  it("every static rail has a binding entry", () => {
    for (const meta of COUNTY_RAIL_STATIC_DECLARATION) {
      expect(RAIL_ENGINE_BINDING_BY_KEY[meta.railKey]).toBeDefined();
    }
    expect(RAIL_ENGINE_BINDINGS).toHaveLength(COUNTY_RAIL_STATIC_DECLARATION.length);
  });

  it("every binding declares a writer/scorer path OR explicit noWriterReason", () => {
    for (const binding of RAIL_ENGINE_BINDINGS) {
      const hasDeclaredWriter =
        Boolean(binding.engineWriterScript) || Boolean(binding.ldtScorerPath);
      const hasExplicitAbsence = Boolean(binding.noWriterReason);
      const hasAtomTypes = binding.atomEntityTypes.length > 0;

      if (!hasAtomTypes) {
        expect(hasExplicitAbsence || !hasDeclaredWriter).toBe(true);
        continue;
      }

      expect(
        hasDeclaredWriter || hasExplicitAbsence,
        `rail ${binding.railKey} must bind writer/scorer or declare noWriterReason`,
      ).toBe(true);
    }
  });

  it("LDT scorer paths exist on disk when declared", () => {
    for (const binding of RAIL_ENGINE_BINDINGS) {
      if (!binding.ldtScorerPath) continue;
      const p = path.join(
        ldtRoot,
        "artifacts",
        "api-server",
        "src",
        binding.ldtScorerPath,
      );
      expect(existsSync(p), `missing ldt scorer for ${binding.railKey}: ${p}`).toBe(
        true,
      );
    }
  });

  it("engine writer scripts exist on disk when declared (requires hauska-engine checkout)", () => {
    if (!engineRootOnDisk) {
      expect(
        engineRoot,
        "CI without sibling hauska-engine: structural binding checks only; disk probe skipped",
      ).toBeTruthy();
      return;
    }
    for (const binding of RAIL_ENGINE_BINDINGS) {
      if (!binding.engineWriterScript) continue;
      const p = path.join(
        engineRoot,
        "packages",
        "engine-core",
        "scripts",
        binding.engineWriterScript,
      );
      expect(existsSync(p), `missing engine writer for ${binding.railKey}: ${p}`).toBe(
        true,
      );
    }
  });

  it("easement passes with explicit noWriterReason", () => {
    const easement = RAIL_ENGINE_BINDING_BY_KEY.easement;
    expect(easement?.noWriterReason).toMatch(/no-writer/i);
    expect(easement?.engineWriterScript).toBeUndefined();
    expect(easement?.ldtScorerPath).toBeUndefined();
  });
});
