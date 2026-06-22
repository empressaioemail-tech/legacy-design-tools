/**
 * Public surface for `@workspace/finding-engine`.
 *
 * The api-server consumes:
 *   - {@link generateFindings} — top-level entry point.
 *   - {@link resolveFindingLlmMode} — env-derived mode for startup logs.
 *   - The type bundle (`EngineFinding`, `GenerateFindingsInput`, …).
 *
 * Internal modules (`prompt`, `mockGenerator`, `anthropicGenerator`,
 * `citationAdapter`) are re-exported for tests and downstream packages
 * that want to swap one piece without forking the whole engine.
 */

export {
  generateFindings,
  resolveFindingLlmMode,
  type GenerateFindingsOptions,
} from "./engine";

export {
  type BimElementInput,
  type BriefingSourceInput,
  type CodeSectionInput,
  type CodeSectionProvenance,
  type CodeSectionWebProvenance,
  type ReasoningSourceLink,
  type CodeReferenceEntry,
  type CodeRetrievalContext,
  type ApplicableIccEdition,
  type IccCodeTitle,
  type RetrievalUsageEvent,
  type EngineFinding,
  type FindingCategory,
  type FindingCitation,
  type FindingCodeCitation,
  type FindingLlmMode,
  type FindingSeverity,
  type FindingSourceCitation,
  type FindingStatus,
  type GenerateFindingsInput,
  type GenerateFindingsResult,
  type SubmissionInput,
  FINDING_CATEGORY_VALUES,
  FINDING_SEVERITY_VALUES,
  FINDING_STATUS_VALUES,
  FINDING_MIN_TEXT_LENGTH,
  ICC_CODE_TITLE_VALUES,
} from "./types";

export {
  buildDeduplicatedReferences,
  collectCitedCodeAtomIds,
  mintReferenceEntry,
  reconcileReferencesWithFindings,
  type ReferenceReconciliation,
} from "./references";

export {
  formatReferenceLine,
  renderFormalReferenceBlock,
  type RenderFormalReferenceOptions,
  type SectionIdentifierFormat,
} from "./formalReferenceRenderer";

export {
  buildRetrievalUsageEvent,
  isGateCodeRetrievalMode,
  mergeRetrievalUsageEvents,
  resolveCodeRetrievalMode,
  type CodeRetrievalMode,
} from "./codeRetrieval";

export { parseApplicableIccEditions } from "./iccEditions";

export {
  FINDING_ANTHROPIC_MODEL,
  FINDING_ANTHROPIC_MAX_TOKENS,
  FindingGeneratorError,
  callAnthropicGenerator,
  parseAnthropicResponse,
  type RawFindingDraft,
} from "./anthropicGenerator";

export {
  FINDING_GROK_DEFAULT_MODEL,
  FINDING_GROK_MAX_TOKENS,
  callGrokGenerator,
  resolveGrokFindingModel,
} from "./grokGenerator";

export {
  validateInlineCitations,
  type CitationResolvers,
  type CitationScanResult,
} from "./citationAdapter";

export { generateMockFindings } from "./mockGenerator";

export {
  FINDING_SYSTEM_PROMPT,
  buildUserPrompt,
  PROMPT_NARRATIVE_MAX_CHARS,
  PROMPT_CODE_SNIPPET_MAX_CHARS,
} from "./prompt";

export {
  FINDING_VISION_ANTHROPIC_MODEL,
  FINDING_VISION_MAX_SHEETS_PER_PASS,
  runDisciplineVisionRead,
  enrichPiecesWithVisionObservations,
  type AttachedSheetImage,
  type VisionSheetReadResult,
} from "./visionSheetRead";

export {
  generateOrchestratedFindings,
  resolveFindingOrchestratedMode,
  classifyPlanSetPiece,
  classifyPlanSetPieces,
  filterCodeSectionsForDiscipline,
  disciplineRetrievalQuery,
  type GenerateOrchestratedFindingsInput,
  type GenerateOrchestratedFindingsResult,
  type PlanSetPieceCandidate,
  type PlanSetPieceInput,
} from "./planSet/orchestrator";

export {
  reconcileStandardPrecedence,
  reconcileRequirementsByTopic,
  formatPrecedenceFindingText,
  compareStringency,
  pickMostStringent,
  allAlign,
  detectStandardDescriptor,
  codeSectionToRequirementShell,
  buildAdaFhaA117DoorClearanceRequirements,
  buildLocalAmendmentOverlayRequirement,
  buildFederalPreemptPair,
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
  type ApplicableRequirement,
  type PrecedenceConflict,
  type PrecedenceDomain,
  type PrecedenceReconciliationResult,
  type PrecedenceRuleApplied,
  type ReconcileRequirementsByTopicInput,
  type ReconcileRequirementsByTopicResult,
  type ReconcileStandardPrecedenceOptions,
  type RequirementKind,
  type StandardAuthority,
  type StandardDescriptor,
  buildPrecedenceFindingDrafts,
  precedenceReconciliationsFromCodeSections,
} from "./precedence";
