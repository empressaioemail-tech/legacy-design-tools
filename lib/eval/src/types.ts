/**
 * Public types for `@workspace/eval`. Kept narrow and IO-free so they
 * port to `hauska-engine` alongside `rubric.ts` without dragging
 * legacy-engine surfaces along.
 */

import type {
  EngineFinding,
  FindingCitation,
} from "@workspace/finding-engine";

/**
 * The closed set of rubric components shipped in v1. `componentKey`
 * columns on `eval_scores` / `eval_baselines` carry these literals.
 * Adding a key is a code change in rubric.ts; the DB schema deliberately
 * stores free text so promotions land via baseline-recapture rather
 * than migration.
 */
export const RUBRIC_COMPONENT_KEYS = [
  "citation-validity",
  "citation-accuracy",
  "finding-recall",
  "finding-precision",
  "retrieval-top3",
  "retrieval-section-number",
  "retrieval-cross-ref",
  "latency-finding-p50",
  "latency-finding-p95",
  "latency-finding-p99",
  "latency-briefing-p50",
  "latency-briefing-p95",
  "latency-briefing-p99",
  "latency-retrieval-p50",
  "latency-retrieval-p95",
  "latency-retrieval-p99",
  "cost-per-finding-run",
  "cost-per-jurisdiction",
] as const;

export type RubricComponentKey = (typeof RUBRIC_COMPONENT_KEYS)[number];

export type ScoreUnit = "fraction" | "ms" | "usd" | "count";

export interface ComponentScore {
  componentKey: RubricComponentKey;
  score: number;
  scoreUnit: ScoreUnit;
  /** Optional per-component evidence — written to eval_scores.details. */
  details?: unknown;
}

/**
 * One known-good finding the engine is expected to surface. The shape
 * mirrors what reviewers actually write in plan-review comments — a
 * code citation + a short description anchored to a category. The
 * recall scorer matches on `expectedCitationAtomId` (when present) OR
 * on `category` + a fuzzy match against finding text.
 */
export interface ExpectedFinding {
  /** Stable identifier within the fixture (e.g. "arena-roja-c01"). */
  id: string;
  /** Category the engine should classify this under. */
  category: EngineFinding["category"];
  /** Severity the reviewer assigned (engine should emit at least this severity). */
  severity: EngineFinding["severity"];
  /**
   * Code-section atom id the engine should cite. Optional because some
   * ground-truth findings are zoning / context comments without a single
   * pinpoint citation; the matcher falls back to category + text fuzzy
   * match for those.
   */
  expectedCitationAtomId?: string;
  /** Free-text reviewer comment, used by the text-fuzzy fallback. */
  text: string;
  /**
   * Some reviewer comments are interpretive ("verify framing meets
   * R602"). Mark those so the precision scorer does NOT count an
   * engine miss against precision (the engine might legitimately
   * conclude the issue does not apply after looking at the BIM).
   */
  optional?: boolean;
}

/**
 * One canonical retrieval query against a jurisdiction. The retrieval
 * scorer runs each query and checks (a) whether the expected atom id
 * appears in the top-3, (b) whether section-number lookups land
 * 1-for-1, and (c) whether cross-reference resolution returns the
 * pointed-to atoms.
 */
export interface RetrievalQuery {
  id: string;
  jurisdictionKey: string;
  question: string;
  /** Atom id the top-3 should contain (top-3 scoring). */
  expectedTop3AtomId?: string;
  /** Pure section-number lookup (e.g. "R301.2.1"). 100% target per 49 §B.4. */
  expectedSectionNumber?: string;
  /**
   * Cross-reference walk: query mentions "see § X"; the resolved atom
   * should appear in results. Expected to score low on the legacy
   * engine (no graph traversal — slot reserved for hauska-engine).
   */
  expectedCrossRefAtomId?: string;
}

/**
 * Per-fixture ground-truth bundle. Each fixture file in `src/fixtures/`
 * exports one of these.
 */
export interface FixtureGroundTruth {
  /** Stable fixture key, kebab-case. */
  key: string;
  /** Human-friendly label for scorecards. */
  label: string;
  jurisdictionKey: string;
  /**
   * Engagement id to bind the eval run to. Null for placeholder
   * fixtures (Arena Roja R1 until the engagement is seeded). The
   * runner skips engine calls when null and records the run as
   * `failed` with a "fixture not seeded" reason.
   */
  engagementId: string | null;
  /** Submission id for finding-engine runs. Null when engagementId is null. */
  submissionId: string | null;
  expectedFindings: ReadonlyArray<ExpectedFinding>;
  retrievalQueries: ReadonlyArray<RetrievalQuery>;
  /**
   * Set when the fixture is awaiting external input (e.g. Arena Roja
   * R1 awaiting SCA review comments). When true, the CLI exits with
   * a clear message rather than running against an empty ground-truth
   * array (which would produce misleading 1.0 / 0.0 scores).
   */
  placeholder?: {
    blocker: string;
    eta?: string;
  };
}

/**
 * One Anthropic call captured by the instrumented client. The runner
 * aggregates these into per-component cost + latency scores.
 */
export interface AnthropicCallRecord {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Computed at capture time using the price table in instrumentedClient. */
  costUsd: number;
}

/**
 * Runner output for one engine sub-call (finding, briefing, retrieval).
 * The aggregator turns a list of these into per-component scores.
 */
export interface RunnerSample {
  /** Which engine: `finding` | `briefing` | `retrieval`. */
  engine: "finding" | "briefing" | "retrieval";
  durationMs: number;
  anthropicCalls: ReadonlyArray<AnthropicCallRecord>;
  /** Engine-specific payload — typed by callers. */
  payload: unknown;
}

/**
 * What `pnpm eval run <fixture>` writes to `eval_runs` + `eval_scores`.
 * Used internally by the runner pipeline and surfaced by the CLI's
 * `report` command.
 */
export interface FixtureRunResult {
  fixtureKey: string;
  engineVersion: string;
  startedAt: Date;
  completedAt: Date;
  state: "completed" | "failed";
  error: string | null;
  totalCostUsd: number;
  totalDurationMs: number;
  scores: ReadonlyArray<ComponentScore>;
  /** All captured engine samples — kept off the DB but useful for CLI debug. */
  samples: ReadonlyArray<RunnerSample>;
}

/**
 * Convenience type re-export so rubric scorers don't need to reach
 * across the package boundary.
 */
export type { EngineFinding, FindingCitation };
