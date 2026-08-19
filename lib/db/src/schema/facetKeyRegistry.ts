/**
 * FACET KEY REGISTRY — the single source of truth for every value that may
 * legally appear in `county_facet_coverage.facet`.
 *
 * WHY THIS FILE EXISTS. `countyCoverageScoreCli.ts` wrote facet `land-use`
 * while the rail key is `landuse`. The manifest grid joins
 * `c.facet = r.rail_key` (`lib/db/src/manifestGridRead.ts`), so those rows
 * joined nothing: 19 live rows in production that no cell has ever read,
 * measured by lane SS-W9 and re-verified by lane SS-W13 on 2026-08-19.
 *
 * That is the CTRL-1 shape from `90_runbooks/DEV_PROCESS.md` section 2.4 —
 * one rule ("which facet keys exist") with two implementations (the rail
 * declaration and whatever string a scorer happened to type), drifting
 * apart with nothing testing the difference. The fix is not to correct the
 * one string. It is to make the set of legal keys DATA, have every writer
 * assert against it, and ship a divergence test that fails on a near miss
 * as well as on an unknown key.
 *
 * A near-miss check is load-bearing here and an equality check is not:
 * `land-use` and `landuse` differ by one hyphen, so any control comparing
 * key sets for equality reports two distinct, valid-looking members. The
 * collision rule below normalises away hyphens, underscores and case, and
 * rejects a diagnostic key that collapses onto a rail key.
 *
 * TWO CLASSES OF KEY, and the difference is not cosmetic:
 *
 *   RAIL KEYS        join the manifest grid, feed the county ledger, and
 *                    move the Texas completeness headline. Enumerated by
 *                    `COUNTY_RAIL_DECLARATION` in `./countyRailDimension`;
 *                    never restated here, so adding a rail stays a one-file
 *                    edit.
 *
 *   DIAGNOSTIC KEYS  are deliberately NOT rails. They ride the same table
 *                    for storage convenience, join nothing, and display
 *                    nowhere. Each one is declared below with the ruling
 *                    that says why it is not a rail. A diagnostic key is
 *                    an admission, not a loophole: if a measurement wants
 *                    to become a rail, it goes in the rail declaration.
 */

import { COUNTY_RAIL_DECLARATION } from "./countyRailDimension";

/** Every rail key, derived — never a second hand-maintained list. */
export const RAIL_FACET_KEYS: ReadonlySet<string> = new Set(
  COUNTY_RAIL_DECLARATION.map((r) => r.railKey),
);

export interface DiagnosticFacetDeclaration {
  /** The value written to `county_facet_coverage.facet`. */
  facetKey: string;
  /** What the number actually measures, in one sentence. */
  measures: string;
  /** The ruling or reason this is not a rail. */
  notARailBecause: string;
  /** The writer that emits it. */
  writerRef: string;
}

/**
 * NON-RAIL diagnostic facets. Each must justify itself.
 *
 * `landuse-cad-join` — the CAD-roll join rate `countyCoverageScoreCli.ts`
 * has always computed. It is NOT the `landuse` rail's coverage and never
 * was: the rail is measured by land-use-fact ATOM COUNT over the parcel
 * roster (`score_cad_rails_fast.mjs`, source `land-use-fact-atom-count`),
 * while this number is the fit between the TxGIO parcel roster and the CAD
 * roll. Measured on the same 19 counties on 2026-08-19, the two disagree in
 * all 19 and the rail number is higher in all 13 counties currently
 * satisfied (48027 77.76 vs 98.90, 48091 0.00 vs 99.68, 48113 92.83 vs
 * 99.91, 48491 89.14 vs 99.85). Merging them under one key would overwrite
 * a newer, higher, differently-derived measurement with an older, lower one.
 *
 * Join quality was RULED not a rail on 2026-08-08 — "a DERIVED METRIC of
 * fit between two acquired rails, not a rail with its own provenance or
 * absence" (doc_repo `_decisions/2026-08-08_county_shape_thirteen_rails_
 * and_geometry_first.md`, quoted in `./countyRailDimension` where the
 * `join` rail was removed). This declaration is that ruling, enforced.
 */
