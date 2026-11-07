/**
 * REGISTRY DIVERGENCE TESTS — the control, not a style check.
 *
 * DEV_PROCESS 2.4: when one rule has two implementations, the divergence test
 * IS the control. The rail dimension (`COUNTY_RAIL_DECLARATION`) and the
 * scoring registry are two lists describing one set of rails, and CTRL-1
 * happened because exactly that shape went untested. Adding a rail must be
 * impossible to half-do.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { COUNTY_RAIL_DECLARATION } from "@workspace/db/schema";
import {
  RAIL_SCORING_DECLARATION,
  absenceProbeCoversCounty,
  denominatorNeedsCityBoundary,
  isLiveCountingDenominatorKind,
  isScoreableRule,
  railScoringRuleFor,
  retiredDenominatorRails,
  scoreableRailKeys,
  thresholdPctForRail,
  unspecifiedRails,
  type AbsenceProbeSpec,
  type DenominatorKind,
  type RailScoringRule,
} from "./registry";
import {
  EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
  measureRailCell,
  RailNotMeasurableError,
} from "./measure";

/**
 * SS-W15's incorporated-city-parcels path (composed with S-22, 2026-09-04).
 * A SECOND executable denominator now exists alongside the parcel-feature
 * count: `measureColumnStamp` routes zoning to `measureIncorporatedStampCounts`
 * (`cityBoundaryDenominator.ts`) instead. `ST_PointOnSurface` is the marker
 * the real executed query and zoning's own declared basis both carry,
 * mirroring `EXECUTED_SQL`'s role for the parcel-feature path. Module-scoped
 * because both divergence-check describe blocks below need it.
 */
const EXECUTED_INCORPORATED_SQL = "ST_PointOnSurface";
/**
 * Which rail(s) are INDEPENDENTLY known to execute the incorporated path,
 * as a fact checked AGAINST the registry -- never derived from a rule's own
 * declared `denominator.kind`. Deriving it from the declaration would be
 * circular: a rail that regressed to (wrongly) declaring the ordinary
 * parcel-feature kind would then be checked as an ordinary parcel-feature
 * rail and could pass despite being wrong, which is the exact class of bug
 * this whole file exists to catch (S-21: geometry's own declared kind was
 * trusted instead of verified against what the code actually executes).
 */
const INCORPORATED_PATH_RAIL_KEYS: ReadonlySet<string> = new Set(["zoning"]);

describe("registry / rail-dimension divergence", () => {
  it("declares a scoring rule for EVERY rail in COUNTY_RAIL_DECLARATION", () => {
    const dimensionKeys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey).sort();
    const registryKeys = RAIL_SCORING_DECLARATION.map((r) => r.railKey).sort();
    expect(registryKeys).toEqual(dimensionKeys);
  });

  it("declares NO rail the dimension does not have", () => {
    // The other direction of the same identity, asserted separately so a
    // failure names which side drifted.
    const dimensionKeys = new Set(COUNTY_RAIL_DECLARATION.map((r) => r.railKey));
    const strays = RAIL_SCORING_DECLARATION.filter(
      (r) => !dimensionKeys.has(r.railKey),
    ).map((r) => r.railKey);
    expect(strays).toEqual([]);
  });

  it("has no duplicate rail keys", () => {
    const keys = RAIL_SCORING_DECLARATION.map((r) => r.railKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resolves a threshold for every rail from the DIMENSION, not from itself", () => {
    for (const rule of RAIL_SCORING_DECLARATION) {
      const fromDimension = COUNTY_RAIL_DECLARATION.find(
        (r) => r.railKey === rule.railKey,
      );
      expect(fromDimension, `no dimension row for ${rule.railKey}`).toBeDefined();
      expect(thresholdPctForRail(rule.railKey)).toBe(fromDimension!.thresholdPct);
    }
  });

  it("does NOT carry a threshold field of its own", () => {
    // A threshold here would be a second home for one rule — the exact
    // duplication that let GEOMETRY_THRESHOLD_PCT and FLOOD_THRESHOLD_PCT
    // become per-file literals.
    for (const rule of RAIL_SCORING_DECLARATION) {
      expect(rule).not.toHaveProperty("thresholdPct");
    }
  });

  it("throws rather than defaulting when a rail has no threshold", () => {
    expect(() => thresholdPctForRail("not-a-rail")).toThrow(/not in COUNTY_RAIL_DECLARATION/);
  });
});

