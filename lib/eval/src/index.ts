/**
 * Public surface for `@workspace/eval`.
 *
 * Consumed by:
 *   - `lib/eval/src/cli.ts` (the operator entry point)
 *   - Future integration tests that want to compose rubric + runners
 *
 * Internal modules are also re-exported so downstream callers can
 * import a single specifier without reaching across the package
 * boundary.
 */

export {
  // Rubric scoring functions (durable asset — ports to hauska-engine)
  scoreCitationValidity,
  scoreCitationAccuracy,
  scoreFindingRecall,
  scoreFindingPrecisionSample,
  findingMatchesExpected,
  scoreRetrievalTop3,
  scoreRetrievalSectionNumber,
  scoreRetrievalCrossRef,
  scoreLatency,
  scoreCostPerFindingRun,
  scoreCostPerJurisdiction,
  percentiles,
  RUBRIC_CATALOG,
  type RetrievalSample,
} from "./rubric";

export {
  // Types
  RUBRIC_COMPONENT_KEYS,
  type AnthropicCallRecord,
  type ComponentScore,
  type ExpectedFinding,
  type FixtureGroundTruth,
  type FixtureRunResult,
  type RetrievalQuery,
  type RubricComponentKey,
  type RunnerSample,
  type ScoreUnit,
} from "./types";

export {
  // Fixtures (canon)
  FIXTURES,
  FIXTURE_BY_KEY,
  musgraveFixture,
  seguinFixture,
  arenaRojaR1Fixture,
} from "./fixtures";

export {
  // Aggregator
  aggregateRun,
  formatScore,
  type AggregatorInput,
} from "./aggregator";

export {
  // Instrumented client
  instrumentAnthropicClient,
  computeCostUsd,
  type InstrumentedAnthropicClient,
} from "./instrumentedClient";
