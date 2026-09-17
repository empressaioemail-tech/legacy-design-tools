/**
 * Live ETJ verification instrument (feat/p241-etj-acquisition, P-241).
 *
 * Runs the REAL register, the REAL ArcGIS client, the REAL parser and the REAL
 * resolver against the live publishers, and prints one JSON line per control
 * point plus the per-publisher guardrail results. No database, no credential,
 * no environment beyond the network.
 *
 * WHY IT EXISTS. This lane's claims are about acquisition, and the customer
 * card cannot show ETJ yet: the two consumer hardcode sites in `hauska-engine`
 * and the three in `hauska-map` are explicit follow-on work, so no served
 * surface reads `tx_etj_boundary` today. An instrument that measured the card
 * would be measuring something this lane did not change. So the instrument
 * measures what this lane did change — the acquisition path, end to end, live
 * — and the control points below are the same four the mission pre-registered
 * its answers against:
 *
 *   1. Austin, a real address inside the 2-mile ETJ ring   -> present
 *   2. Austin, a real address inside city limits           -> absent
 *   3. Round Rock, city-limits-only publisher              -> unresolved (no source)
 *   4. Houston, outside the register entirely              -> unresolved (not covered)
 *
 * The two control points in cases 1 and 2 are real Travis County parcels on the
 * live parcel layer, chosen by scanning published Austin ETJ polygons and
 * keeping only points whose SOLE Austin jurisdiction label is an ETJ label and
 * which sit in no incorporated place at all (verified independently against the
 * TxGIO statewide city layer). Case 2 is the combined-layer trap: Austin's
 * layer carries city limits and ETJ together, so a predicate that selects the
 * layer rather than the ETJ rows would call a house inside Austin an ETJ
 * address.
 *
 * PREDICATE GUARD. For every combined-layer publisher the ETJ predicate must
 * select at least one feature AND strictly fewer than the whole layer. A
 * predicate that matches nothing is a stale registry entry; a predicate that
 * matches everything is not a predicate, and would silently ingest city limits
 * as ETJ. Both are failures here, not log lines.
 */

import {
  buildEtjBoundaryIndex,
  resolveEtjAtPoint,
  type EtjBoundaryIndexEntry,
  type EtjSourceCoverageEntry,
} from "./containment";
import { etjFactFromContainment, type EtjFact } from "./etjFact";
import { ETJ_REGISTRY, etjPredicateMustBeSelective, type EtjRegistryEntry } from "./etjRegistry";
import {
  countEtjFeatures,
  fetchEtjBoundaryFeatures,
  fetchEtjSourceMetadata,
  type FetchJson,
} from "./etjService";
import { normalizeEtjBoundaryFeature } from "./etjParse";
import { newCounters } from "../types";

export interface EtjControlPoint {
  key: string;
  /** Real parcel on the onboarded parcel layer, when the case starts from one. */
  parcelNodeId: string | null;
  situs: string;
  longitude: number;
  latitude: number;
  /** Already-resolved containing city, when the case is about a city. */
  containing: { cityName: string; geoId: string } | null;
  expect: "present" | "absent" | "unresolved";
  expectCityKey: string | null;
  note: string;
}

/**
 * The four pre-registered control points. Coordinates are the live record
 * points read from the parcel layer on 2026-09-16 (cases 1-2) and city-hall
 * coordinates (cases 3-4).
 */
export const ETJ_CONTROL_POINTS: readonly EtjControlPoint[] = [
  {
    key: "austin-2mile-etj",
    parcelNodeId: "48453:134392",
    situs: "3128 EDGEWATER DR (Travis County, unincorporated)",
    longitude: -97.855113,
    latitude: 30.352812,
    containing: { cityName: "Austin", geoId: "4805000" },
    expect: "present",
    expectCityKey: "austin-tx",
    note:
      "chosen by scanning published Austin ETJ polygons for parcels whose ONLY Austin label is " +
      "'AUSTIN 2 MILE ETJ' and which sit in no incorporated place per the TxGIO statewide layer",
  },
  {
    key: "austin-city-limits",
    parcelNodeId: "48453:367134",
    situs: "5833 TAYLOR DRAPER CV, Austin (inside city limits)",
    longitude: -97.75715,
    latitude: 30.41603,
    containing: { cityName: "Austin", geoId: "4805000" },
    expect: "absent",
    expectCityKey: null,
    note:
      "same layer as case 1: Austin publishes city limits and ETJ together, distinguished by " +
      "JURISDICTION_TYPE. A predicate that selects the layer instead of the ETJ rows would call " +
      "this inside-limit house an ETJ address",
  },
  {
    key: "round-rock-city-limits-only",
    parcelNodeId: null,
    situs: "221 E MAIN ST, Round Rock (City Hall)",
    longitude: -97.67769,
    latitude: 30.50827,
    containing: { cityName: "Round Rock", geoId: "4863500" },
    expect: "unresolved",
    expectCityKey: null,
    note:
      "Round Rock's own host publishes city limits only; the register records it as " +
      "mode=city_limits_only, so the answer must be 'no source to check', never a confirmed absence",
  },
  {
    key: "houston-outside-register",
    parcelNodeId: null,
    situs: "901 BAGBY ST, Houston (City Hall)",
    longitude: -95.36936,
    latitude: 29.76024,
    containing: { cityName: "Houston", geoId: "4835000" },
    expect: "unresolved",
    expectCityKey: null,
    note:
      "no publisher in the register is anywhere near Harris County; the answer must be " +
      "unresolved and must name that nothing is registered for the city",
  },
];

