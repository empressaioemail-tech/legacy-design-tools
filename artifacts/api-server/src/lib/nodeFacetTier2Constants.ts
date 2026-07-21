/**
 * Side-effect-free constants shared between the Tier-2 node-facet bake CLI
 * (`../nodeFacetBakeTier2Cli.ts`) and the anonymous read route
 * (`../routes/brokerageNodeFacets.ts`).
 *
 * Mirrors `nodeFacetTier1Constants.ts` and exists for the SAME boot-safety
 * reason: the read route must resolve the Tier-2 adapter key WITHOUT importing
 * the Tier-2 bake CLI, whose top-level `import pg` + `main()` entrypoint guard
 * is unreliable in the production bundle (a misfire ran the bake at server boot
 * and `process.exit(1)`'d before the server could listen). Keeping this pure
 * (no imports, no DB, no main) breaks that chain, so the route can compose the
 * flood facet onto the card's payload with zero risk to boot.
 *
 * VALUE INTEGRITY: `TIER2_ADAPTER_KEY` MUST stay exactly "node-facets:tier2" —
 * the Tier-2 bake writes `place_layer_snapshots` rows under that `adapter_key`,
 * so a changed value would make the read endpoint select zero Tier-2 rows and
 * the card would silently lose flood. The CLI re-exports THIS constant so the
 * write key and the read key can never drift.
 */

/** The `adapter_key` under which the Tier-2 node-facet bake writes snapshots. */
export const TIER2_ADAPTER_KEY = "node-facets:tier2";
