/**
 * Barrel for `@workspace/mnml-client`. The package exposes:
 *
 *   - {@link MnmlClient} — the pluggable interface Spec 54 §5 names
 *   - {@link MockMnmlClient} / {@link HttpMnmlClient} — the two implementations
 *   - {@link createMnmlClient} — env-driven factory (mode = mock | http)
 *   - {@link getMnmlClient} / {@link setMnmlClient} — lazy singleton + test override
 *   - {@link validateMnmlEnvAtBoot} — boot-time fail-fast for http mode
 *   - {@link MnmlError} + {@link RenderRequest} + {@link RenderStatusResult} types
 *
 * The client is wired but NOT invoked anywhere in the api-server in
 * v1 — DA-RP-1 wires the trigger endpoint that actually consumes it.
 */

export {
  MnmlError,
  noopMnmlLogger,
  type CancelRenderResult,
  type ElevationRenderRequest,
  type ExteriorOrbitVideoRequest,
  type FlyOverVideoRequest,
  type InteriorWalkthroughVideoRequest,
  type MnmlClient,
  type MnmlErrorCode,
  type MnmlLogger,
  type RenderOutput,
  type RenderOutputFormat,
  type RenderOutputRole,
  type RenderRequest,
  type RenderStatus,
  type RenderStatusResult,
  type StillRenderRequest,
  type TimeOfDay,
  type TriggerRenderResult,
  type Vec3,
  type VideoDurationSeconds,
  type VideoFramerate,
  type VideoPathKind,
  type VideoRenderRequest,
  type VideoWaypoint,
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