describe("registry completeness", () => {
  const EXECUTED_SQL = "count(DISTINCT feature_index)";

  /**
   * Meaning-shaped denominator honesty. A rail carrying live reconstructible
   * rows must declare the denominator those rows (and measure.ts) compute
   * against. Geometry's live rows are RETIRED, so it must not claim a live
   * counting kind. Unspecified-never-measured stays `none`, which is a
   * different state from retired-unknown.
   *
   * Cheapest satisfier of the old check (`kind` truthy, `basis` length > 10)
   * was kind `"x"` and eleven characters. This function rejects that.
   */
  function denominatorHonestyErrors(
    rules: readonly RailScoringRule[],
    executedKind: string,
    executedSql: string,
  ): string[] {
    const errors: string[] = [];
    for (const rule of rules) {
      const { kind, basis } = rule.denominator;
      if (rule.railKey === "geometry") {
        if (isLiveCountingDenominatorKind(kind) || kind === executedKind) {
          errors.push(
            `geometry claims live counting kind '${kind}' while its live rows are retired`,
          );
        }
        if (kind !== "retired-unknown-denominator") {
          errors.push(
            `geometry denominator must be retired-unknown-denominator (not '${kind}'); ` +
              `retired-rows-with-unknown-denominator is not unspecified-never-measured`,
          );
        }
        continue;
      }
      if (rule.kind === "unspecified") {
        if (kind !== "none") {
          errors.push(
            `${rule.railKey} is unspecified-never-measured but denominator.kind is '${kind}'`,
          );
        }
        continue;
      }
      // SS-W15 (composed with S-22): zoning is INDEPENDENTLY known (via
      // INCORPORATED_PATH_RAIL_KEYS, a hardcoded fact about the rail, never
      // derived from its own declaration -- see the S-22 divergence
      // describe block below for why deriving it from `kind` is circular
      // and empirically fails to catch a regression) to execute the
      // incorporated-city-parcels path, not the parcel-feature path every
      // other live reconstructible rail uses.
      if (INCORPORATED_PATH_RAIL_KEYS.has(rule.railKey)) {
        if (kind !== "incorporated-city-parcels") {
          errors.push(
            `${rule.railKey} declares denominator.kind '${kind}' but measure.ts executes 'incorporated-city-parcels' for this rail`,
          );
        }
        if (!basis.includes(EXECUTED_INCORPORATED_SQL)) {
          errors.push(
            `${rule.railKey} basis does not contain the SQL measure.ts executes for the incorporated-city-parcels path (${EXECUTED_INCORPORATED_SQL})`,
          );
        }
        if (basis.trim().length <= 10) {
          errors.push(`${rule.railKey} basis is too short to name a counting rule`);
        }
        continue;
      }
      // Live reconstructible rails (flood, cad, landuse, owner, envelope).
      if (kind !== executedKind) {
        errors.push(
          `${rule.railKey} declares denominator.kind '${kind}' but measure.ts executes '${executedKind}'`,
        );
      }
      if (!basis.includes(executedSql)) {
        errors.push(
          `${rule.railKey} basis does not contain the SQL measure.ts executes (${executedSql})`,
        );
      }
      if (basis.trim().length <= 10) {
        errors.push(`${rule.railKey} basis is too short to name a counting rule`);
      }
    }
    return errors;
  }

  it("every rail's denominator matches its live / retired / unspecified state", () => {
    expect(
      denominatorHonestyErrors(
        RAIL_SCORING_DECLARATION,
        EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
        EXECUTED_SQL,
      ),
    ).toEqual([]);
  });

  it("FAILS if geometry claims the executed parcel-feature denominator", () => {
    // Violation 1 of the meaning-shaped check: the original S-22 defect.
    const dishonest = RAIL_SCORING_DECLARATION.map((r) =>
      r.railKey === "geometry"
        ? {
            ...r,
            denominator: {
              kind: EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
              basis:
                "count(DISTINCT feature_index) in txgio_parcel for the county (falling back to staging).",
            },
          }
        : r,
    );
    const errors = denominatorHonestyErrors(
      dishonest,
      EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      EXECUTED_SQL,
    );
    expect(errors.some((e) => e.includes("geometry") && e.includes("retired"))).toBe(
      true,
    );
  });

  it("FAILS if a live rail declares kind x and an eleven-character basis", () => {
    // Violation 2: the cheapest satisfier of the old toBeTruthy / length>10 check.
    const dishonest = RAIL_SCORING_DECLARATION.map((r) =>
      r.railKey === "flood"
        ? {
            ...r,
            denominator: {
              kind: "x" as DenominatorKind,
              basis: "12345678901",
            },
          }
        : r,
    );
    const errors = denominatorHonestyErrors(
      dishonest,
      EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      EXECUTED_SQL,
    );
    expect(errors.some((e) => e.includes("flood"))).toBe(true);
    expect(errors.some((e) => e.includes("12345678901")) || errors.some((e) => e.includes("flood"))).toBe(
      true,
    );
  });

  it("every rule names an instrument, so no row can be anonymous", () => {
    // 57 live ledger rows carry verified_by_instrument NULL. A row that
    // cannot name what produced it cannot be re-derived or challenged.
    for (const rule of RAIL_SCORING_DECLARATION) {
      expect(rule.instrument.trim().length, rule.railKey).toBeGreaterThan(0);
    }
  });

  it("every UNSPECIFIED rail names a reason and an owner", () => {
    // DEV_PROCESS 3.6: "unassigned" is a blocking state, not a default.
    for (const rail of unspecifiedRails()) {
      expect(rail.unspecifiedReason.trim().length, rail.railKey).toBeGreaterThan(40);
      expect(rail.specOwner.trim().length, rail.railKey).toBeGreaterThan(0);
    }
  });

  it("thirteen of fourteen rails are scoreable; none remain unspecified, geometry is retired (S-22)", () => {
    // Pre-S-22 this asserted all fourteen scoreable. S-22 retired geometry's
    // denominator (live rows were computed against a counting rule that is
    // not reconstructible from checked-in source) rather than substituting a
    // different one and silently rescoring them -- geometry is neither
    // unspecified (it has a measurement kind) nor scoreable (no live
    // denominator), a third state `retiredDenominatorRails()` names.
    expect(unspecifiedRails()).toEqual([]);
    expect(scoreableRailKeys().length).toBe(RAIL_SCORING_DECLARATION.length - 1);
    expect(retiredDenominatorRails().map((r) => r.railKey)).toEqual(["geometry"]);
    expect(railScoringRuleFor("mud")?.kind).toBe("atom-count-over-parcel-features");
  });

  it("mud declares distinct-parcel-keys, statewide absence probe, and present source label", () => {
    const mud = railScoringRuleFor("mud");
    expect(mud?.kind).toBe("atom-count-over-parcel-features");
    if (mud?.kind !== "atom-count-over-parcel-features") return;
    expect(mud.entityType).toBe("special-district-fact");
    expect(mud.numeratorMode).toBe("distinct-parcel-keys");
    expect(mud.presentSourceLabel).toBe(
      "special-district-fact-determination-over-txgio-feature-index",
    );
    expect(mud.absenceProbe?.table).toBe("tx_special_district");
    expect(mud.absenceProbe?.reach).toEqual({ kind: "statewide" });
    expect(thresholdPctForRail("mud")).toBe(90);
  });

  it("scoreable, unspecified, and retired-denominator rails partition the registry without overlap", () => {
    const scoreable = new Set(scoreableRailKeys());
    const unspecified = new Set(unspecifiedRails().map((r) => r.railKey));
    const retired = new Set(retiredDenominatorRails().map((r) => r.railKey));
    for (const key of scoreable) {
      expect(unspecified.has(key), `${key} in scoreable and unspecified`).toBe(false);
      expect(retired.has(key), `${key} in scoreable and retired`).toBe(false);
    }
    for (const key of unspecified) {
      expect(retired.has(key), `${key} in unspecified and retired`).toBe(false);
    }
    expect(scoreable.size + unspecified.size + retired.size).toBe(
      RAIL_SCORING_DECLARATION.length,
    );
    expect(retired.has("geometry")).toBe(true);
    expect(scoreable.has("geometry")).toBe(false);
    expect(unspecified.has("geometry")).toBe(false);
  });

  it("resolves a known rail and returns undefined for an unknown one", () => {
    expect(railScoringRuleFor("flood")?.railKey).toBe("flood");
    expect(railScoringRuleFor("no-such-rail")).toBeUndefined();
  });
});

