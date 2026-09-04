/**
 * Side-effect-free county coverage CLASSIFICATION, shared between the scorer
 * CLIs (`../countyCoverageScoreCli.ts`, `../countyFloodScoreCli.ts`,
 * `../countyGeometryScoreCli.ts`) and the rail-scoring engine that the
 * `/api/county-ledger` route pulls into the SERVER BOOT GRAPH
 * (`./railScoring/engine.ts`).
 *
 * Mirrors `nodeFacetTier2Constants.ts` and exists for the SAME boot-safety
 * reason, one level up. That file's header records that a CLI's "top-level
 * `import pg` + `main()` entrypoint guard is unreliable in the production
 * bundle (a misfire ran the bake at server boot and `process.exit(1)`'d before
 * the server could listen)". The rail-scoring capability reintroduced exactly
 * that shape through a different import, and on 2026-08-19 a canary deploy of
 * `5688aa31` failed with the Cloud Run message "container failed to start and
 * listen on the port defined provided by the PORT=8080 environment variable".
 *
 * THE MECHANISM, because "it imports a CLI" is not specific enough to prevent
 * a repeat. `countyCoverageScoreCli.ts` DOES carry an entrypoint guard:
 *
 *     function isDirectRun(): boolean {
 *       const entry = argv[1];
 *       return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
 *     }
 *
 * That guard is correct under `tsx`. It is defeated by bundling. `build.mjs`
 * folds every module into a single `dist/index.mjs`, so inside the bundle
 * `import.meta.url` IS the bundle's own URL, and the container's
 * `node artifacts/api-server/dist/index.mjs` makes `argv[1]` that same path.
 * The guard read TRUE at server boot, `main()` ran with an empty argv, and
 * `fail("pass --county=<fips> or --all")` called `process.exit(1)` before
 * Express ever listened. Adding a better guard does not fix this; keeping the
 * CLI out of the boot graph does.
 *
 * SO THIS FILE MUST STAY PURE. No `argv`, no `pg`, no `@workspace/db`, no
 * `main()`, no top-level statement that does anything. The only import is a
 * `import type`, which TypeScript and esbuild erase, so it creates no runtime
 * edge. If you are about to add a value import here, you are about to
 * reintroduce the outage.
 *
 * WHAT IS ENFORCED, not just documented: `scripts/checkBootGraphNoCliImports.mjs`
 * walks the static import graph from `src/index.ts` and fails if any `*Cli`
 * module is reachable, and `scripts/bootSmokeTest.mjs` starts the built bundle
 * and fails if it does not listen. Both run in `.github/workflows/pr-checks.yml`.
 * The comment in `nodeFacetTier2Constants.ts` was the whole control last time,
 * and prose does not enforce.
 *
 * WHAT DID NOT MOVE HERE, and why. `railThresholdPct`, `deriveRailState` and
 * `LANDUSE_JOIN_FACET_KEY` stay in `countyCoverageScoreCli.ts`: they read
 * `COUNTY_RAIL_DECLARATION` from `@workspace/db/schema`, nothing in the boot
 * graph imports them, and moving them would widen the change without removing
 * a hazard.
 */

import type { JoinIntegrityReport } from "./joinIntegrityGate";

export type Classification =
  | "real-at-ceiling"
  | "needs-crosswalk"
  | "true-source-gap"
  | "fabricated-blocked";

export interface FacetScore {
  facet: string;
  /** HONEST coverage 0..100 (a blocked land-use facet records 0). */
  honestCoveragePct: number;
  /** The integrity verdict; 'n/a' for facets with no owner oracle. */
  integrityVerdict: JoinIntegrityReport["verdict"] | "n/a";
  /** 0..1 owner-match rate, or null for n/a facets. */
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  sampled: number;
  classification: Classification;
}

export interface ClassifyInput {
  facet: string;
  /**
   * RAW coverage the join produced BEFORE gating, 0..100 — for land-use this
   * is the fabricated-or-real stamp rate; the classifier zeroes it when
   * blocked.
   */
  rawCoveragePct: number;
  /** Whether the SOURCE exists at all (e.g. a CAD roll is loaded). */
  sourcePresent: boolean;
  /** The gate verdict for facets with an owner oracle; null for n/a facets. */
  verdict: JoinIntegrityReport["verdict"] | null;
  ownerMatchRate: number | null;
  source: string | null;
  sourceVintage: string | null;
  sampled: number;
}

