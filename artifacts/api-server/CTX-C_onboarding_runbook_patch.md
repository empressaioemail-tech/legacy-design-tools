# Proposed edit to P:/doc_repo/90_runbooks/factory_onboarding_runbook.md

CTX-C does not commit doc_repo. This is the exact text change for doc-repo-26
(or whoever lands doc_repo edits) to apply. Replace Step Z7 (lines 80-92) with
the text below — it's the same step, renamed to cover both halves, plus a new
paragraph naming what used to be silently skipped.

---

**Step Z7 — Tier-1 bake + CAD-roll patch (ldt side).** RECON FIRST: does the
Tier-1 bake CLI scope to only the new city, or does it always run county-wide?
For Elgin, no Elgin-only flag existed; the CLI only supports `--county=<fips>`.

CTX-C finding (2026-09-07, P-124): the bake half of this step writes
`baseFacts.cadRoll` ALL-NULL by design (`nodeFacetBakeTier1Cli.ts:507-514`) —
population is a separate pass, `nodeFacetPatchCadRollFromCadPropertyCli.ts`,
which this step previously did not name. That gap meant the patch had never
run for any of the six Central-TX counties: cadRoll (market/assessed/land/
improvement value, living area, year built, legal description) read as false
absence everywhere, and `facetScore`'s monotonic guard does not count cadRoll
as a coverage dimension, so a re-bake without the patch silently re-nulls it
even at an equal-or-better score — this is not a one-time fix, it recurs on
every future bake unless it's part of the same command. Run BOTH halves as
one command:

```
pnpm --filter @workspace/api-server node-facet-bake-tier1-with-cad-roll -- --county=48021
```

(`nodeFacetBakeTier1WithCadRollCli.ts`, added by CTX-C: runs the Tier-1 bake
then the cad-roll patch for the same county and the same `--dry-run` flag, so
there's no longer a way to run one half and skip the other. Bake-only flags
like `--prop-ids-file` still pass through to the bake step; the patch step
has no scoped mode today and always runs whole-county.)

The patch step has its own integrity gate CTX-C added the same day: the
propId-to-`cad_property` join it uses carries no collision check by default,
and two of the six counties proved it matters at material rates (full
population counts, not samples): Hays (48209) 27.8% of propId-matched rows
landed on a different property (37,473/134,606); Travis (48453) 2.9%
(14,403/492,848) — smaller rate, but at Travis's scale that is 14,403 real
parcels that would have received another parcel's dollar values with no
absence marker. The patch cross-validates every match
against the existing snapshot's situs address (`corroborateCadPropertyMatchBySitus`
in `cadRollValue.ts`) and writes honest absence, never a fabricated value, on
a proven disagreement. Bastrop, Caldwell, McLennan, Williamson measured 0% (or
near-0%) disagreement. Expect the patch step's dry-run JSON to report
`situsAgree` / `situsInconclusive` / `situsDisagree` counts — a nonzero
`situsDisagree` is the gate working, not a bug in the run.

Run once dry (both CLIs support the same `--dry-run` flag; the wrapper passes
it through to both) and once for real. HARD CONSTRAINT: the already-certified
city's snapshot data must be provably safe — either idempotent-identical or
untouched. The planner ruling that made a county-wide re-bake safe for Bastrop
city was that `shouldPromote` is monotonic (an equal-score timestamp refresh
is allowed, never a downgrade); Bastrop city's Tier-1 zoning count was
verified UNCHANGED after the run (5,773 before and after). Verify this same
invariant explicitly for any future re-bake — do not assume monotonicity
holds without checking the promote logic. Note that this invariant does NOT
cover cadRoll (see above) — verify cadRoll separately by re-running the patch
step's dry-run and confirming the accounted/absent split matches expectation,
not by trusting the bake's own promote check.

[... rest of original Z7 body (expected output shape, post-verify counts,
ABORT/FALLBACK) unchanged — applies to the bake half only ...]

---

Also worth a line near CTX-F's readiness-gate section or wherever
`LANDUSE_JOIN_DISABLED_FIPS_SEED` is referenced elsewhere in this runbook (I
didn't find one, so maybe nowhere): Williamson's inclusion in that seed set
is justified by a collision from a since-retired R-prefix strip
(`joinNormalize.ts` header). CTX-C live-verified the CURRENT propId join for
Williamson at 0% disagreement (644/644 situs-agree on an 800-row TABLESAMPLE,
cross-checked against a full-population run). Routed to CTX-G
(cente-ae, P:/tmp/ctx-g-ledger) as the ledger owner — not acted on here.
