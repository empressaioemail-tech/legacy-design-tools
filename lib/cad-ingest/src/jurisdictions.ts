/**
 * UNIFIED jurisdiction onboarding config — the single composed view over
 * the scattered per-county / per-jurisdiction registries.
 *
 * WHY THIS EXISTS
 * ---------------
 * Onboarding a county today touches 4-5 separate registries, each keyed
 * and shaped differently:
 *
 *   1. `txgio/counties.ts`      TXGIO_COUNTIES   — parcel geometry + the
 *                                                  StratMap URL template.
 *   2. `counties.ts`            CAD_COUNTIES     — licensed CAD roll
 *                                                  ingest (pacs|orion).
 *   3. `sources.ts`             CAD_BULK_SOURCES — per-CAD free bulk-roll
 *                                                  acquisition posture.
 *   4. `txgio/zoning-layers.ts` ZONING_LAYERS    — per-CITY ArcGIS zoning
 *                                                  layers (many per county).
 *   5. `@workspace/adapters/setbacks`
 *                               SETBACK_TABLES   — per-jurisdiction setback
 *                                                  tables.
 *
 * Answering "what is county X configured with" meant reading all five.
 * Per the provable-county-data-pipeline design (Stage 0 — REGISTER), a
 * national pipeline needs ONE per-jurisdiction descriptor that composes
 * them.
 *
 * WHAT THIS IS (and is NOT)
 * -------------------------
 * This is a READ-ONLY composition. It does NOT hold any config values of
 * its own — every field is DERIVED from the five source registries at
 * call time, so it cannot drift from them and cannot change any county's
 * behavior. The five registries REMAIN the mechanism the CLIs use; their
 * lookups are untouched. This module is the single queryable *view* over
 * them plus the documented onboarding entry point.
 *
 * Zero behavior change is proved by the equality tests in
 * `__tests__/jurisdictions.test.ts`, which assert the composed descriptor
 * returns the exact objects the individual registries hold.
 *
 * TO ONBOARD A COUNTY (the "add a county = one place to look" entry point)
 * ------------------------------------------------------------------------
 * Register the facets a county has, each in its own source registry — the
 * descriptor composes them automatically, no edit here is required:
 *
 *   - geometry + StratMap land-use : add one line to TXGIO_COUNTIES
 *                                    (`txgio/counties.ts`). One statewide
 *                                    URL template; this is the one-line rail.
 *   - licensed CAD roll (optional) : add an entry to CAD_COUNTIES
 *                                    (`counties.ts`) with its format.
 *   - free bulk-roll source (opt.) : add an entry to CAD_BULK_SOURCES
 *                                    (`sources.ts`).
 *   - city zoning layers (optional): add entries to ZONING_LAYERS
 *                                    (`txgio/zoning-layers.ts`), one per city.
 *   - setback tables (optional)    : drop `<key>.json` + register in
 *                                    SETBACK_TABLES (`@workspace/adapters`).
 *
 * `getJurisdictionConfig(fips)` then returns the composed record; a facet
 * a county has not registered is simply absent (honest — never fabricated).
 */

import { TXGIO_COUNTIES, type TxgioCounty } from "./txgio/counties";
import { CAD_COUNTIES, type CadCounty } from "./counties";
import { CAD_BULK_SOURCES, type CadBulkSource } from "./sources";
import { ZONING_LAYERS, type ZoningLayerConfig } from "./txgio/zoning-layers";
import {
  getSetbackTable,
  SETBACK_JURISDICTION_KEYS,
  type SetbackTable,
} from "@workspace/adapters/setbacks";

/**
 * The single per-jurisdiction descriptor. Every field is a live reference
 * into the source registries — this record composes, it does not copy.
 *
 * A jurisdiction (county) always carries `fips`, `name`, and `state`.
 * Every capability-bearing field is OPTIONAL because a county contributes
 * whatever facets it has registered and honestly omits the rest (the
 * graceful-degradation principle from the pipeline design).
 */
export interface JurisdictionConfig {
  /** 5-digit county FIPS, e.g. `48209`. The canonical join key. */
  fips: string;
  /** County display name, e.g. `Hays`. */
  name: string;
  /**
   * Two-letter state code. Derived from the FIPS state prefix (`48` -> TX).
   * The source registries are Texas-locked today; this field is where the
   * per-state provider abstraction (design Stage: national) will hang.
   */
  state: string;

  /**
   * Parcel geometry + StratMap land-use source. Present iff the county is
   * in TXGIO_COUNTIES. Carries the per-county StratMap land-parcels zip URL.
   * This is the one-registry-line-per-county rail.
   */
  geometry?: TxgioCounty;

  /**
   * Licensed CAD appraisal-roll ingest config (parser format + bulk page).
   * Present iff the county is in CAD_COUNTIES.
   */
  cad?: CadCounty;

  /**
   * Free bulk-roll acquisition posture (open-fetch vs manual-download).
   * Present iff the county is in CAD_BULK_SOURCES.
   */
  bulkSource?: CadBulkSource;

  /**
   * City zoning layers whose polygons stamp this county's parcels. A county
   * can have several (one per city). Present (non-empty) iff at least one
   * ZONING_LAYERS entry targets this FIPS. Ordered as declared in the registry.
   */
  zoningLayers?: ZoningLayerConfig[];

