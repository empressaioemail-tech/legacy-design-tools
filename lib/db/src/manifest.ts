/** Server-only manifest derivation and capability probes (uses node:fs). */
export {
  buildEffectiveCountyRailDeclaration,
  deriveAtomFamilyState,
  deriveHasWriter,
  deriveRailDeclarationFields,
  computeCp1CellMoveExpectations,
  resolveEngineRoot,
  resolveLdtRoot,
  type DerivationProbeOptions,
  type DerivedRailFields,
} from "./railManifestDerivation";
export {
  probeRailCapabilities,
  TEXAS_COUNTY_COUNT,
  type RailCapability,
  type RailCapabilityOutcome,
  type CapabilityDbHandle,
} from "./railCoverageCapability";
