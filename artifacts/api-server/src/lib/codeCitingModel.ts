/**
 * Model id, effort and refusal helper shared by the Ask chat routes.
 * Re-exported here (constants and a pure helper, no engine entry point) so
 * route files do not import the engine packages directly (ADR-008 audit in
 * lib/__tests__/engineSpineUngatedPaths.test.ts).
 */
export {
  CODE_CITING_ANTHROPIC_MODEL,
  CODE_CITING_MAX_TOKENS,
  CODE_CITING_FALLBACK_BETAS,
  CODE_CITING_FALLBACKS,
  CODE_CITING_OUTPUT_CONFIG_LOW,
  isAnthropicRefusal,
  isAnthropicTruncated,
} from "@workspace/briefing-engine";
