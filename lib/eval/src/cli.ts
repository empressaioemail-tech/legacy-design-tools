#!/usr/bin/env tsx
/**
 * Eval CLI. Three subcommands:
 *
 *   pnpm eval run <fixture | --all>     Run the harness, persist scores.
 *   pnpm eval baseline <fixture | --all> Promote the latest run's scores
 *                                        to baselines.
 *   pnpm eval report <evalRunId>         Pretty-print a saved scorecard.
 *
 * The CLI lazily imports `@workspace/integrations-anthropic-ai` so
 * baseline/report subcommands work without the Anthropic env vars; the
 * `run` subcommand fails fast with a clear message when the vars are
 * absent.
 *
 * **Status (v1):** This file ships the surface area. Two prerequisites
 * gate the `run` subcommand from producing real numbers:
 *   1. The three eval tables exist in the target DB
 *      (`pnpm --filter @workspace/db run push`).
 *   2. AI_INTEGRATIONS_ANTHROPIC_{API_KEY,BASE_URL} + DATABASE_URL set.
 *
 * The `baseline` subcommand additionally requires that at least one
 * completed `eval_runs` row exists for the fixture.
 */

import { execSync } from "node:child_process";
import {
  RUBRIC_CATALOG,
  type RetrievalSample,
} from "./rubric";
import { FIXTURE_BY_KEY, FIXTURES } from "./fixtures";
import { aggregateRun, formatScore } from "./aggregator";
import type { FixtureGroundTruth } from "./types";

type Subcommand = "run" | "baseline" | "report" | "help";

interface CliArgs {
  subcommand: Subcommand;
  fixture?: string;
  all?: boolean;
  ci?: boolean;
  evalRunId?: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const [, , sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    return { subcommand: "help" };
  }
  if (sub !== "run" && sub !== "baseline" && sub !== "report") {
    console.error(`Unknown subcommand: ${sub}`);
    return { subcommand: "help" };
  }
  const args: CliArgs = { subcommand: sub };
  for (const token of rest) {
    if (token === "--all") args.all = true;
    else if (token === "--ci") args.ci = true;
    else if (token.startsWith("--")) {
      console.error(`Unknown flag: ${token}`);
      return { subcommand: "help" };
    } else if (!args.fixture && !args.evalRunId) {
      if (sub === "report") args.evalRunId = token;
      else args.fixture = token;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`@workspace/eval CLI

Usage:
  pnpm --filter @workspace/eval run eval -- run <fixture | --all> [--ci]
  pnpm --filter @workspace/eval run eval -- baseline <fixture | --all>
  pnpm --filter @workspace/eval run eval -- report <evalRunId>

Fixtures:
${FIXTURES.map((f) => `  - ${f.key.padEnd(16)} ${f.label}${f.placeholder ? "  [PLACEHOLDER]" : ""}`).join("\n")}

Required env for \`run\`:
  DATABASE_URL
  AI_INTEGRATIONS_ANTHROPIC_API_KEY
  AI_INTEGRATIONS_ANTHROPIC_BASE_URL
  OPENAI_API_KEY   (optional — without it, retrieval uses the lexical
                    fallback and retrieval-* scores reflect that)
`);
}

function currentCommitHash(): string {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

function resolveFixtures(args: CliArgs): FixtureGroundTruth[] {
  if (args.all) return [...FIXTURES];
  if (!args.fixture) {
    console.error("Specify a fixture key or --all");
    process.exit(2);
  }
  const f = FIXTURE_BY_KEY.get(args.fixture);
  if (!f) {
    console.error(
      `Unknown fixture: ${args.fixture}. Available: ${[...FIXTURE_BY_KEY.keys()].join(", ")}`,
    );
    process.exit(2);
  }
  return [f];
}

async function cmdRun(args: CliArgs): Promise<void> {
  const requiredEnv = [
    "DATABASE_URL",
    "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
    "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
  ];
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `Missing required env for \`run\`: ${missing.join(", ")}\n` +
        `See lib/eval/README.md for setup.`,
    );
    process.exit(2);
  }

  // Lazy import — only after env check passes — so the CLI doesn't
  // trip the upstream env-throw in the integrations module on a
  // help/report invocation.
  const { runFindingEngine } = await import("./runners/findingEngine");
  const { runBriefingEngine } = await import("./runners/briefingEngine");
  const { runRetrieval } = await import("./runners/retrieval");
  const { instrumentAnthropicClient } = await import("./instrumentedClient");
  const { createAnthropicClient } = await import(
    "@workspace/integrations-anthropic-ai"
  );
  const dbModule = await import("./db");

  const fixtures = resolveFixtures(args);
  const commit = currentCommitHash();