export const DIAGNOSTIC_FACET_DECLARATIONS: ReadonlyArray<DiagnosticFacetDeclaration> =
  [
    {
      facetKey: "landuse-cad-join",
      measures:
        "Fraction of bakeable TxGIO parcels whose normalised prop_id (or owner-gated situs address, where the prop_id gate is blocked) matches a CAD roll row carrying a property_use_code.",
      notARailBecause:
        "Join quality is fit between two acquired rails, ruled a derived metric and removed from the rail dimension 2026-08-08. It has no provenance or absence of its own.",
      writerRef: "artifacts/api-server/src/countyCoverageScoreCli.ts",
    },
  ];

/** Every declared diagnostic key. */
export const DIAGNOSTIC_FACET_KEYS: ReadonlySet<string> = new Set(
  DIAGNOSTIC_FACET_DECLARATIONS.map((d) => d.facetKey),
);

/**
 * LEGACY keys that exist in production data and are recognised so a reader
 * is never puzzled by them, but which NO writer may emit again.
 *
 * `land-use` — 19 rows written 2026-07-21 to 2026-08-05 by
 * `countyCoverageScoreCli.ts` before this registry existed. They are inert:
 * no rail joins them and no display reads them. Their disposition (re-key
 * to `landuse-cad-join`, or delete) is an operator ruling per DEV_PROCESS
 * 5.4, and `countyFacetKeyReconcileCli.ts` performs it dry-run first.
 * Merging them into `landuse` is NOT one of the options — see the
 * `landuse-cad-join` note above for the measurement that proves why.
 */
export const RETIRED_FACET_KEYS: ReadonlySet<string> = new Set(["land-use"]);

/**
 * Collision normal form. Two keys collide when they are the same string
 * once hyphens, underscores and case are removed — which is exactly the
 * relation `land-use` bears to `landuse`, and exactly the relation no
 * equality check can see.
 */
export function facetKeyCollisionForm(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/** Keys a writer may legally emit today: rails plus declared diagnostics. */
export const WRITABLE_FACET_KEYS: ReadonlySet<string> = new Set([
  ...RAIL_FACET_KEYS,
  ...DIAGNOSTIC_FACET_KEYS,
]);

export interface FacetKeyViolation {
  facetKey: string;
  reason: string;
}

/**
 * Check one facet key. Returns null when legal, a violation otherwise.
 * PURE, so the fail-closed assertion in a CLI and the divergence test in CI
 * are the same code rather than two implementations of one rule.
 */
export function checkFacetKey(facetKey: string): FacetKeyViolation | null {
  if (RAIL_FACET_KEYS.has(facetKey)) return null;
  if (DIAGNOSTIC_FACET_KEYS.has(facetKey)) return null;
  if (RETIRED_FACET_KEYS.has(facetKey)) {
    return {
      facetKey,
      reason:
        `'${facetKey}' is a RETIRED facet key. Rows written under it are orphaned ` +
        "from the manifest grid and no display reads them. Emit a declared " +
        "diagnostic key instead; see lib/db/src/schema/facetKeyRegistry.ts.",
    };
  }
  const form = facetKeyCollisionForm(facetKey);
  const nearMiss = [...RAIL_FACET_KEYS].find(
    (rail) => facetKeyCollisionForm(rail) === form,
  );
  if (nearMiss) {
    return {
      facetKey,
      reason:
        `'${facetKey}' is not a rail key but collapses onto rail '${nearMiss}'. ` +
        "The manifest grid joins facet = rail_key exactly, so this row would " +
        "be written, joined by nothing, and read by no cell. Use the rail key " +
        "itself, or declare a diagnostic key that does not collide.",
    };
  }
  return {
    facetKey,
    reason:
      `'${facetKey}' is neither a rail key nor a declared diagnostic key. ` +
      "Add it to COUNTY_RAIL_DECLARATION (if it is a rail) or to " +
      "DIAGNOSTIC_FACET_DECLARATIONS with the ruling that says why it is not.",
  };
}

/**
 * Fail-closed guard for a writer. Throws on the first illegal key so a
 * scorer cannot reach the database with a key nothing can read.
 */
export function assertWritableFacetKeys(facetKeys: readonly string[]): void {
  const violations = facetKeys
    .map((k) => checkFacetKey(k))
    .filter((v): v is FacetKeyViolation => v !== null);
  if (violations.length > 0) {
    throw new Error(
      "illegal facet key(s) refused before any ledger write:\n" +
        violations.map((v) => `  - ${v.reason}`).join("\n"),
    );
  }
}
