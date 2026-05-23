/**
 * Barrel for `@workspace/mnml-client` v2. The package exposes:
 *
 *   - {@link MnmlClient} — the pluggable interface Spec 54 v2 §6.1 names
 *   - {@link MockMnmlClient} / {@link HttpMnmlClient} — the two implementations
 *   - {@link createMnmlClient} — env-driven factory (mode = mock | http)
 *   - {@link getMnmlClient} / {@link setMnmlClient} — lazy singleton + test override
 *   - {@link validateMnmlEnvAtBoot} — boot-time fail-fast for http mode
 *   - {@link MnmlError} + {@link RenderRequest} + {@link RenderStatusResult} types
 *
 * The client is wired into api-server boot via {@link validateMnmlEnvAtBoot}
 * but is not yet consumed by any route — DA-RP-1 (V1-4) wires the trigger
 * endpoint that actually invokes {@link MnmlClient.triggerRender} from a
 * request handler.
 */

export {
  MnmlError,
  noopMnmlLogger,
  type AiEraserRequest,
  type ArchDiffusionRequest,
  type CreditsResult,
  type InpaintRequest,
  type MnmlClient,
  type MnmlErrorKind,
  type MnmlLogger,
  type PromptGeneratorRequest,
  type PromptGeneratorResult,
  type RenderEnhancerRequest,
  type RenderOutputRole,
  type RenderRequest,
  type RenderStatus,
  type RenderStatusResult,
  type StyleTransferRequest,
  type TimeOfDay,
  type TriggerRenderResult,
  type UpscaleRequest,
  type VideoAiRequest,
  type Weather,
} from "./types";

export { MockMnmlClient, type MockMnmlClientOptions } from "./mockClient";
export { HttpMnmlClient, type HttpMnmlClientOptions } from "./httpClient";

export {
  __mnmlClientIsFromEnvForTests,
  createMnmlClient,
  getMnmlClient,
  resolveMnmlRenderMode,
  setMnmlClient,
  validateMnmlEnvAtBoot,
  type CreateMnmlClientOptions,
  type MnmlRenderMode,
} from "./factory";

export {
  POWER_TOOL_COST_CREDITS,
  RENDER_COST_CREDITS,
  actualDebitedCredits,
  estimatePowerToolCost,
  estimateRenderCost,
  type DomainRenderKind,
  type PowerToolSourceType,
  type RenderCostBreakdownEntry,
  type RenderCostEstimate,
} from "./cost";
