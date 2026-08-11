import path from "node:path";
import { describe, it, expect } from "vitest";

import {
  buildEffectiveCountyRailDeclaration,
  computeCp1CellMoveExpectations,
  deriveAtomFamilyState,
  deriveHasWriter,
} from "../railManifestDerivation";
import { ENGINE_PROPERTY_TYPES_SNAPSHOT } from "../schema/enginePropertyTypesSnapshot";
import { RAIL_ENGINE_BINDING_BY_KEY } from "../schema/railEngineBinding";

/** CP1 pre-refresh hand-edited stale state (254 counties each). */
const CP1_BEFORE_BY_KEY = {
  "rail-corridor": { atomFamilyState: "missing" as const, hasWriter: false },
  "rrc-wells": { atomFamilyState: "missing" as const, hasWriter: false },
  mud: { atomFamilyState: "missing" as const, hasWriter: false },
  footprint: { atomFamilyState: "present" as const, hasWriter: false },
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
      normalized.endsWith("write-land-use-fact-county.mjs")
    );
  }
  if (normalized.includes("artifacts/api-server/src/")) {
    return (
      normalized.endsWith("countyGeometryScoreCli.ts") ||
      normalized.endsWith("countyCoverageScoreCli.ts")
    );
  }
  return normalized.includes("hauska-engine");
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

  it("keeps rrc-pipelines missing without writer", () => {
    expect(byKey.get("rrc-pipelines")?.atomFamilyState).toBe("missing");
    expect(byKey.get("rrc-pipelines")?.hasWriter).toBe(false);
  });

  it("keeps easement present without writer", () => {
    expect(byKey.get("easement")?.atomFamilyState).toBe("present");
    expect(byKey.get("easement")?.hasWriter).toBe(false);
  });

  it("keeps owner present with writer", () => {
    expect(byKey.get("owner")?.atomFamilyState).toBe("present");
    expect(byKey.get("owner")?.hasWriter).toBe(true);
  });

  it("matches CP1 cell move expectations (762 no-atom, 254 no-writer)", () => {
    const moves = computeCp1CellMoveExpectations(CP1_BEFORE_BY_KEY, effective);
    expect(moves.cellsMovedOutOfNoAtom).toBe(762);
    expect(moves.cellsMovedOutOfNoWriter).toBe(254);
  });

  it("fail-closes atomFamilyState to missing for unregistered types without contract fallback", () => {
    expect(
      deriveAtomFamilyState(
        "rrc-pipelines",
        ENGINE_PROPERTY_TYPES_SNAPSHOT,
        RAIL_ENGINE_BINDING_BY_KEY["rrc-pipelines"],
      ),
    ).toBe("missing");
  });

  it("keeps roads present via contract snapshot when engine lacks road-node registration", () => {
    expect(
      deriveAtomFamilyState(
        "roads",
        ENGINE_PROPERTY_TYPES_SNAPSHOT,
        RAIL_ENGINE_BINDING_BY_KEY.roads,
      ),
    ).toBe("present");
    expect(byKey.get("roads")?.hasWriter).toBe(false);
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
});