  for (const fixture of fixtures) {
    const startedAt = new Date();
    const { id: evalRunId } = await dbModule.createEvalRun({
      engagementId: fixture.engagementId,
      fixtureKey: fixture.key,
      engineVersion: commit,
      triggerSource: args.ci ? "ci" : "manual",
    });

    process.stdout.write(`\n=== ${fixture.label} (run ${evalRunId}) ===\n`);

    if (fixture.placeholder) {
      const msg = fixture.placeholder.blocker;
      process.stdout.write(`[skipped] ${msg}\n`);
      await dbModule.completeEvalRun({
        id: evalRunId,
        state: "failed",
        error: `placeholder fixture: ${msg}`,
      });
      continue;
    }

    try {
      const fresh = instrumentAnthropicClient(createAnthropicClient());

      const findingOut = await runFindingEngine(fixture, fresh);
      const briefingOut = await runBriefingEngine(fixture, fresh);
      const retrievalOut = await runRetrieval(fixture);

      const samples = [
        findingOut.sample,
        briefingOut.sample,
        retrievalOut.sample,
      ];

      const aggregate = aggregateRun({
        fixture,
        engineVersion: commit,
        startedAt,
        findingResult: {
          findings: findingOut.result.findings,
          invalidCitations: findingOut.result.invalidCitations,
        },
        retrievalSamples: retrievalOut.retrievalSamples,
        samples,
      });

      const baselines = await dbModule.loadBaselinesFor(fixture.key);
      await dbModule.insertScores(evalRunId, aggregate.scores, baselines);
      await dbModule.completeEvalRun({
        id: evalRunId,
        state: "completed",
        totalCostUsd: aggregate.totalCostUsd,
        totalDurationMs: aggregate.totalDurationMs,
      });

      for (const score of aggregate.scores) {
        process.stdout.write(`  ${formatScore(score)}\n`);
      }
      process.stdout.write(
        `  --- total cost $${aggregate.totalCostUsd.toFixed(4)} / ${aggregate.totalDurationMs} ms ---\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  [failed] ${message}\n`);
      await dbModule.completeEvalRun({
        id: evalRunId,
        state: "failed",
        error: message.slice(0, 1024),
      });
    }
  }
}

async function cmdBaseline(args: CliArgs): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set for `baseline`.");
    process.exit(2);
  }
  const dbModule = await import("./db");
  const fixtures = resolveFixtures(args);
  const commit = currentCommitHash();

  for (const fixture of fixtures) {
    const latest = await dbModule.loadLatestEvalRun(fixture.key);
    if (!latest) {
      process.stdout.write(
        `[skip] ${fixture.key}: no completed eval_runs yet — run eval first.\n`,
      );
      continue;
    }
    const { scores } = await dbModule.loadEvalRun(latest.id);
    for (const score of scores) {
      const meta = RUBRIC_CATALOG[score.componentKey as keyof typeof RUBRIC_CATALOG];
      if (!meta) continue;
      await dbModule.upsertBaseline({
        fixtureKey: fixture.key,
        componentKey: score.componentKey as keyof typeof RUBRIC_CATALOG,
        baselineScore: Number(score.score),
        regressionThreshold: meta.defaultRegressionThreshold,
        commitHash: commit,
      });
    }
    process.stdout.write(
      `[baseline] ${fixture.key}: ${scores.length} components promoted from run ${latest.id}\n`,
    );
  }
}

async function cmdReport(args: CliArgs): Promise<void> {
  if (!args.evalRunId) {
    console.error("Specify an evalRunId");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set for `report`.");
    process.exit(2);
  }
  const dbModule = await import("./db");
  const { run, scores } = await dbModule.loadEvalRun(args.evalRunId);
  if (!run) {
    console.error(`No eval_run with id ${args.evalRunId}`);
    process.exit(1);
  }
  process.stdout.write(
    `Eval run ${run.id}\n` +
      `  fixture:    ${run.fixtureKey}\n` +
      `  engine:     ${run.engineVersion}\n` +
      `  state:      ${run.state}\n` +
      `  started:    ${run.startedAt.toISOString()}\n` +
      `  completed:  ${run.completedAt ? run.completedAt.toISOString() : "—"}\n` +
      `  cost:       $${run.totalCostUsd ?? "—"}\n` +
      `  duration:   ${run.totalDurationMs ?? "—"} ms\n` +
      `  trigger:    ${run.triggerSource}\n\n`,
  );
  for (const score of scores) {
    const meta = RUBRIC_CATALOG[score.componentKey as keyof typeof RUBRIC_CATALOG];
    const passedFlag =
      score.passedThreshold === null
        ? ""
        : score.passedThreshold
          ? "  ✓"
          : "  ✗ REGRESSION";
    process.stdout.write(
      `  ${(meta?.label ?? score.componentKey).padEnd(40)} ${String(score.score).padEnd(14)} ${score.scoreUnit}${passedFlag}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.subcommand) {
    case "run":
      await cmdRun(args);
      break;
    case "baseline":
      await cmdBaseline(args);
      break;
    case "report":
      await cmdReport(args);
      break;
    case "help":
      printHelp();
      break;
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

// Avoid an unused-import warning: aggregator/RetrievalSample is part
// of the public surface other entry points may consume.
export type { RetrievalSample };
