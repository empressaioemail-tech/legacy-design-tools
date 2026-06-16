export { MIN_DENSE_SIGNAL, CALIBRATION_PRIOR_WEIGHT } from "./constants";
export type {
  CalibrationStamp,
  CalibrationSignal,
  OverlayCalibrationRow,
  AttributionCoverageHealth,
} from "./types";
export {
  assertedBaselineFromSourceType,
  atomClassFromCodeRef,
} from "./corpusBaseline";
export {
  partitionForSignal,
  isPublicPoolEligible,
  tenantMayReadOverlay,
  type OverlayAccessPolicy,
} from "./partition";
export { stampsMatch, stampFromFields } from "./stamp";
export {
  computePartitionCalibration,
  type AggregatedCalibration,
} from "./compute";
export {
  collectCalibrationSignals,
  loadAtomAccessContexts,
  type AtomAccessContext,
} from "./signals";
export {
  effectiveConfidence,
  recomputeCalibrationOverlay,
  ensureCorpusOverlayRow,
  resolveOverlayCalibration,
  listOverlayRows,
  resolveOverlayKeyFromStructuredRef,
  seedReasoningOverlayFromAtom,
  invalidateStaleCalibrationForAtom,
} from "./overlay";
export { computeAttributionCoverage } from "./attribution";
export { FINDING_OUTCOME_RECORDED_EVENT_TYPE } from "./findingOutcomeEventType";
export type {
  EngineConfidenceKind,
  EngineEnvelopeConfidence,
  EngineEnvelopeCoverage,
  EngineEnvelopeSource,
  EngineHonesty,
  EngineEnvelope,
} from "./envelope";
export {
  engineHonestyFromEnvelope,
  isEngineEnvelopeShape,
  unwrapEngineEnvelope,
  wrapEngineEnvelope,
} from "./envelope";
