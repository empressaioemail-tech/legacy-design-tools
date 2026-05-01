/**
 * Public surface for `@workspace/briefing-engine`.
 *
 * The api-server consumes:
 *   - {@link generateBriefing} — top-level entry point.
 *   - {@link resolveBriefingLlmMode} — env-derived mode for startup logs.
 *   - The type bundle (`BriefingSections`, `GenerateBriefingInput`, …).
 *
 * Internal modules (`prompt`, `mockGenerator`, `anthropicGenerator`,
 * `citationValidator`, `sourceCategories`) are re-exported for tests
 * and downstream packages that want to swap one piece without
 * forking the whole engine.
 */

export {
  generateBriefing,
  resolveBriefingLlmMode,
  type GenerateBriefingOptions,
} from "./engine";

export {
  type BriefingLlmMode,
  type BriefingSections,
  type BriefingSourceInput,
  type CodeSectionInput,
  type GenerateBriefingInput,
  type GenerateBriefingResult,
  HEAVY_SECTIONS,
  LIGHT_SECTIONS,
  SECTION_LABELS,
} from "./types";

export {
  BRIEFING_ANTHROPIC_MODEL,
  BRIEFING_ANTHROPIC_MAX_TOKENS,
  AnthropicGeneratorError,
  callAnthropicGenerator,
  parseAnthropicResponse,
} from "./anthropicGenerator";

export {
  validateSectionCitations,
  type CitationResolvers,
  type CitationScanResult,
} from "./citationValidator";

export { generateMockBriefing } from "./mockGenerator";

export { BRIEFING_SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

export {
  categorizeLayerKind,
  citationLabel,
  groupSourcesBySection,
  SECTIONS_WITH_NO_CITATIONS,
  SECTIONS_WITH_SOURCE_CITATIONS,
  type SourceCitingSection,
} from "./sourceCategories";