describe("absence probe reach", () => {
  // TRACED TO AN INCIDENT: the RRC wells source is a Harris-only mirror.
  // Applying it statewide writes mass false absences.
  const statewide: AbsenceProbeSpec = {
    kind: "source-table-zero-rows",
    table: "tx_special_district",
    fipsColumn: "county_fips",
    basis: "statewide-source-zero-rows-for-fips",
    reach: { kind: "statewide" },
  };
  const harrisOnly: AbsenceProbeSpec = {
    ...statewide,
    table: "rrc_wells",
    reach: { kind: "enumerated-counties", counties: ["48201"] },
  };
  const unknownReach: AbsenceProbeSpec = {
    ...statewide,
    reach: { kind: "unknown" },
  };

  it("a statewide source covers any county", () => {
    expect(absenceProbeCoversCounty(statewide, "48021")).toBe(true);
  });

  it("an enumerated source covers ONLY its counties", () => {
    expect(absenceProbeCoversCounty(harrisOnly, "48201")).toBe(true);
    expect(absenceProbeCoversCounty(harrisOnly, "48113")).toBe(false);
  });

  it("an UNKNOWN reach covers nothing — it can never establish an absence", () => {
    expect(absenceProbeCoversCounty(unknownReach, "48021")).toBe(false);
  });
});

