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
  manifestReadProbeOptions,
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
export {
  DEPTH_GATE_DEMOTION_STATE,
  isUnsatisfiedDisplayState,
  MANIFEST_DISPLAY_STATES,
  MANIFEST_DISPLAY_STATE_SQL,
  MANIFEST_IS_PARTIAL_SQL,
  type ManifestDisplayState,
} from "./manifestDisplayState";
