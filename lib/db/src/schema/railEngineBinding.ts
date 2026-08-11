/**
 * Rail key → engine atom entity type(s) and writer/scorer paths.
 * Used by `railManifestDerivation.ts` to derive `atomFamilyState` and
 * `hasWriter` from checked-in engine truth + on-disk file probes.
 */
export interface RailEngineBinding {
  railKey: string;
  /** All listed types must appear in the engine snapshot for `present`. */
  atomEntityTypes: readonly string[];
  /**
   * When true, types missing from the engine snapshot may still read `present`
   * if every type appears in the contract property snapshot (e.g. `road-node`).
   */
  allowContractOnlyRegistration?: boolean;
  /** Relative to `{engineRoot}/packages/engine-core/scripts/`. */
  engineWriterScript?: string;
  /** Relative to `{ldtRoot}/artifacts/api-server/src/`. */
  ldtScorerPath?: string;
  atomFamilyRefLabel?: string;
  writerRefLabel?: string;
}

export const RAIL_ENGINE_BINDINGS: ReadonlyArray<RailEngineBinding> = [
  {
    railKey: "geometry",
    atomEntityTypes: ["parcel-node"],
    ldtScorerPath: "countyGeometryScoreCli.ts",
    atomFamilyRefLabel: "parcel-node (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "countyGeometryScoreCli.ts facet geometry",
  },
  {
    railKey: "cad",
    atomEntityTypes: ["cad-parcel-roll"],
    engineWriterScript: "write-cad-parcel-roll-county.mjs",
    atomFamilyRefLabel: "cad-parcel-roll (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-cad-parcel-roll-county.mjs",
  },
  {
    railKey: "zoning",
    atomEntityTypes: ["zoning-fact", "setback-rule"],
    ldtScorerPath: "countyCoverageScoreCli.ts",
    atomFamilyRefLabel: "zoning-fact, setback-rule (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "countyCoverageScoreCli.ts facet zoning/setback",
  },
  {
    railKey: "roads",
    atomEntityTypes: ["road-node"],
    allowContractOnlyRegistration: true,
    atomFamilyRefLabel: "road-node (contract; engine registration pending)",
  },
  {
    railKey: "flood",
    atomEntityTypes: ["flood-hazard-fact"],
    engineWriterScript: "write-flood-hazard-fact-county.mjs",
    atomFamilyRefLabel: "flood-hazard-fact (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-flood-hazard-fact-county.mjs",
  },
  {
    railKey: "envelope",
    atomEntityTypes: ["buildable-envelope"],
    ldtScorerPath: "countyCoverageScoreCli.ts",
    atomFamilyRefLabel: "buildable-envelope (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "countyCoverageScoreCli.ts facet envelope",
  },
  {
    railKey: "landuse",
    atomEntityTypes: ["land-use-fact"],
    engineWriterScript: "write-land-use-fact-county.mjs",
    ldtScorerPath: "countyCoverageScoreCli.ts",
    atomFamilyRefLabel: "land-use-fact (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel:
      "hauska-engine write-land-use-fact-county.mjs; countyCoverageScoreCli.ts facet land-use",
  },
  {
    railKey: "footprint",
    atomEntityTypes: ["building-footprint"],
    engineWriterScript: "write-building-footprint-county.mjs",
    atomFamilyRefLabel: "building-footprint (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-building-footprint-county.mjs",
  },
  {
    railKey: "easement",
    atomEntityTypes: ["utility-easement"],
    atomFamilyRefLabel: "utility-easement (engine PROPERTY_ENTITY_TYPES)",
  },
  {
    railKey: "owner",
    atomEntityTypes: ["owner-fact"],
    engineWriterScript: "write-owner-fact-county.mjs",
    atomFamilyRefLabel: "owner-fact (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-owner-fact-county.mjs",
  },
  {
    railKey: "rrc-wells",
    atomEntityTypes: ["well-fact"],
    engineWriterScript: "write-well-fact-county.mjs",
    atomFamilyRefLabel: "well-fact (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-well-fact-county.mjs",
  },
  {
    railKey: "rrc-pipelines",
    atomEntityTypes: [],
  },
  {
    railKey: "rail-corridor",
    atomEntityTypes: ["rail-corridor-fact"],
    engineWriterScript: "write-rail-corridor-fact-county.mjs",
    atomFamilyRefLabel: "rail-corridor-fact (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-rail-corridor-fact-county.mjs",
  },
  {
    railKey: "mud",
    atomEntityTypes: ["special-district-fact"],
    engineWriterScript: "write-special-district-fact-county.mjs",
    atomFamilyRefLabel: "special-district-fact (engine PROPERTY_ENTITY_TYPES)",
    writerRefLabel: "hauska-engine write-special-district-fact-county.mjs",
  },
];

export const RAIL_ENGINE_BINDING_BY_KEY: Readonly<Record<string, RailEngineBinding>> =
  Object.fromEntries(RAIL_ENGINE_BINDINGS.map((b) => [b.railKey, b]));