describe("the registry is DB-free by construction", () => {
  // `--list` reads a checked-in declaration and touches no database, so it
  // must not need a connection string. It did: the barrel re-exported the
  // engine, which imported classifyFacet from countyCoverageScoreCli.ts,
  // which reaches @workspace/db, whose module body throws without
  // DATABASE_URL. The cheapest command in the tool had become the one command
  // that could not run. Lane SS-W18 broke that chain on 2026-08-19 by moving
  // the classifier to lib/countyCoverageClassification.ts, after the same
  // chain also exited the SERVER at boot. This pins the import boundary so
  // neither the barrel nor a CLI can creep back in.
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "./registry.ts"),
    "utf8",
  );

  it("can read its own source (a missing file must FAIL, not skip)", () => {
    expect(source).toContain("RAIL_SCORING_DECLARATION");
  });

  it("imports @workspace/db/schema, never the @workspace/db client entrypoint", () => {
    // The `/schema` export path is a plain declaration module; the bare `.`
    // export is the pg Pool singleton with the DATABASE_URL guard.
    expect(source).toMatch(/from\s+"@workspace\/db\/schema"/);
    expect(source).not.toMatch(/from\s+"@workspace\/db"/);
  });

  it("imports nothing from the engine, the measurers, the barrel, or a CLI", () => {
    for (const forbidden of [
      "./engine",
      "./measure",
      "./run",
      "./index",
      "countyCoverageScoreCli",
    ]) {
      expect(source, forbidden).not.toContain(`from "${forbidden}"`);
    }
  });
});

