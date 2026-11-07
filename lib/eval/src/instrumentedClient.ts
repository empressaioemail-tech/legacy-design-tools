/**
 * Instrumented Anthropic SDK client wrapper.
 *
 * Wraps an `Anthropic` instance so every `messages.create` call records
 * `usage` (input/output tokens) + wall-clock duration + computed USD
 * cost into an in-memory ring. The runners feed the captured list into
 * the rubric scorers; the values land on `eval_runs.totalCostUsd` and
 * `eval_runs.totalDurationMs`.
 *
 * Design choice: wrap instead of patching the singleton. The
 * `@workspace/integrations-anthropic-ai` client at
 * `lib/integrations-anthropic-ai/src/client.ts` is consumed by many
 * high-velocity surfaces; modifying its singleton would couple the
 * eval harness to that surface area. The engines already accept an
 * `anthropicClient` option (`generateFindings({ anthropicClient })`,
 * `generateBriefing({ anthropicClient })`), so the eval runner passes
 * in the wrapped client and captures spend per call without touching
 * production code paths.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicCallRecord } from "./types";

/**
 * Anthropic per-million-token pricing for the models the engine calls.
 * Update when Anthropic publishes new pricing.
 *
 * Source: Anthropic public pricing page at the time of writing.
 * Model id pinning lives in
 *   - `lib/finding-engine/src/anthropicGenerator.ts:38` (FINDING_ANTHROPIC_MODEL)
 *   - `lib/briefing-engine/src/anthropicGenerator.ts` (briefing model)
 */
const PRICE_TABLE_PER_MTOKEN: Record<
  string,
  { input: number; output: number }
> = {
  // Anthropic first-party list prices, cached 2026-10-06 (per MTok).
  // Thinking tokens are billed as output tokens.
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  // Claude Sonnet 4.5 — formerly the engine default (Phase 1A pinning).
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  // Anthropic SDK sometimes returns the full versioned id.
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 },
  // Fallbacks for the Haiku-class models the briefing engine may
  // be flipped to during cost-sensitive runs.
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
};

/** Compute USD cost from usage tokens + model id. */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const prices = PRICE_TABLE_PER_MTOKEN[model];
  if (!prices) {
    // Unknown model — record zero rather than crash. Operator inspects
    // the run's per-call details and updates the price table.
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * prices.input +
    (outputTokens / 1_000_000) * prices.output
  );
}

/**
 * Wrap an Anthropic client. The returned object is structurally
 * compatible with the SDK's `Anthropic` type so it slots into
 * `generateFindings({ anthropicClient: instrumented })` without a
 * cast.
 *
 * The wrapper exposes a `captured` array of call records so the runner
 * can consume + clear between fixture runs.
 */
export interface InstrumentedAnthropicClient {
  client: Anthropic;
  /** Pop the recorded calls and reset for the next run. */
  drain(): AnthropicCallRecord[];
}

export function instrumentAnthropicClient(
  upstream: Anthropic,
): InstrumentedAnthropicClient {
  const captured: AnthropicCallRecord[] = [];
  // Wrap a create-style method so each non-streaming response records usage.
  // Both `messages.create` and `beta.messages.create` are wrapped: the
  // code-citing engines call the beta endpoint (server-side refusal
  // fallback, G-309 A23), and spend must still be captured. We mutate the
  // upstream client deliberately — passing the wrapped object to
  // `generateFindings` as the `anthropicClient` option leaves all other
  // SDK surfaces intact via direct delegation on the same object.
  function wrap<A extends unknown[], R>(
    target: { create: (...args: A) => R },
  ): void {
    const originalCreate = target.create.bind(target);
    (target.create as unknown) = async function instrumentedCreate(
      ...args: A
    ): Promise<Awaited<R>> {
      const t0 = Date.now();
      const response = (await originalCreate(...args)) as Awaited<R>;
      const durationMs = Date.now() - t0;

      // Streaming responses don't expose usage in the same shape — we
      // only instrument non-streaming calls (which is what both engines
      // use today). If a streaming path lands later, extend the
      // instrumentation here rather than silently dropping spend.
      const r = response as {
        usage?: { input_tokens?: number; output_tokens?: number } | null;
        model?: unknown;
      };
      if (r && typeof r === "object" && "usage" in r && r.usage) {
        const model = typeof r.model === "string" ? r.model : "unknown";
        const inputTokens = r.usage.input_tokens ?? 0;
        const outputTokens = r.usage.output_tokens ?? 0;
        captured.push({
          durationMs,
          inputTokens,
          outputTokens,
          model,
          costUsd: computeCostUsd(model, inputTokens, outputTokens),
        });
      }

      return response;
    };
  }
  wrap(upstream.messages);
  wrap(upstream.beta.messages);

  return {
    client: upstream,
    drain() {
      const out = captured.slice();
      captured.length = 0;
      return out;
    },
  };
}
