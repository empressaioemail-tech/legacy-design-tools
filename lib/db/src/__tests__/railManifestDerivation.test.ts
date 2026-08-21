import path from "node:path";
import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  buildEffectiveCountyRailDeclaration,
  cloudRunManifestReadProbeOptions,
  computeCp1CellMoveExpectations,
  deriveAtomFamilyPresent,
  deriveAtomFamilyState,
  deriveHasWriter,
  deriveRailDeclarationFields,
  isRailDerivationIndeterminate,
  manifestReadProbeOptions,
  resolveLdtRoot,
} from "../railManifestDerivation";
import { CONTRACT_PROPERTY_TYPES_SNAPSHOT } from "../schema/contractPropertyTypesSnapshot";
import { ENGINE_PROPERTY_TYPES_SNAPSHOT } from "../schema/enginePropertyTypesSnapshot";
import {
  RAIL_ENGINE_BINDINGS,
  RAIL_ENGINE_BINDING_BY_KEY,
  type RailEngineBinding,
} from "../schema/railEngineBinding";

/** CP1 pre-refresh hand-edited stale state (254 counties each). */
const CP1_BEFORE_BY_KEY = {
  "rail-corridor": { atomFamilyState: "missing" as const, hasWriter: false },
  "rrc-wells": { atomFamilyState: "missing" as const, hasWriter: false },
  mud: { atomFamilyState: "missing" as const, hasWriter: false },
  footprint: { atomFamilyState: "present" as const, hasWriter: false },
  roads: { atomFamilyState: "present" as const, hasWriter: false },
  "rrc-pipelines": { atomFamilyState: "missing" as const, hasWriter: false },
  easement: { atomFamilyState: "present" as const, hasWriter: false },
  owner: { atomFamilyState: "present" as const, hasWriter: true },
};

function cp1MockFileExists(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("hauska-engine/packages/engine-core/scripts/write-")) {
    return (
      normalized.endsWith("write-rail-corridor-fact-county.mjs") ||
      normalized.endsWith("write-well-fact-county.mjs") ||
      normalized.endsWith("write-special-district-fact-county.mjs") ||
      normalized.endsWith("write-building-footprint-county.mjs") ||
      normalized.endsWith("write-owner-fact-county.mjs") ||
      normalized.endsWith("write-cad-parcel-roll-county.mjs") ||
      normalized.endsWith("write-flood-hazard-fact-county.mjs") ||
      normalized.endsWith("write-land-use-fact-county.mjs") ||
      normalized.endsWith("write-road-node-county.mjs") ||
      normalized.endsWith("write-parcel-node-county.mjs") ||
      normalized.endsWith("write-utility-easement-county.mjs") ||
      normalized.endsWith("write-rrc-pipeline-fact-county.mjs")
    );
  }
  if (normalized.includes("artifacts/api-server/src/")) {
    return (
      normalized.endsWith("countyGeometryScoreCli.ts") ||
      normalized.endsWith("countyCoverageScoreCli.ts")
    );
  }
  return false;
}