describe("declared denominator vs executed measurement (S-22 divergence)", () => {
  // Independently derived: registry field vs the query / kind dispatch in
  // measure.ts. A check that only asserts registry.kind === a copied constant
  // in this file would be internal consistency — that is the shape that let
  // geometry declare PARCEL_FEATURE_DENOMINATOR while live rows used accounted
  // features.
  const measureSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "./measure.ts"),
    "utf8",
  );
  // The incorporated-city-parcels path's own measurement query lives in a
  // separate module (SS-W15), not measure.ts -- measure.ts only dispatches
  // to it. Read separately rather than assume functionSlice(measureSrc, ...)
  // would ever find it there.
  const cityBoundarySrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "./cityBoundaryDenominator.ts"),
    "utf8",
  );
  const EXECUTED_SQL = "count(DISTINCT feature_index)";

  function functionSlice(src: string, name: string, sourceLabel = "measure.ts"): string {
    const markers = [`export async function ${name}`, `async function ${name}`];
    let start = -1;
    for (const marker of markers) {
      start = src.indexOf(marker);
      if (start >= 0) break;
    }
    expect(start, `${sourceLabel} must contain ${name}`).toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + 1);
    const next = rest.search(/\n(?:export )?async function /);
    return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
  }

  it("can read measure.ts (a missing file must FAIL, not skip)", () => {
    expect(measureSrc).toContain("readParcelFeatureCount");
  });

  it("can read cityBoundaryDenominator.ts (a missing file must FAIL, not skip)", () => {
    expect(cityBoundarySrc).toContain("measureIncorporatedStampCounts");
  });

  it("readParcelFeatureCount is the function that executes the parcel-feature count", () => {
    const body = functionSlice(measureSrc, "readParcelFeatureCount");
    expect(body).toContain(EXECUTED_SQL);
    // The machine name lives next to this function, not in the registry.
    expect(measureSrc).toMatch(
      /export const EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND\s*=\s*"txgio-parcel-distinct-feature-index"/,
    );
  });

  it("every live measurer calls readParcelFeatureCount", () => {
    for (const name of [
      "measureAtomCount",
      "measureColumnStamp",
      "measureColumnConjunction",
    ]) {
      expect(functionSlice(measureSrc, name), name).toContain("readParcelFeatureCount");
    }
  });

  // EXECUTED_INCORPORATED_SQL and INCORPORATED_PATH_RAIL_KEYS are
  // module-scoped (top of file) -- this describe block's own divergence
  // check below shares them with "registry completeness"'s
  // denominatorHonestyErrors, which has the identical composition gap.

  it("measureIncorporatedStampCounts is the function that executes the incorporated-city-parcels count", () => {
    const body = functionSlice(
      cityBoundarySrc,
      "measureIncorporatedStampCounts",
      "cityBoundaryDenominator.ts",
    );
    expect(body).toContain(EXECUTED_INCORPORATED_SQL);
  });

  it("measureColumnStamp dispatches to the incorporated path BEFORE the parcel-feature path, gated on denominatorNeedsCityBoundary", () => {
    const body = functionSlice(measureSrc, "measureColumnStamp");
    const dispatchAt = body.indexOf("denominatorNeedsCityBoundary");
    const fallbackAt = body.indexOf("readParcelFeatureCount");
    expect(dispatchAt).toBeGreaterThanOrEqual(0);
    expect(fallbackAt).toBeGreaterThan(dispatchAt);
  });

  it("measureRailCell refuses a retired denominator BEFORE dispatching to a measurer", () => {
    const body = functionSlice(measureSrc, "measureRailCell");
    const retiredAt = body.indexOf("retired-unknown-denominator");
    const switchAt = body.indexOf("switch (rule.kind)");
    expect(retiredAt).toBeGreaterThanOrEqual(0);
    expect(switchAt).toBeGreaterThan(retiredAt);
  });

  it("scoreable rails declare the denominator measure.ts actually executes", () => {
    // Two executable paths now (SS-W15 composed with S-22): most scoreable
    // rails still execute the county-wide parcel-feature count, but zoning
    // deliberately does not -- denominatorNeedsCityBoundary routes it to the
    // incorporated-city-parcels count instead, which IS its declared kind,
    // not a divergence from it.
    const atomCountKeys = ["flood", "cad", "landuse", "owner"];
    const incorporatedPathStampKeys = ["zoning"];
    const conjunctionKeys = ["envelope"];
    for (const railKey of [...atomCountKeys, ...conjunctionKeys]) {
      const rule = railScoringRuleFor(railKey);
      expect(rule, railKey).toBeDefined();
      expect(isScoreableRule(rule!), railKey).toBe(true);
      expect(rule!.denominator.kind, railKey).toBe(
        EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      );
      expect(rule!.denominator.basis, railKey).toContain(EXECUTED_SQL);
    }
    for (const railKey of incorporatedPathStampKeys) {
      const rule = railScoringRuleFor(railKey);
      expect(rule, railKey).toBeDefined();
      expect(isScoreableRule(rule!), railKey).toBe(true);
      expect(denominatorNeedsCityBoundary(rule!.denominator.kind), railKey).toBe(true);
      expect(rule!.denominator.kind, railKey).toBe("incorporated-city-parcels");
      expect(rule!.denominator.basis, railKey).toContain(EXECUTED_INCORPORATED_SQL);
    }
  });

  function declarationVsExecutionErrors(
    rules: readonly RailScoringRule[],
    executedKind: string,
    executedSql: string,
  ): string[] {
    const errors: string[] = [];
    for (const rule of rules) {
      if (rule.railKey === "geometry") {
        if (rule.denominator.kind === executedKind) {
          errors.push(
            "geometry claims the denominator measure.ts would execute " +
              `(${executedKind}) while its live rows are retired`,
          );
        }
        continue;
      }
      if (rule.kind === "unspecified") continue;
      // SS-W15 (composed with S-22): zoning takes the incorporated-city-
      // parcels path, not the parcel-feature path everyone else takes --
      // check it against THAT path's own executed kind/SQL.
      //
      // Routed on INCORPORATED_PATH_RAIL_KEYS (an independent fact about
      // the rail), NOT on denominatorNeedsCityBoundary(rule.denominator.kind)
      // -- an earlier version of this check tried that and it is circular:
      // a rule that regressed to (wrongly) declaring the ordinary
      // parcel-feature kind would make denominatorNeedsCityBoundary itself
      // return false, routing it to the ordinary-path check below, which it
      // would then PASS if its basis happened to be internally consistent
      // with that wrong kind. Proven empirically, not just reasoned: a test
      // mutating zoning to declare the parcel-feature kind with a
      // parcel-feature basis produced zero errors under the circular
      // version. Exactly the S-21 failure class this file exists to catch
      // (a rule's own declaration deciding how it gets checked).
      if (INCORPORATED_PATH_RAIL_KEYS.has(rule.railKey)) {
        if (rule.denominator.kind !== "incorporated-city-parcels") {
          errors.push(
            `${rule.railKey} declares '${rule.denominator.kind}' but measure.ts executes 'incorporated-city-parcels' for this rail`,
          );
        }
        if (!rule.denominator.basis.includes(EXECUTED_INCORPORATED_SQL)) {
          errors.push(
            `${rule.railKey} basis does not contain the SQL measure.ts executes for the incorporated-city-parcels path`,
          );
        }
        continue;
      }
      if (rule.denominator.kind !== executedKind) {
        errors.push(
          `${rule.railKey} declares '${rule.denominator.kind}' but measure.ts executes '${executedKind}'`,
        );
      }
      if (!rule.denominator.basis.includes(executedSql)) {
        errors.push(
          `${rule.railKey} basis does not contain the SQL measure.ts executes`,
        );
      }
    }
    return errors;
  }

  it("the live registry does not diverge from measure.ts", () => {
    expect(
      declarationVsExecutionErrors(
        RAIL_SCORING_DECLARATION,
        EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
        EXECUTED_SQL,
      ),
    ).toEqual([]);
  });

  it("FAILS if geometry claims a denominator measure.ts would execute", () => {
    const dishonest = RAIL_SCORING_DECLARATION.map((r) =>
      r.railKey === "geometry"
        ? {
            ...r,
            denominator: {
              kind: EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
              basis: `${EXECUTED_SQL} in txgio_parcel for the county`,
            },
          }
        : r,
    );
    const errors = declarationVsExecutionErrors(
      dishonest,
      EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      EXECUTED_SQL,
    );
    expect(errors.some((e) => e.startsWith("geometry claims"))).toBe(true);
  });

  it("FAILS if a live atom-count rail's declared kind drifts from measure.ts", () => {
    const dishonest = RAIL_SCORING_DECLARATION.map((r) =>
      r.railKey === "flood"
        ? {
            ...r,
            denominator: { kind: "none" as DenominatorKind, basis: "no measurement spec yet" },
          }
        : r,
    );
    const errors = declarationVsExecutionErrors(
      dishonest,
      EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      EXECUTED_SQL,
    );
    expect(errors.some((e) => e.includes("flood") && e.includes("none"))).toBe(true);
  });

  it("FAILS if the incorporated-path rail (zoning) declares the wrong kind for its own dispatch", () => {
    const dishonest = RAIL_SCORING_DECLARATION.map((r) =>
      r.railKey === "zoning"
        ? {
            ...r,
            denominator: {
              kind: EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
              basis: `${EXECUTED_SQL} in txgio_parcel for the county`,
            },
          }
        : r,
    );
    const errors = declarationVsExecutionErrors(
      dishonest,
      EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      EXECUTED_SQL,
    );
    // INCORPORATED_PATH_RAIL_KEYS routes on railKey, independent of the
    // (now-dishonest) declared kind, so zoning still lands in the
    // incorporated-path branch here and is caught directly: it declares the
    // parcel-feature kind but measure.ts executes the incorporated-city-
    // parcels query for this rail regardless of what it claims. This is
    // the regression this test exists to catch -- an earlier, circular
    // version of the routing (keyed on the declared kind itself) let this
    // exact mutation through with zero errors.
    expect(errors.some((e) => e.includes("zoning"))).toBe(true);
  });

  it("FAILS if a live incorporated-path rail's basis drops the SQL marker measure.ts actually executes", () => {
    const dishonest = RAIL_SCORING_DECLARATION.map((r) =>
      r.railKey === "zoning"
        ? { ...r, denominator: { kind: r.denominator.kind, basis: "trust me" } }
        : r,
    );
    const errors = declarationVsExecutionErrors(
      dishonest,
      EXECUTED_PARCEL_FEATURE_DENOMINATOR_KIND,
      EXECUTED_SQL,
    );
    expect(
      errors.some((e) => e.includes("zoning") && e.includes("incorporated-city-parcels path")),
    ).toBe(true);
  });

  it("measureRailCell throws denominator_retired for geometry without querying either store", async () => {
    const geometry = railScoringRuleFor("geometry")!;
    const boom = async () => {
      throw new Error("must not query: retired geometry must fail before I/O");
    };
    try {
      await measureRailCell(
        geometry,
        { deployment: { query: boom }, atoms: { query: boom } },
        "48021",
      );
      throw new Error("measureRailCell must refuse geometry, not return a measurement");
    } catch (err) {
      expect(err).toBeInstanceOf(RailNotMeasurableError);
      expect((err as RailNotMeasurableError).reason).toBe("denominator_retired");
      expect((err as Error).message).not.toMatch(/must not query/);
    }
  });

  it("geometry notes keep the S-21 evidence trail and record the S-22 retirement with the 254 correction", () => {
    const geometry = railScoringRuleFor("geometry")!;
    expect(geometry.notes).toMatch(/The 253 live geometry rows/);
    expect(geometry.notes).toMatch(/B2_cp2_geometry_scorer_apply\.mjs/);
    expect(geometry.notes).toMatch(/RETIRED 2026-08-20 \(S-22\)/);
    expect(geometry.notes).toMatch(
      /Live geometry rows are 254 over 254 distinct county FIPS, not 253/,
    );
    expect(geometry.notes).toMatch(/2026-08-20_db_probe_five_answers\.md Q2/);
    expect(geometry.kind).toBe("atom-count-over-parcel-features");
    expect(geometry.kind).not.toBe("unspecified");
  });
});