  /**
   * Per-jurisdiction setback tables (from SETBACK_TABLES). Keyed by the
   * setback jurisdiction key (e.g. `georgetown-tx`), which is a CITY-level
   * key, so a county surfaces the setback tables of the cities whose zoning
   * layers it stamps. Present (non-empty) iff at least one such table exists.
   *
   * NOTE: setback tables are keyed by city, not FIPS, and the only FIPS
   * linkage available is via ZONING_LAYERS (`cityKey` -> `countyFips`).
   * County-level setback tables that are not tied to a zoning layer (e.g.
   * `grand-county-ut`, the unincorporated fallbacks) are therefore not
   * attached to any TX county descriptor; they remain reachable directly
   * through `getSetbackTable`. This mirrors exactly how the CLIs resolve
   * them today — no behavior change.
   */
  setbackTables?: SetbackTable[];
}

/** Derive the two-letter state code from a 5-digit county FIPS prefix. */
function stateFromFips(fips: string): string {
  const STATE_BY_FIPS_PREFIX: Record<string, string> = {
    "48": "TX",
    "49": "UT",
    "16": "ID",
  };
  return STATE_BY_FIPS_PREFIX[fips.slice(0, 2)] ?? "??";
}

/**
 * City zoning layers targeting a county, in registry declaration order.
 * Returns the live ZONING_LAYERS objects (not copies).
 */
function zoningLayersForCounty(fips: string): ZoningLayerConfig[] {
  return Object.values(ZONING_LAYERS).filter((z) => z.countyFips === fips);
}

/**
 * Setback tables reachable from a county via its zoning layers. A zoning
 * layer's `cityKey` is the setback jurisdiction key; we resolve each
 * through the exact same `getSetbackTable` the CLIs use. De-duplicated by
 * key, preserving first-seen (zoning-layer declaration) order.
 */
function setbackTablesForCounty(fips: string): SetbackTable[] {
  const seen = new Set<string>();
  const out: SetbackTable[] = [];
  for (const layer of zoningLayersForCounty(fips)) {
    if (seen.has(layer.cityKey)) continue;
    const table = getSetbackTable(layer.cityKey);
    if (table) {
      seen.add(layer.cityKey);
      out.push(table);
    }
  }
  return out;
}

/**
 * The set of FIPS codes any registry knows about (the union of the
 * FIPS-keyed registries). Zoning/setback tables are city-keyed and only
 * contribute a FIPS through their zoning layer's `countyFips`.
 */
function allKnownFips(): string[] {
  const fips = new Set<string>([
    ...Object.keys(TXGIO_COUNTIES),
    ...Object.keys(CAD_COUNTIES),
    ...Object.keys(CAD_BULK_SOURCES),
    ...Object.values(ZONING_LAYERS).map((z) => z.countyFips),
  ]);
  return [...fips].sort();
}

/**
 * Compose the unified descriptor for a county FIPS. Returns `undefined`
 * if no registry knows the county at all. Every present field is a live
 * reference into a source registry — this is a view, not a copy.
 */
export function getJurisdictionConfig(
  fips: string,
): JurisdictionConfig | undefined {
  const key = fips.trim();

  const geometry = TXGIO_COUNTIES[key];
  const cad = CAD_COUNTIES[key];
  const bulkSource = CAD_BULK_SOURCES[key];
  const zoningLayers = zoningLayersForCounty(key);
  const setbackTables = setbackTablesForCounty(key);

  const known =
    geometry !== undefined ||
    cad !== undefined ||
    bulkSource !== undefined ||
    zoningLayers.length > 0;
  if (!known) return undefined;

  // Prefer a registry-carried display name over the FIPS-only fallback.
  const name = geometry?.name ?? cad?.name ?? zoningLayers[0]?.cityName ?? key;

  const config: JurisdictionConfig = {
    fips: key,
    name,
    state: stateFromFips(key),
  };
  if (geometry) config.geometry = geometry;
  if (cad) config.cad = cad;
  if (bulkSource) config.bulkSource = bulkSource;
  if (zoningLayers.length > 0) config.zoningLayers = zoningLayers;
  if (setbackTables.length > 0) config.setbackTables = setbackTables;
  return config;
}

/**
 * The composed descriptor for every county any registry knows about,
 * ordered by FIPS. The single queryable inventory of "what every county
 * is configured with."
 */
export function listJurisdictions(): JurisdictionConfig[] {
  return allKnownFips()
    .map((fips) => getJurisdictionConfig(fips))
    .filter((c): c is JurisdictionConfig => c !== undefined);
}

/**
 * All FIPS codes with at least one registered facet, sorted. Convenience
 * over `listJurisdictions().map(j => j.fips)`.
 */
export function listJurisdictionFips(): string[] {
  return allKnownFips();
}

/**
 * Setback jurisdiction keys NOT attached to any county descriptor (they
 * have no zoning layer linking them to a FIPS). Surfaced so onboarding can
 * see county-level / fallback setback tables that the FIPS view omits by
 * design — e.g. `grand-county-ut`, `utah-unincorporated`. Not a gap; these
 * are reached directly via `getSetbackTable`, exactly as the CLIs do today.
 */
export function unlinkedSetbackKeys(): string[] {
  const linked = new Set<string>();
  for (const fips of allKnownFips()) {
    for (const layer of zoningLayersForCounty(fips)) {
      linked.add(layer.cityKey);
    }
  }
  return SETBACK_JURISDICTION_KEYS.filter((k) => !linked.has(k)).sort();
}
