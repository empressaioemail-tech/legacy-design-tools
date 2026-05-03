/**
 * Public surface for `@workspace/submission-classifier`.
 *
 * Both the api-server's live auto-trigger hook
 * (`autoTriggerClassificationOnSubmissionCreated`) and the
 * historical-inbox backfill script
 * (`scripts/src/backfillTrack1Classifications.ts`) consume this
 * module. Pre-Track-1, the same logic was duplicated across both —
 * extracted here to remove drift risk.
 */

export {
  type ClassificationResult,
  type ClassifierLogger,
  EMPTY_CLASSIFICATION,
} from "./types";

export {
  CLASSIFIER_PROMPT_TEXT_MAX_CHARS,
  CLASSIFIER_ANTHROPIC_MODEL,
  CLASSIFIER_ANTHROPIC_MAX_TOKENS,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_AUTO_ACTOR,
} from "./constants";

export {
  classificationAtomId,
  submissionIdFromClassificationAtomId,
  SUBMISSION_CLASSIFICATION_EVENT_TYPES,
  type SubmissionClassificationEventType,
} from "./atomGrammar";

export {
  type ClassificationLlmMode,
  resolveClassificationLlmMode,
  getClassificationLlmClient,
  setClassificationLlmClient,
  getClassificationLlmMode,
  validateClassificationEnvAtBoot,
  setClassifierLogger,
  __classificationLlmClientIsFromEnvForTests,
} from "./llmClient";

export {
  gatherClassifierInputText,
  classifySubmission,
  parseClassificationResponse,
} from "./classifier";

export {
  upsertAutoClassification,
  emitClassificationEvents,
} from "./upsert";
