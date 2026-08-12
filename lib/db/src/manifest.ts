/** Server-only manifest derivation and capability probes (uses node:fs). */
export {
  buildEffectiveCountyRailDeclaration,
  deriveAtomFamilyPresent,
  deriveAtomFamilyState,
  deriveHasWriter,
  deriveRailDeclarationFields,
  computeCp1CellMoveExpectations,
  hasIndeterminateDerivations,
  isRailDerivationIndeterminate,
  resolveEngineRoot,
  resolveLdtRoot,
  type DerivationProbeOptions,
  type DerivedRailFields,
  type EffectiveCountyRailDeclaration,
} from "./railManifestDerivation";
export {
  probeRailCapabilities,
  TEXAS_COUNTY_COUNT,
  type RailCapability,
  type RailCapabilityOutcome,
  type CapabilityDbHandle,
} from "./railCoverageCapability";
export {
  type DerivedTriState,
  hasWriterBooleanForStorage,
  isConfirmedFalse,
  isConfirmedTrue,
  isDerivedIndeterminate,
  isIndeterminate,
  triStateToConfirmedBoolean,
} from "./schema/derivedTriState";
export {
  assertManifestReconciliation,
  runManifestReconciliationGate,
  ManifestReconciliationError,
  RECONCILIATION_ASSERTIONS,
  type ReconciliationAssertionFailure,
  type ReconciliationGateInput,
  type ReconciliationManifestCell,
} from "./manifestReconciliationGate";
export {
  readManifestGridFromPool,
  readCountyManifestRowCount,
  readCountyRailHasWriterMap,
} from "./manifestGridRead";
