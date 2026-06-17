export {
  JURISDICTIONS,
  getJurisdiction,
  listJurisdictions,
  keyFromEngagement,
  keyFromEngagementOrSynthesize,
  type JurisdictionConfig,
  type CodeBookConfig,
} from "./jurisdictions";

export {
  ENGINE_CORPUS_JURISDICTION_KEYS,
  CENTRAL_TEXAS_CITY_STATE_TO_KEY,
  listPilotJurisdictionManifest,
  getPilotCoverageTier,
  type PilotCoverageTier,
  type EngineCorpusJurisdictionKey,
} from "./centralTexasPilot";

export {
  enqueueWarmupForJurisdiction,
  drainQueue,
  runWarmupForJurisdiction,
  type OrchestratorLogger,
  type EnqueueResult,
  type DrainResult,
} from "./orchestrator";

export { startQueueWorker, stopQueueWorker } from "./queue";

export {
  retrieveAtomsForQuestion,
  getAtomsByIds,
  countAtomsForJurisdiction,
  MIN_VECTOR_SCORE,
  type RetrievedAtom,
  type RetrieveOptions,
} from "./retrieval";

export {
  embedTexts,
  embedQuery,
  isEmbeddingAvailable,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from "./embeddings";

export {
  ensureCodeAtomSources,
  type BootstrapLogger,
  type EnsureCodeAtomSourcesResult,
} from "./bootstrap";

export {
  REQUIRED_CODE_ATOM_SOURCES,
  type RequiredCodeAtomSource,
} from "./sourceRegistry";

export {
  fetchCodeSection,
  websearchAtomId,
  corpusCoversTarget,
  WEBSEARCH_ATOM_PREFIX,
  WEB_CODE_ALLOWLIST_HOSTS,
  MIAMI_WHOLE_REVIEW_WEB_TARGETS,
  reviewWebTargetsForJurisdiction,
  type WebCodeFetchInput,
  type WebCodeFetchResult,
  type WebCodeReviewTarget,
  type WebCodeSectionInput,
  type HttpFetcher,
} from "./webCodeFetch/index";

export {
  REASONING_ATOM_PREFIX,
  REASONING_SNIPPET_MAX_CHARS,
  reasoningAtomId,
  capReasoningSnippet,
  mergeReasoningSources,
  upsertReasoningAtomFromWebFetch,
  upsertReasoningAtomCorpusOverlay,
  upsertReasoningAtomDeeplinkOnly,
  retrieveReasoningAtomsForRefs,
  retrieveReasoningAtomById,
  countReasoningAtomsForJurisdiction,
  snapshotReasoningVerification,
  rollbackReasoningVerification,
  restoreGroundedReasoningAtoms,
  mergeVerificationState,
  supplementCodeSectionsWithReasoningGrounding,
  supplementCodeSectionsFromWeb,
  type ReasoningAtomRecord,
  type ReasoningSourceLink,
  type ReasoningGroundingResult,
  type ReasoningVerificationSnapshot,
} from "./reasoningAtoms/index";

export {
  HAUSKA_CODE_SECTION_DID_PREFIX,
  isReasoningOverlayAtomId,
  canonicalOverlayAtomKey,
  overlayAtomLookupKey,
  canonicalOverlayKeyFromCodeToken,
  toHauskaCodeSectionDid,
} from "./overlayAtomKey";

export {
  buildChatPrompt,
  formatReferenceCodeAtoms,
  formatAtomVocabulary,
  formatFrameworkAtoms,
  formatSnapshotFocus,
  formatSnapshotFocusBlocks,
  shapeSnapshotPayloadForBudget,
  formatSnapshotDiffBlock,
  formatSnapshotDiffBlocks,
  relativeTime,
  HIGH_PRIORITY_SNAPSHOT_PAYLOAD_KEYS,
  LOW_PRIORITY_SNAPSHOT_PAYLOAD_KEYS,
  MAX_ATOM_BODY_CHARS,
  MAX_FRAMEWORK_ATOM_PROSE_CHARS,
  MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
  MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
  SNAPSHOT_DIFF_NAME_LIMIT,
  SNAPSHOT_DIFF_LABEL_MAX_CHARS,
  type ShapeSnapshotPayloadResult,
  type BuildChatPromptInput,
  type BuildChatPromptOutput,
  type PromptEngagement,
  type PromptSnapshot,
  type PromptAttachedSheet,
  type PromptHistoryMessage,
  type PromptContentBlock,
  type PromptOutputMessage,
  type PromptFrameworkAtom,
  type PromptAtomTypeDescription,
  type SnapshotFocusBlocksStats,
  type SnapshotFocusBlocksResult,
} from "./promptFormatter";
