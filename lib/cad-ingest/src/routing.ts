/**
 * CAD roll routing — embedded registry slice for bulk_primary counties.
 *
 * Mirrors `_catalog/tx_cad_source_registry.json` fields for Dallas and
 * Tarrant. Full JSON path is optional follow-on; this slice is enough to
 * refuse silent StratMap fallback on bulk_primary counties.
 */

import type { CadSourceTier } from "./tier";

export type AdapterKind =
  | "county-run"
  | "dcad-bulk-only"
  | "pacs"
  | "orion"
  | "stratmap";

interface RegistrySliceRow {
  fips: string;
  name: string;
  bulkPrimary: boolean;
  adapterKind: AdapterKind;
  format: string;
}

/** Embedded from tx_cad_source_registry.json (48113 + 48439). */
const REGISTRY_SLICE: RegistrySliceRow[] = [
  {
    fips: "48113",
    name: "Dallas",
    bulkPrimary: true,
    adapterKind: "dcad-bulk-only",
    format: "arcgis_rest",
  },
  {
    fips: "48439",
    name: "Tarrant",
    bulkPrimary: true,
    adapterKind: "county-run",
    format: "bulk_export",
  },
];

export interface CadRollRoute {
  /** Preferred tier when registry flags bulk export. Null = no preference. */
  preferredTier: CadSourceTier | null;
  adapterKind: AdapterKind | null;
  bulkPrimary: boolean;
  /** False when bulkPrimary — silent StratMap fallback is forbidden. */
  allowSilentStratmap: boolean;
}

export function resolveCadRollRoute(fips: string): CadRollRoute {
  const row = REGISTRY_SLICE.find((r) => r.fips === fips.trim());
  const bulkPrimary = row?.bulkPrimary ?? false;
  return {
    preferredTier: bulkPrimary ? "cad-export" : null,
    adapterKind: row?.adapterKind ?? null,
    bulkPrimary,
    allowSilentStratmap: !bulkPrimary,
  };
}

/** Lookup for tests and error messages. */
export function registrySliceRow(fips: string): RegistrySliceRow | undefined {
  return REGISTRY_SLICE.find((r) => r.fips === fips.trim());
}
