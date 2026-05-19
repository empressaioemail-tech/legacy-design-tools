import type { FixtureGroundTruth } from "../types";

/**
 * Arena Roja R1 — load-bearing finding-recall fixture (per dispatch
 * 2026-05-18_cc-agent-EVAL_eval_harness §Deliverable 3).
 *
 * **PLACEHOLDER.** Two prerequisites must land before this fixture can
 * produce meaningful scores:
 *
 *   1. The 11 outstanding SCA review comments from the 2026-04-23
 *      Shums Coda Associates review (SCA Job #20260205-0052,
 *      referenced by P:/doc_repo/40a_customer_zero_observations_arena_roja_2026_05_06.md).
 *      40a documents Claude.ai's *limitations* observed during the
 *      workflow; the actual verbatim comment text lives in an external
 *      session export and is not yet in doc_repo. Once provided, each
 *      comment becomes one `ExpectedFinding` entry with category,
 *      severity, expectedCitationAtomId (when the comment cites a
 *      code section), and the comment text.
 *
 *   2. Arena Roja R1 must be seeded as a real engagement in
 *      `lib/db/src/seed.ts` (DA-1 stream item in
 *      P:/doc_repo/42_design_accelerator_program_plan.md confirms it is
 *      not yet seeded — line 51: "Source of customer-zero observations
 *      doc; not yet a seeded test project").
 *
 * The runner halts on this fixture when `placeholder` is set, recording
 * a `failed` eval_run row with the blocker reason — preferable to
 * scoring against an empty ground-truth array, which would produce a
 * misleading 1.0 recall score.
 */
export const arenaRojaR1Fixture: FixtureGroundTruth = {
  key: "arena-roja-r1",
  label: "Arena Roja R1 (Grand County, UT) — PLACEHOLDER",
  jurisdictionKey: "grand_county_ut",
  engagementId: null,
  submissionId: null,
  expectedFindings: [],
  retrievalQueries: [],
  placeholder: {
    blocker:
      "Arena Roja R1 SCA review comments + seed.ts engagement entry required. See header comment for prerequisites.",
    eta: "Gated on Nick providing the 11 SCA comment texts and approving a seed.ts entry.",
  },
};