export interface EtjPublisherGuard {
  cityKey: string;
  mode: string;
  layerFeatureCount: number;
  etjFeatureCount: number;
  parsed: number;
  extentReadable: boolean;
  ringLabelSample: string | null;
  ok: boolean;
  reason: string | null;
}

export interface EtjControlOutcome {
  key: string;
  expect: string;
  actual: string;
  ok: boolean;
  fact: EtjFact;
}

export interface EtjVerifyResult {
  lines: string[];
  passed: number;
  failed: number;
  guards: EtjPublisherGuard[];
  outcomes: EtjControlOutcome[];
  coverage: EtjSourceCoverageEntry[];
  index: EtjBoundaryIndexEntry[];
}

export interface EtjVerifyOptions {
  fetchJson?: FetchJson;
  registry?: readonly EtjRegistryEntry[];
  controlPoints?: readonly EtjControlPoint[];
}

/**
 * Acquire every register entry live and resolve every control point. Returns
 * the printable lines plus the structured outcome so tests can assert on it.
 */
export async function verifyEtjControlPoints(
  opts: EtjVerifyOptions = {},
): Promise<EtjVerifyResult> {
  const registry = opts.registry ?? ETJ_REGISTRY;
  const controlPoints = opts.controlPoints ?? ETJ_CONTROL_POINTS;
  const fetchJson = opts.fetchJson;
  const lines: string[] = [];
  const guards: EtjPublisherGuard[] = [];
  const coverage: EtjSourceCoverageEntry[] = [];
  const indexEntries: EtjBoundaryIndexEntry[] = [];

  for (const entry of registry) {
    if (entry.layerUrl === null) {
      coverage.push({
        cityKey: entry.cityKey,
        cityName: entry.cityName,
        cityGeoId: entry.cityGeoId,
        mode: entry.mode,
        hasEtjRings: false,
        bbox: null,
      });
      lines.push(
        JSON.stringify({
          kind: "publisher",
          cityKey: entry.cityKey,
          mode: entry.mode,
          hasEtjRings: false,
          note: "enumerated: publisher exposes city limits and no ETJ layer",
        }),
      );
      continue;
    }

    const metadata = await fetchEtjSourceMetadata(entry, fetchJson ? { fetchJson } : {});
    const layerFeatureCount = await countEtjFeatures(
      entry,
      fetchJson ? { fetchJson } : {},
    );
    const counters = newCounters();
    const rings: EtjBoundaryIndexEntry[] = [];
    for await (const feature of fetchEtjBoundaryFeatures(entry, {
      ...(fetchJson ? { fetchJson } : {}),
    })) {
      counters.rowsRead += 1;
      const rec = normalizeEtjBoundaryFeature(entry, feature, metadata, counters);
      if (rec) {
        counters.rowsParsed += 1;
        rings.push({
          etjId: rec.etjId,
          cityKey: rec.cityKey,
          cityName: rec.cityName,
          ringLabel: rec.ringLabel,
          geometry: rec.geometry,
          bbox: rec.bbox,
          sourceCitation: rec.sourceCitation,
        });
      }
    }

    indexEntries.push(...rings);
    coverage.push({
      cityKey: entry.cityKey,
      cityName: entry.cityName,
      cityGeoId: entry.cityGeoId,
      mode: entry.mode,
      hasEtjRings: true,
      bbox: metadata.extentWgs84,
    });

    // Predicate guard, in both directions:
    //   - a predicate that selects the whole layer is not a predicate, and
    //     would put another jurisdiction's geometry (or city limits) in this
    //     city's rings;
    //   - a layer with no predicate must give up the WHOLE layer, so a short
    //     read is a paging failure and must not be recorded as a smaller ETJ.
    let ok = true;
    let reason: string | null = null;
    if (counters.rowsParsed === 0) {
      ok = false;
      reason = "predicate selected zero ETJ features";
    } else if (
      etjPredicateMustBeSelective(entry) &&
      entry.verifiedFeatureCount !== null &&
      counters.rowsParsed >= entry.verifiedFeatureCount
    ) {
      ok = false;
      reason =
        `predicate selected ${counters.rowsParsed} of ${entry.verifiedFeatureCount} features ` +
        `in a layer that carries ${
          (entry.layerJurisdictions ?? 1) > 1
            ? `${entry.layerJurisdictions} jurisdictions`
            : "city limits alongside ETJ"
        }: it is not distinguishing this city's ETJ`;
    } else if (
      entry.etjMembership === null &&
      entry.verifiedFeatureCount !== null &&
      counters.rowsParsed !== entry.verifiedFeatureCount
    ) {
      ok = false;
      reason =
        `layer has no predicate and reports ${entry.verifiedFeatureCount} features, but ` +
        `${counters.rowsParsed} were read: the read was truncated, so this city's ETJ is ` +
        `incomplete`;
    } else if (metadata.extentWgs84 === null) {
      ok = false;
      reason = "publisher returned no readable WGS84 extent; coverage would be unreadable";
    }

    guards.push({
      cityKey: entry.cityKey,
      mode: entry.mode,
      layerFeatureCount,
      etjFeatureCount: counters.rowsParsed,
      parsed: counters.rowsParsed,
      extentReadable: metadata.extentWgs84 !== null,
      ringLabelSample: rings[0]?.ringLabel ?? null,
      ok,
      reason,
    });
    lines.push(
      JSON.stringify({
        kind: "publisher",
        cityKey: entry.cityKey,
        mode: entry.mode,
        hasEtjRings: true,
        layerName: metadata.layerName,
        layerLastEditAt: metadata.lastEditAt,
        layerFeatureCount,
        etjFeatureCount: counters.rowsParsed,
        extentWgs84: metadata.extentWgs84,
        ringLabelSample: rings[0]?.ringLabel ?? null,
        predicateGuard: ok ? "ok" : reason,
      }),
    );
  }

  const built = buildEtjBoundaryIndex(indexEntries);
  const outcomes: EtjControlOutcome[] = [];
  for (const cp of controlPoints) {
    const result = resolveEtjAtPoint(
      cp.longitude,
      cp.latitude,
      built,
      coverage,
      cp.containing,
    );
    const fact = etjFactFromContainment(result);
    const cityOk =
      cp.expectCityKey === null || fact.cityKey === cp.expectCityKey;
    const ok = fact.status === cp.expect && cityOk;
    outcomes.push({ key: cp.key, expect: cp.expect, actual: fact.status, ok, fact });
    lines.push(
      JSON.stringify({
        kind: "control-point",
        key: cp.key,
        parcelNodeId: cp.parcelNodeId,
        situs: cp.situs,
        point: { longitude: cp.longitude, latitude: cp.latitude },
        preRegistered: cp.expect,
        actual: fact.status,
        expectCityKey: cp.expectCityKey,
        actualCityKey: fact.cityKey ?? null,
        ringLabel: fact.ringLabel ?? null,
        sourceCitation: fact.sourceCitation ?? null,
        coveredBy: fact.coveredBy ?? null,
        ringsConsulted: fact.ringsConsulted ?? null,
        basis: fact.basis,
        verdict: ok ? "PASS" : "FAIL",
      }),
    );
  }

  const guardFailures = guards.filter((g) => !g.ok);
  const failed = outcomes.filter((o) => !o.ok).length + guardFailures.length;
  const passed = outcomes.filter((o) => o.ok).length;

  lines.push(
    JSON.stringify({
      kind: "summary",
      publishersWithRings: guards.length,
      publishersEnumeratedWithoutRings: coverage.filter((c) => !c.hasEtjRings).length,
      ringsAcquired: built.length,
      controlPointsPassed: passed,
      controlPointsFailed: outcomes.filter((o) => !o.ok).length,
      predicateGuardFailures: guardFailures.map((g) => g.cityKey),
    }),
  );

  return { lines, passed, failed, guards, outcomes, coverage, index: built };
}
