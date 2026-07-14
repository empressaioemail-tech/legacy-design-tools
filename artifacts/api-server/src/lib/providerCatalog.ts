/**
 * Provider catalog — provider-neutral metering + sourceKind couplings.
 *
 * Before this module, two call sites hardcoded the `cotality:` adapter-key
 * prefix: brokerageTierGate.ts (depth-meter metering + free-baseline keys)
 * and brokerageSiteContext.ts (sourceKind labeling). Any non-`cotality:`
 * provider prefix (the `county-gis:` keys from the Central TX parcels
 * provider, future `cad:*` keys) silently fell through to the unmetered /
 * tier-default path with nothing recording whether that was intended.
 * This module makes each provider's metering and labeling posture explicit
 * in one lookup that both call sites import.
 *
 * Deliberately minimal: a static prefix table plus two lookup functions.
 * Not a config system.
 */

import type { AdapterSourceKind } from "@workspace/adapters/types";

export interface ProviderCatalogEntry {
  /** Adapter-key prefix, including the trailing colon (e.g. `"cotality:"`). */
  readonly prefix: string;
  /** Human-readable provider label (logs / future UI). */
  readonly label: string;
  /**
   * Whether this provider's calls count against the paid depth meter
   * (COGS guard). Free public-record providers are never metered.
   */
  readonly metered: boolean;
  /**
   * Full adapter keys exempt from metering even when the provider is
   * metered — the free-baseline layers every tier gets.
   */
  readonly freeBaselineKeys: ReadonlySet<string>;
  /**
   * `briefing_sources.source_kind` override for this provider's adapters.
   * Absent = the call site applies its pre-catalog tier-default mapping
   * (`national:` → federal-adapter, state tier → state-adapter, else
   * federal-adapter).
   */
  readonly sourceKind?: AdapterSourceKind;
}

const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    // National public-records aggregator; paid per-call upstream, so
    // every layer except the free-baseline pair is metered.
    prefix: "cotality:",
    label: "Cotality",
    metered: true,
    freeBaselineKeys: new Set(["cotality:parcels", "cotality:zoning"]),
    sourceKind: "national-aggregator",
  },
  {
    // Central TX county ArcGIS parcel services (PR #242,
    // brokerageTxParcels.ts — the provider labels itself
    // `provider: "county-gis"` with a per-county service URL). Free
    // public record — never metered. A per-jurisdiction GIS feed is
    // exactly what the AdapterSourceKind doc scopes OUT of
    // `national-aggregator`, so these are `local-adapter`.
    prefix: "county-gis:",
    label: "County GIS (public record)",
    metered: false,
    freeBaselineKeys: new Set(),
    sourceKind: "local-adapter",
  },
  {
    // County appraisal-district roll data (feat/cad-brief-adapters).
    // The rows come from free CAD bulk exports ingested into the local
    // `cad_property` store (PR #245) — free public record, zero marginal
    // cost per read, never metered. Per-jurisdiction (per-CAD) data is
    // exactly what the AdapterSourceKind doc scopes OUT of
    // `national-aggregator`, so like `county-gis:` these are
    // `local-adapter`.
    prefix: "cad:",
    label: "County Appraisal District (public record)",
    metered: false,
    freeBaselineKeys: new Set(),
    sourceKind: "local-adapter",
  },
  {
    // Self-hosted TxGIO/StratMap land-parcel geometry store
    // (feat/txgio-parcel-geometry, `txgio:parcels:<fips>` keys from
    // brokerageTxParcels.ts for the counties with no live county GIS —
    // Hays/Comal). Public-domain state program data served from our own
    // Postgres — free public record, zero marginal cost per read, never
    // metered. Per-jurisdiction parcel data, so `local-adapter`, same
    // reasoning as `county-gis:`.
    prefix: "txgio:",
    label: "TxGIO/StratMap Land Parcels (public record)",
    metered: false,
    freeBaselineKeys: new Set(),
    sourceKind: "local-adapter",
  },
  {
    // Dormant since the 2026-06-17 Regrid purge. Listed so the dormant
    // keys keep their historical semantics — unmetered, tier-default
    // sourceKind — instead of picking up accidental new behavior.
    prefix: "regrid:",
    label: "Regrid (dormant)",
    metered: false,
    freeBaselineKeys: new Set(),
  },
];

export function providerCatalogEntryForKey(
  adapterKey: string,
): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => adapterKey.startsWith(entry.prefix));
}

/**
 * Whether a call against this adapter key counts toward the paid depth
 * meter. Unknown prefixes are unmetered, matching the pre-catalog
 * behavior where only `cotality:` keys were ever metered.
 */
export function isMeteredAdapterKey(adapterKey: string): boolean {
  const entry = providerCatalogEntryForKey(adapterKey);
  if (!entry || !entry.metered) return false;
  return !entry.freeBaselineKeys.has(adapterKey);
}

/**
 * Catalog sourceKind override for the adapter key, or `undefined` when
 * the call site should apply its tier-default mapping.
 */
export function providerSourceKindForKey(
  adapterKey: string,
): AdapterSourceKind | undefined {
  return providerCatalogEntryForKey(adapterKey)?.sourceKind;
}
