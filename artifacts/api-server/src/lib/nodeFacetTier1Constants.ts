/**
 * Side-effect-free constants shared between the Tier-1 node-facet bake CLI
 * (`../nodeFacetBakeTier1Cli.ts`) and the anonymous read route
 * (`../routes/brokerageNodeFacets.ts`).
 *
 * This module exists so the server boot graph (app.ts -> routes -> here) can
 * pull the adapter key WITHOUT importing the bake CLI. The CLI top-level
 * imports `pg` and runs `main()` under an entrypoint guard that is unreliable
 * in the production bundle; when the guard misfires, importing the CLI at
 * server boot ran the bake, which errored `--county=<fips> is required` and
 * `process.exit(1)` before the server could listen on PORT 8080. Keeping this
 * pure (no imports, no DB, no main) breaks that chain.
 *
 * VALUE INTEGRITY: `TIER1_ADAPTER_KEY` MUST stay exactly "node-facets:tier1"
 * — the deployed `place_layer_snapshots` rows carry that `adapter_key`, so a
 * changed value would make the read endpoint select zero rows.
 */

/** The `adapter_key` under which the Tier-1 node-facet bake writes snapshots. */
export const TIER1_ADAPTER_KEY = "node-facets:tier1";
