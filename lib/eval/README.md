# @workspace/eval

Eval harness for the plan-review engine (finding-engine + briefing-engine + codes retrieval).

Per [dispatch 2026-05-18_cc-agent-EVAL](../../../doc_repo/_dispatches/2026-05-18_cc-agent-EVAL_eval_harness.md), the durable assets here — the **rubric** ([src/rubric.ts](src/rubric.ts)) and the **test-project fixture canon** ([src/fixtures/](src/fixtures/)) — are designed to outlive the legacy engine and port to `hauska-engine` after the ADR-008 factor-out. The runner plumbing (CLI, DB queries, instrumented client) moves with the engine; the scoring functions stay.

## Status

**v1 — durable assets only.** This package ships:

- Pure rubric scoring functions + unit tests
- Schema definitions for `eval_runs` / `eval_scores` / `eval_baselines` (in `lib/db/src/schema/`)
- Runner code wrapping the three engines
- Instrumented Anthropic client capturing `usage` and wall-clock duration
- Fixtures for Musgrave + Seguin
- Arena Roja R1 fixture placeholder (recall harness wired; ground-truth array empty)
- CLI surface (`pnpm eval run | baseline | report`)
- GitHub Actions workflow scaffold (warn-only, bypass until baselines exist)

**Gated on operator action before any real eval numbers exist:**

- `DATABASE_URL` set → `pnpm --filter @workspace/db run push` to create the three eval tables → `pnpm --filter @workspace/db run test:fixture:schema` to refresh the schema fixture template
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` + `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` set → CLI startup works (the `integrations-anthropic-ai` module throws at import time without both)
- `OPENAI_API_KEY` set → retrieval uses the vector path; without it, `retrieve-*` rubric scores reflect the lexical fallback rather than production behavior
- Arena Roja R1 SCA review comments (the 11 known-good findings) provided → fixture's `expectedFindings` array populated → `seed.ts` extended to seed the engagement → finding-recall scoring becomes meaningful

## Quick reference

### Run the eval CLI

```bash
# All fixtures
pnpm --filter @workspace/eval run eval -- run --all

# One fixture
pnpm --filter @workspace/eval run eval -- run musgrave

# Capture baselines for all fixtures (after operator review)
pnpm --filter @workspace/eval run eval -- baseline --all

# Print a scorecard for a specific run
pnpm --filter @workspace/eval run eval -- report <evalRunId>
```

### Force engines into prod mode

Both engines default to mock per `AIR_FINDING_LLM_MODE` / `BRIEFING_LLM_MODE`. The eval CLI sets `mode: "anthropic"` explicitly on every runner call regardless of env, so eval results always reflect the real prompt path.

### Rubric components — v1 scope

| Component | Unit | Source |
|---|---|---|
| `citation-validity` | fraction | `finding_runs.invalidCitationCount` / total citations emitted. Inverse: higher = better. |
| `citation-accuracy` | fraction | LLM-graded (Claude Sonnet 4.5 judges "does this citation support the claim?"). `requiresHumanReview: true` on high-stakes. |
| `finding-recall` | fraction | (engine-surfaced ∩ ground-truth) / \|ground-truth\|. Per fixture. |
| `finding-precision` | fraction | Surfaced-not-in-ground-truth count. v1 does NOT auto-score — sample is logged for human review. |
| `retrieval-top3` | fraction | Per [49 §B.4](../../../doc_repo/49_code_ingestion_pipeline.md): query → retrieval → expected atom in top 3. |
| `retrieval-section-number` | fraction | Section-number lookup. 100% target. |
| `retrieval-cross-ref` | fraction | Cross-reference resolution. 95% target. **Expected to score low** — the legacy engine has no `code-cross-reference` graph traversal; this component surfaces the gap for hauska-engine. |
| `latency-finding-p50/p95/p99` | ms | Wall-clock per finding-engine call. |
| `latency-briefing-p50/p95/p99` | ms | Wall-clock per briefing-engine call. |
| `latency-retrieval-p50/p95/p99` | ms | Wall-clock per retrieval call. |
| `cost-per-finding-run` | usd | Sum of `usage.input_tokens × input_price + usage.output_tokens × output_price` from the instrumented client. |
| `cost-per-jurisdiction` | usd | Aggregation over all eval runs scoped to a jurisdiction. Tracks structural-commitment-#3 ($200/jurisdiction). |

**Deferred (slot reserved in schema, no scoring code):** `mode-budget-conformance`, `geometric-reasoning-accuracy`, `sheet-content-extraction-fidelity`, `bim-model-symmetry`.

### Anthropic pricing constants

`src/instrumentedClient.ts` carries the Claude Sonnet 4.5 input/output token prices used by the cost rubric. **Update these whenever Anthropic publishes new pricing.**

## Portability notes for hauska-engine

When the engine factors out per ADR-008, port these files first:

1. [src/rubric.ts](src/rubric.ts) — pure functions, zero IO. Drop in.
2. [src/fixtures/](src/fixtures/) — engagement IDs change, but the fixture shape + ground-truth arrays are durable.
3. [src/types.ts](src/types.ts) — `RubricComponentKey`, `FixtureGroundTruth`, etc.

Leave behind (legacy-engine-specific):

- `src/runners/` (wraps the legacy engines)
- `src/db.ts` (queries legacy Postgres schema)
- `src/cli.ts` (legacy workspace pnpm shape)
- `src/instrumentedClient.ts` (probably ports, but cost-component logic should live in hauska-engine's instrumentation layer)
