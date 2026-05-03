/**
 * Public re-export surface for portal-ui test helpers. Imported as
 * `@workspace/portal-ui/test-utils` from both `lib/portal-ui` tests
 * and the artifacts that mount portal-ui components.
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
export {
  makeEngagementPageMockHooks,
  buildClassification,
  buildSeverityRollup,
  buildApplicantHistory,
  buildFinding,
  buildUser,
  sampleClassifiedSubmissions,
} from "./engagementPageMocks";
export type { EngagementPageMockHooksOptions } from "./engagementPageMocks";
// Render fixtures co-located with the engagement-page mock factory.
export {
  fixtureReadyStill,
  fixtureRenderingStill,
  fixtureFailedStill,
  fixtureReadyStillOutput,
  fixtureReadyStillDetail,
  fixtureRenderingStillDetail,
  fixtureFailedStillDetail,
  fixtureElevationSetInFlight,
  fixtureElevationSetDetail,
} from "./renderFixtures";