describe("railManifestDerivation CP1", () => {
  const probeOptions = {
    fileExists: cp1MockFileExists,
    engineRoot: path.resolve("P:/hauska-engine"),
    ldtRoot: path.resolve("P:/legacy-design-tools"),
    requireEngineRoot: false,
  };

  const effective = buildEffectiveCountyRailDeclaration(probeOptions);
  const byKey = new Map(effective.map((r) => [r.railKey, r]));

  it("derives rail-corridor, rrc-wells, mud as present with writer", () => {
    for (const key of ["rail-corridor", "rrc-wells", "mud"] as const) {
      expect(byKey.get(key)?.atomFamilyState).toBe("present");
      expect(byKey.get(key)?.hasWriter).toBe(true);
    }
  });

  it("derives footprint present with writer (not cosmetic-only flip)", () => {
    expect(byKey.get("footprint")?.atomFamilyState).toBe("present");
    expect(byKey.get("footprint")?.hasWriter).toBe(true);
  });

  it("derives rrc-pipelines present with writer (engine PR #314)", () => {
    expect(byKey.get("rrc-pipelines")?.atomFamilyState).toBe("present");
    expect(byKey.get("rrc-pipelines")?.hasWriter).toBe(true);
    expect(byKey.get("rrc-pipelines")?.writerRef).toContain(
      "write-rrc-pipeline-fact-county",
    );
  });

  it("derives easement present with writer (E1: engine PR #295 merged)", () => {
    expect(byKey.get("easement")?.atomFamilyState).toBe("present");
    expect(byKey.get("easement")?.hasWriter).toBe(true);
  });

  it("keeps owner present with writer", () => {
    expect(byKey.get("owner")?.atomFamilyState).toBe("present");
    expect(byKey.get("owner")?.hasWriter).toBe(true);
  });

  it("matches CP1 cell move expectations (1016 no-atom, 762 no-writer)", () => {
    const moves = computeCp1CellMoveExpectations(CP1_BEFORE_BY_KEY, effective);
    // 762 + rrc-pipelines 254: engine PR #314 registered rrc-pipeline-fact
    // and bound write-rrc-pipeline-fact-county.mjs (no-atom → not-yet).
    expect(moves.cellsMovedOutOfNoAtom).toBe(1016);
    // no-writer moves unchanged: rrc-pipelines left no-atom, not no-writer.
    expect(moves.cellsMovedOutOfNoWriter).toBe(762);
  });

  it("fail-closes atomFamilyState to missing for unregistered types without contract fallback", () => {
    expect(
      deriveAtomFamilyState(
        "unknown-unbound-rail",
        ENGINE_PROPERTY_TYPES_SNAPSHOT,
        {
          railKey: "unknown-unbound-rail",
          atomEntityTypes: ["not-a-registered-entity-type"],
        },
      ),
    ).toBe("missing");
  });

  it("derives roads present with writer when engine snapshot and script exist", () => {
    expect(byKey.get("roads")?.atomFamilyState).toBe("present");
    expect(byKey.get("roads")?.hasWriter).toBe(true);
    expect(byKey.get("roads")?.writerRef).toContain("write-road-node-county");
  });

  it("fail-closes hasWriter when no writer file exists", () => {
    expect(
      deriveHasWriter(
        "easement",
        ENGINE_PROPERTY_TYPES_SNAPSHOT,
        RAIL_ENGINE_BINDING_BY_KEY.easement,
        probeOptions.engineRoot!,
        probeOptions.ldtRoot!,
        () => false,
        false,
      ),
    ).toBe(false);
  });

  it("tri-state: snapshot lookup failure yields indeterminate atom family derivation", () => {
    const derived = deriveRailDeclarationFields("zoning", {
      snapshot: null,
    });
    expect(derived.atomFamilyPresent).toBe("indeterminate");
    expect(derived.hasWriter).toBe("indeterminate");
    expect(derived.derivationReason).toContain("engine snapshot lookup failed");
  });

  it("tri-state: confirmed missing binding yields false not indeterminate", () => {
    const derived = deriveRailDeclarationFields("unknown-rail-key", {});
    expect(derived.atomFamilyPresent).toBe(false);
    expect(derived.hasWriter).toBe(false);
    expect(derived.derivationReason).toContain("no binding");
  });

  it("effective declaration carries hasWriterDerivation alongside boolean hasWriter", () => {
    // E1: easement now binds the merged utility-easement county writer, so
    // both the tri-state derivation and the boolean resolve true.
    const rail = effective.find((r) => r.railKey === "easement");
    expect(rail?.hasWriterDerivation).toBe(true);
    expect(rail?.hasWriter).toBe(true);
    expect(rail?.atomFamilyPresent).toBe(true);
  });

  it("derives geometry/zoning/envelope present with writer (D3 regression guard)", () => {
    for (const key of ["geometry", "zoning", "envelope"] as const) {
      expect(byKey.get(key)?.atomFamilyState).toBe("present");
      expect(byKey.get(key)?.hasWriter).toBe(true);
    }
    expect(byKey.get("geometry")?.writerRef).toContain("write-parcel-node-county");
  });

  it("read-path probe does not pretend a missing hauska-engine writer exists (SF-21)", () => {
    const opts = manifestReadProbeOptions();
    const trap =
      "/nonexistent/hauska-engine/packages/engine-core/scripts/write-owner-fact-county.mjs";
    expect(opts.fileExists).toBeTypeOf("function");
    expect(opts.fileExists!(trap)).toBe(false);
  });

  it("WDLL-1: missing engine root + committed snapshot is not indeterminate for easement", () => {
    const present = deriveAtomFamilyPresent(
      "easement",
      ENGINE_PROPERTY_TYPES_SNAPSHOT,
      RAIL_ENGINE_BINDING_BY_KEY.easement,
      CONTRACT_PROPERTY_TYPES_SNAPSHOT,
      "/nonexistent/hauska-engine",
      existsSync,
      true,
    );
    expect(present).toBe(true);
  });

  it("WDLL-2: Cloud Run probe derives easement hasWriter true from declared binding", () => {
    const opts = cloudRunManifestReadProbeOptions();
    const derived = deriveHasWriter(
      "easement",
      ENGINE_PROPERTY_TYPES_SNAPSHOT,
      RAIL_ENGINE_BINDING_BY_KEY.easement,
      opts.engineRoot!,
      resolveLdtRoot(),
      opts.fileExists ?? existsSync,
      opts.requireEngineRoot ?? true,
    );
    expect(derived).toBe(true);
  });

  it("WDLL-3: fixture binding with neither writer path is hasWriter false, not true", () => {
    const fixture: RailEngineBinding = {
      railKey: "fixture-no-writer",
      atomEntityTypes: ["utility-easement"],
    };
    const opts = cloudRunManifestReadProbeOptions();
    expect(
      deriveHasWriter(
        "fixture-no-writer",
        ENGINE_PROPERTY_TYPES_SNAPSHOT,
        fixture,
        opts.engineRoot!,
        resolveLdtRoot(),
        opts.fileExists ?? existsSync,
        true,
      ),
    ).toBe(false);
  });

  it("WDLL-3: fixture binding with only noWriterReason is hasWriter false", () => {
    const fixture: RailEngineBinding = {
      railKey: "fixture-nowriter-reason",
      atomEntityTypes: ["utility-easement"],
      noWriterReason: "not bound; fixture for fail-closed",
    };
    const opts = cloudRunManifestReadProbeOptions();
    expect(
      deriveHasWriter(
        "fixture-nowriter-reason",
        ENGINE_PROPERTY_TYPES_SNAPSHOT,
        fixture,
        opts.engineRoot!,
        resolveLdtRoot(),
        opts.fileExists ?? existsSync,
        true,
      ),
    ).toBe(false);
  });

  it("WDLL-4: Cloud Run probe has zero indeterminate rails among the fourteen bindings", () => {
    const decls = buildEffectiveCountyRailDeclaration(
      cloudRunManifestReadProbeOptions(),
    );
    expect(decls).toHaveLength(RAIL_ENGINE_BINDINGS.length);
    expect(decls).toHaveLength(14);
    expect(decls.filter(isRailDerivationIndeterminate)).toHaveLength(0);
  });

  it("SF-20/SF-21 rewritten: missing tree + declared binding => true", () => {
    const derived = deriveHasWriter(
      "owner",
      ENGINE_PROPERTY_TYPES_SNAPSHOT,
      RAIL_ENGINE_BINDING_BY_KEY.owner,
      "/nonexistent/hauska-engine",
      resolveLdtRoot(),
      existsSync,
      true,
    );
    expect(derived).toBe(true);
  });

  it("SF-20/SF-21 rewritten: missing tree + no declared writer => not true", () => {
    const fixture: RailEngineBinding = {
      railKey: "fixture-undeclared",
      atomEntityTypes: ["utility-easement"],
    };
    const derived = deriveHasWriter(
      "fixture-undeclared",
      ENGINE_PROPERTY_TYPES_SNAPSHOT,
      fixture,
      "/nonexistent/hauska-engine",
      resolveLdtRoot(),
      existsSync,
      true,
    );
    expect(derived).not.toBe(true);
    expect(derived).toBe(false);
  });

  it("module-anchored ldtRoot finds scorers without cwd override (D3 cwd trap)", () => {
    const repoRoot = resolveLdtRoot();
    const wrongCwdRoot = path.join(repoRoot, "artifacts", "api-server");
    const derivedWrong = deriveRailDeclarationFields("zoning", {
      ldtRoot: wrongCwdRoot,
      engineRoot: probeOptions.engineRoot,
      fileExists: existsSync,
      requireEngineRoot: false,
    });
    expect(derivedWrong.hasWriter).toBe("indeterminate");
    expect(derivedWrong.derivationReason).toContain("writer probe indeterminate");

    const derivedAnchored = deriveRailDeclarationFields("zoning", {
      fileExists: existsSync,
      requireEngineRoot: false,
    });
    expect(derivedAnchored.hasWriter).toBe(true);
  });
});
