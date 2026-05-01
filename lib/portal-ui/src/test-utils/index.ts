/**
 * Public re-export surface for portal-ui test helpers (Task #382).
 * Imported as `@workspace/portal-ui/test-utils` from both
 * `lib/portal-ui` tests and the artifacts that mount portal-ui
 * components.
 */
export {
  MockApiError,
  createMutationCapture,
  makeCapturingMutationHook,
  createQueryKeyStubs,
  noopQueryHook,
  noopMutationHook,
} from "./mockApiClient";
export type {
  MutationOptions,
  MutationCapture,
} from "./mockApiClient";
export { makeEngagementPageMockHooks } from "./engagementPageMocks";
export type { EngagementPageMockHooksOptions } from "./engagementPageMocks";
