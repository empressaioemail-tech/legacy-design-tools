/**
 * Precedence / reconciliation primitive — ADR-019 + ADR-021.
 * Spine-wide callable surface; exported from `@workspace/finding-engine`.
 */

export {
  reconcileStandardPrecedence,
  reconcileRequirementsByTopic,
  formatPrecedenceFindingText,
} from "./reconcile";

export {
  compareStringency,
  pickMostStringent,
  allAlign,
} from "./comparability";

export {
  detectStandardDescriptor,
  codeSectionToRequirementShell,
} from "./standardRegistry";

export {
  buildAdaFhaA117DoorClearanceRequirements,
  buildLocalAmendmentOverlayRequirement,
  buildFederalPreemptPair,
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
} from "./accessibilityDemo";

export { buildPrecedenceFindingDrafts, precedenceReconciliationsFromCodeSections } from "./productionWire";

export type {
  ApplicableRequirement,
  PrecedenceConflict,
  PrecedenceDomain,
  PrecedenceReconciliationResult,
  PrecedenceRuleApplied,
  ReconcileRequirementsByTopicInput,
  ReconcileRequirementsByTopicResult,
  ReconcileStandardPrecedenceOptions,
  RequirementKind,
  StandardAuthority,
} from "./types";

export type { StandardDescriptor } from "./standardRegistry";
