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
} from "./types";

export {
  FINDING_ANTHROPIC_MODEL,
  FINDING_ANTHROPIC_MAX_TOKENS,
  FindingGeneratorError,
  callAnthropicGenerator,
  parseAnthropicResponse,
  type RawFindingDraft,
} from "./anthropicGenerator";

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
