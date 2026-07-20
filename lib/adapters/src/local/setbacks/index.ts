/**
 * Per-jurisdiction setback table loader.
 *
 * Loads the hand-curated `<jurisdiction>.json` tables (locked decision
 * #9) and exposes them through a typed lookup. The briefing engine
 * (DA-PI-3) calls {@link getSetbackTable} keyed by the resolved
 * jurisdiction key when it builds dimensional-rule prose.
 *
 * Adding a new jurisdiction:
 *   1. Drop a `<jurisdiction-key>.json` next to this file.
 *   2. Append the import + entry to the SETBACK_TABLES record below.
 *
 * The schema is intentionally a plain JSON object (not a Zod schema)
 * because the tables are read at server boot and validated once via
 * the structural typecheck below — adding a Zod runtime check would
 * just duplicate the typescript guarantees we already have.
 */

import grandCountyUt from "./grand-county-ut.json" with { type: "json" };
import lemhiCountyId from "./lemhi-county-id.json" with { type: "json" };
import bastropTx from "./bastrop-tx.json" with { type: "json" };
import sanMarcosTx from "./san-marcos-tx.json" with { type: "json" };
import drippingSpringsTx from "./dripping-springs-tx.json" with { type: "json" };
import kyleTx from "./kyle-tx.json" with { type: "json" };
import budaTx from "./buda-tx.json" with { type: "json" };
import utahUnincorporated from "./utah-unincorporated.json" with { type: "json" };
import idahoUnincorporated from "./idaho-unincorporated.json" with { type: "json" };

/** Per locked decision #9 — one row per zoning district per jurisdiction. */
export interface SetbackDistrict {
  district_name: string;
  front_ft: number;
  rear_ft: number;
  side_ft: number;
  side_corner_ft: number;
  max_height_ft: number;
  max_lot_coverage_pct: number;
  max_impervious_pct: number;
  citation_url: string;
  /**
   * Optional per-value audit block read by the setback extraction acceptance
   * gate (see `gate.ts` + docs/setback-extraction-acceptance-gate.md). The
   * serving route ignores it — it does not reach the wire — so adding it to a
   * table cannot change the FE contract. New (fan-out) tables MUST carry it;
   * the four legacy hand-curated tables predate it and are treated as
   * un-gated. Typed loosely here (Record) so the loader stays JSON-schema-free
   * per the original design note; the gate imposes the strict shape.
   */
  provenance?: Record<string, unknown>;
}

export interface SetbackTable {
  jurisdictionKey: string;
  jurisdictionDisplayName: string;
  /** Optional context note for fallback / statewide-default tables. */
  note?: string;
  districts: SetbackDistrict[];
}

const SETBACK_TABLES: Readonly<Record<string, SetbackTable>> = {
  "grand-county-ut": grandCountyUt as SetbackTable,
  "lemhi-county-id": lemhiCountyId as SetbackTable,
  "bastrop-tx": bastropTx as SetbackTable,
  // Registered with an empty districts[] — San Marcos is not yet in the code
  // atom corpus, so it serves 200 with an explicit "pending onboarding" note
  // (see the file's `note`) rather than 404 setback_table_not_found. No
  // fabricated setback values ship; the acceptance gate blocks population
  // until citation-backed extraction + human review lands.
  "san-marcos-tx": sanMarcosTx as SetbackTable,
  // Hays County batch (F4k) — citation-backed from live ordinances, carry
  // per-value provenance. Dripping Springs from Municode Ch. 30 Exhibit A
  // Section 3; Kyle from eCode360 Ch. 53 §53-33 Charts 1 & 2; Buda from
  // eCode360 UDC §2.07 dimensional tables. Synthesized keys are
  // `dripping_springs_tx`/`kyle_tx`/`buda_tx`, normalized to hyphen form here.
  "dripping-springs-tx": drippingSpringsTx as SetbackTable,
  "kyle-tx": kyleTx as SetbackTable,
  "buda-tx": budaTx as SetbackTable,
  "utah-unincorporated": utahUnincorporated as SetbackTable,
  "idaho-unincorporated": idahoUnincorporated as SetbackTable,
};

export const SETBACK_JURISDICTION_KEYS = Object.keys(SETBACK_TABLES);

/**
 * Normalize a jurisdiction key to the canonical format expected by the
 * setback table lookup: lowercase with hyphens. The geocode path emits
 * keys with underscores (e.g. `bastrop_tx`), but the JSON files are
 * keyed with hyphens (`bastrop-tx.json`).
 */
function normalizeJurisdictionKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

/**
 * Returns the setback table for a jurisdiction key, or null if no table
 * exists. The briefing engine should treat null as "no codified
 * dimensional rules available — fall back to base IBC/IRC".
 */
export function getSetbackTable(jurisdictionKey: string): SetbackTable | null {
  const normalized = normalizeJurisdictionKey(jurisdictionKey);
  return SETBACK_TABLES[normalized] ?? null;
}

/**
 * Look up a single zoning district within a jurisdiction. Case-
 * insensitive on the district name to absorb the small spelling
 * differences between the GIS layer and the ordinance PDF.
 */
export function getSetbackDistrict(
  jurisdictionKey: string,
  districtName: string,
): SetbackDistrict | null {
  const table = getSetbackTable(jurisdictionKey);
  if (!table) return null;
  const wanted = districtName.trim().toLowerCase();
  return (
    table.districts.find(
      (d) => d.district_name.toLowerCase() === wanted,
    ) ?? null
  );
}

export function listSetbackTables(): SetbackTable[] {
  return Object.values(SETBACK_TABLES);
}