/**
 * Zoning/envelope source presence is the SOURCE COLUMN, not a positive stamp
 * rate. `stampedPct > 0` manufacturing is SF-24.
 */
export function sourcePresentForStampFacet(
  hasSourceColumn: boolean,
  _stampedPct: number,
): boolean {
  return hasSourceColumn;
}

/**
 * Classify a facet from its raw coverage + gate verdict + source presence.
 * PURE. This is the load-bearing decision the ledger records, so it is
 * separated from all I/O and unit-tested directly.
 *
 * Rules (in priority order):
 *  1. verdict 'block'                -> fabricated-blocked, honest coverage 0.
 *     (A proven fabrication is stored as honest-absence, never the stamp rate.)
 *  2. no source at all               -> true-source-gap, coverage 0.
 *     (Comal ships no CAD roll; the gap is the source's, honestly reported.)
 *  3. verdict 'insufficient-sample'
 *     AND some raw coverage          -> needs-crosswalk.
 *     (A source exists but the join key is too thin to prove — an external
 *     CAD-account⟷prop_id crosswalk is the unblock.)
 *  4. otherwise                      -> real-at-ceiling, honest = raw.
 */
export function classifyFacet(input: ClassifyInput): FacetScore {
  const {
    facet,
    rawCoveragePct,
    sourcePresent,
    verdict,
    ownerMatchRate,
    source,
    sourceVintage,
    sampled,
  } = input;

  let classification: Classification;
  let honestCoveragePct: number;

  if (verdict === "block") {
    classification = "fabricated-blocked";
    honestCoveragePct = 0;
  } else if (!sourcePresent) {
    classification = "true-source-gap";
    honestCoveragePct = 0;
  } else if (verdict === "insufficient-sample" && rawCoveragePct > 0) {
    classification = "needs-crosswalk";
    // The raw coverage is not proven real, so it is not asserted as honest
    // coverage; the crosswalk lifts it later. Record 0 honest until proven.
    honestCoveragePct = 0;
  } else {
    classification = "real-at-ceiling";
    honestCoveragePct = rawCoveragePct;
  }

  return {
    facet,
    honestCoveragePct,
    integrityVerdict: verdict ?? "n/a",
    ownerMatchRate,
    source,
    sourceVintage,
    sampled,
    classification,
  };
}

/**
 * Why a stamp facet could not be measured, or null when it can be.
 *
 * The three refusals are the scorer header's `no-zoning-column`,
 * `no-wired-layer` and `stamp-not-rolled`. Each carries the basis a reader
 * needs to act on it, because a refusal a reader cannot act on becomes a
 * shrug.
 */
export interface StampFacetMeasurability {
  measurable: boolean;
  /** Stable machine code, one of the three refusals. Null when measurable. */
  refusal: "no-zoning-column" | "no-wired-layer" | "stamp-not-rolled" | null;
  /** Human basis, printed and carried into the close artifact. */
  basis: string | null;
}

/**
 * Decide whether the zoning/envelope stamp facets are measurable for a county.
 *
 * PURE, so the rule is unit-testable without a database and the negative case
 * is provable (DEV_PROCESS 2.2: a gate is tested for its ability to FIRE).
 */
export function resolveStampFacetMeasurability(input: {
  table: string;
  hasZoningColumn: boolean;
  wiredZoningLayers: number;
  stampedPct: number;
}): StampFacetMeasurability {
  if (!input.hasZoningColumn) {
    return {
      measurable: false,
      refusal: "no-zoning-column",
      basis:
        `resolved parcel table '${input.table}' has no zoning_district column, ` +
        "so this instrument cannot see zoning for this county. Recording a " +
        "source gap from a missing column would assert an absence never " +
        "determined.",
    };
  }
  if (input.wiredZoningLayers === 0) {
    return {
      measurable: false,
      refusal: "no-wired-layer",
      basis:
        "no city zoning layer is registered for this county in ZONING_LAYERS, " +
        "so a 0% stamp rate would measure this instrument's wiring rather " +
        "than the county. Wire a city layer, or establish the county's " +
        "unincorporated status positively, before an absence is written.",
    };
  }
  if (input.stampedPct <= 0) {
    return {
      measurable: false,
      refusal: "stamp-not-rolled",
      basis:
        `${input.wiredZoningLayers} city zoning layer(s) are wired for this ` +
        "county but no parcel carries a stamp, so the zoning-stamp CLI has " +
        "not been run here. That is an unrun step, not a source gap.",
    };
  }
  return { measurable: true, refusal: null, basis: null };
}
