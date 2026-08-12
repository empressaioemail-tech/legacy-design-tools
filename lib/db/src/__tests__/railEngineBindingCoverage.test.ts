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

  it("every static rail has a binding entry", () => {
    for (const meta of COUNTY_RAIL_STATIC_DECLARATION) {
      expect(RAIL_ENGINE_BINDING_BY_KEY[meta.railKey]).toBeDefined();
    }
  });

  it("every binding is either writer-bound on disk or declares noWriterReason", () => {
    for (const binding of RAIL_ENGINE_BINDINGS) {
      const hasEngineScript = binding.engineWriterScript
        ? existsSync(
            path.join(
              engineRoot,
              "packages",
              "engine-core",
              "scripts",
              binding.engineWriterScript,
            ),
          )
        : false;
      const hasLdtScorer = binding.ldtScorerPath
        ? existsSync(
            path.join(
              ldtRoot,
              "artifacts",
              "api-server",
              "src",
              binding.ldtScorerPath,
            ),
          )
        : false;

      if (
        !binding.engineWriterScript &&
        !binding.ldtScorerPath &&
        binding.atomEntityTypes.length > 0
      ) {
        expect(binding.noWriterReason).toBeTruthy();
      }

      if (binding.engineWriterScript) {
        expect(hasEngineScript).toBe(true);
      }
      if (binding.ldtScorerPath) {
        expect(hasLdtScorer).toBe(true);
      }
    }
  });

  it("easement passes with explicit noWriterReason", () => {
    const easement = RAIL_ENGINE_BINDING_BY_KEY.easement;
    expect(easement?.noWriterReason).toMatch(/no-writer/i);
    expect(easement?.engineWriterScript).toBeUndefined();
    expect(easement?.ldtScorerPath).toBeUndefined();
  });
});
