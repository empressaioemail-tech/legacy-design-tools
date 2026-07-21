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
import georgetownTx from "./georgetown-tx.json" with { type: "json" };
import roundRockTx from "./round-rock-tx.json" with { type: "json" };
import leanderTx from "./leander-tx.json" with { type: "json" };
import huttoTx from "./hutto-tx.json" with { type: "json" };
import newBraunfelsTx from "./new-braunfels-tx.json" with { type: "json" };
import cedarParkTx from "./cedar-park-tx.json" with { type: "json" };
import pflugervilleTx from "./pflugerville-tx.json" with { type: "json" };
import libertyHillTx from "./liberty-hill-tx.json" with { type: "json" };
import lockhartTx from "./lockhart-tx.json" with { type: "json" };
import taylorTx from "./taylor-tx.json" with { type: "json" };
import bastropCityTx from "./bastrop-city-tx.json" with { type: "json" };
import sanAntonioTx from "./san-antonio-tx.json" with { type: "json" };
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
  // Tables contain only code-backed scalar rules. A conditional rule that the
  // envelope cannot evaluate is explicitly omitted in the table note.
  "san-marcos-tx": sanMarcosTx as SetbackTable,
  // Hays County batch (F4k) — citation-backed from live ordinances, carry
  // per-value provenance. Dripping Springs from Municode Ch. 30 Exhibit A
  // Section 3; Kyle from eCode360 Ch. 53 §53-33 Charts 1 & 2; Buda from
  // eCode360 UDC §2.07 dimensional tables. Synthesized keys are
  // `dripping_springs_tx`/`kyle_tx`/`buda_tx`, normalized to hyphen form here.
  "dripping-springs-tx": drippingSpringsTx as SetbackTable,
  "kyle-tx": kyleTx as SetbackTable,
  "buda-tx": budaTx as SetbackTable,
  // F4l batch (Municode + city-PDF, citation-backed from live ordinances,
  // carry per-value provenance). Georgetown from UDC Ch. 6 §6.02 / Ch. 7 Table
  // 7.02.020 (Supp. 15, Ord. 2025-54; UDC rewrite pending ~mid-2026 — re-verify
  // when it lands); Round Rock from Pt. III Ch. 2 §2-26 (Supp. 25); Leander
  // from Ch. 14 Exhibit A Art. VI §6 (Supp. 4 U1); Hutto from UDC §10.403.4.2
  // (city PDF, Mar 2024 — NOT on Municode); New Braunfels from Ch. 144 §144-3.4
  // (Supp. 36 U3). Synthesized keys `georgetown_tx`/`round_rock_tx`/
  // `leander_tx`/`hutto_tx`/`new_braunfels_tx`, normalized to hyphen form here.
  "georgetown-tx": georgetownTx as SetbackTable,
  "round-rock-tx": roundRockTx as SetbackTable,
  "leander-tx": leanderTx as SetbackTable,
  "hutto-tx": huttoTx as SetbackTable,
  "new-braunfels-tx": newBraunfelsTx as SetbackTable,
  // WDLL item 5, Wave 1 batch 1: both cities have published ordinance
  // sources, but no local source-atom corpus or complete expected-district
  // set. Register explicit empty tables rather than inventing values; see
  // each file's note for the cited source and gate blocker.
  "cedar-park-tx": cedarParkTx as SetbackTable,
  "pflugerville-tx": pflugervilleTx as SetbackTable,
  // WDLL 5, Wave 1 batch 3. These jurisdictions must resolve to an explicit,
  // cited honest gap rather than 404 or an invented envelope. Their notes
  // identify the official source, live GIS codes, and unmodeled conditions.
  "liberty-hill-tx": libertyHillTx as SetbackTable,
  "lockhart-tx": lockhartTx as SetbackTable,
  "taylor-tx": taylorTx as SetbackTable,
  "bastrop-city-tx": bastropCityTx as SetbackTable,
  "san-antonio-tx": sanAntonioTx as SetbackTable,
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
