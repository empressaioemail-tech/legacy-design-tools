/**
 * PER-PARCEL setbacks for Marble Falls and Horseshoe Bay (Burnet County, 48053), OPS-24 stage 6,
 * 2026-10-13. Operator ruling: "don't ship Burnet half way; do the districts" -- every stamped
 * district in both cities resolves here to one of three outcomes, never to a guessed number:
 *
 *   served       (SETBACK_PARCEL_SERVED)   -- the parcel's own data settles every condition and all
 *                                            four setbacks are single numbers.
 *   conditional  (SETBACK_CONDITIONAL_SET) -- the ordinance's standards as a set of branches, each
 *                                            with the condition it applies under ("if X: a; if Y: b"),
 *                                            and/or a setback the ordinance states as a rule rather
 *                                            than one number (a total side yard). A caller that can
 *                                            only show four numbers must decline with this code.
 *   declined     (a named code)            -- no standard can be served: the text is not sourced yet
 *                                            (SETBACK_SOURCE_PENDING), the Horseshoe Bay zone is not
 *                                            known (SETBACK_ZONE_UNRESOLVED / _UNMAPPED / _COMBINATION_
 *                                            UNTABLED), or the register refuses the district.
 *
 * WHY PER PARCEL. `getSetbackTableForZoning` (index.ts) resolves by (jurisdiction, district code)
 * and still refuses these districts by code (SETBACK_CONDITIONAL_NOT_EVALUATED) -- correctly, since
 * by code alone the conditions cannot be evaluated. This module adds the parcel facts the
 * ordinances key on (burnet-parcel-facts.ts): the Horseshoe Bay geographic zone (the city zoning
 * layer's SUBDIVISION, persisted by the zoning stamp as txgio_parcel.zoning_subarea), adjacency to
 * Lake Marble Falls / Lake LBJ, Table 4.2.6.A lot width, and the CAD state category.
 *
 * PLAT CLAUSE (operator ruling 2026-10-13). Where a Horseshoe Bay yard paragraph opens "Except as
 * specified to the contrary on an approved plat, which specification shall control", the ordinance
 * default is served with `platNote` set -- the visible note "A recorded plat may set different
 * setbacks." -- never silently.
 *
 * Data: burnet-parcel-standards.json (built from pack E by scripts/build-burnet-parcel-standards.mjs)
 * and, for the seven Marble Falls districts the district table already serves, marble-falls-tx.json.
 */
import standards from "./burnet-parcel-standards.json" with { type: "json" };
import { getSetbackTableForZoning, isSetbackRefusalError, type SetbackDistrict } from "./index.js";
import {
  SETBACK_CONDITIONAL_NOT_EVALUATED,
  SETBACK_EDITION_CURRENT,
  checkSetbackEditionCurrency,
} from "./county-edition-currency.js";
import {
  measureLotWidth,
  measureWaterAdjacency,
  ptadCategory,
  widthBandIntersects,
  type LotWidthMeasure,
  type PtadCategory,
  type WaterAdjacency,
} from "./burnet-parcel-facts.js";

/* ------------------------------------- codes ------------------------------------- */

export const SETBACK_PARCEL_SERVED = "SETBACK_PARCEL_SERVED";
/** The standards are a set of conditional branches (or a rule, not one number); see `branches`. */
export const SETBACK_CONDITIONAL_SET = "SETBACK_CONDITIONAL_SET";
/** Horseshoe Bay: the parcel carries no geographic zone (no zoning_subarea stamped yet, or blank). */
export const SETBACK_ZONE_UNRESOLVED = "SETBACK_ZONE_UNRESOLVED";
/** Horseshoe Bay: the parcel's SUBDIVISION value is not in the reviewed SUBDIVISION -> zone table. */
export const SETBACK_ZONE_UNMAPPED = "SETBACK_ZONE_UNMAPPED";
/** Horseshoe Bay: the zone is known but no reviewed standard exists for (district, zone). */
export const SETBACK_ZONE_COMBINATION_UNTABLED = "SETBACK_ZONE_COMBINATION_UNTABLED";
export { SETBACK_SOURCE_PENDING } from "./county-edition-currency.js";
import { SETBACK_SOURCE_PENDING } from "./county-edition-currency.js";

/** Every code a `declined` resolution can carry from this module itself (register codes pass through). */
export const PARCEL_SETBACK_ZONE_CODES = [
  SETBACK_ZONE_UNRESOLVED,
  SETBACK_ZONE_UNMAPPED,
  SETBACK_ZONE_COMBINATION_UNTABLED,
] as const;

export const PLAT_NOTE = "A recorded plat may set different setbacks.";

/* ------------------------------------- types ------------------------------------- */

export interface SetbackValue {
  /** A single number (feet, or percent for coverage), or null when the ordinance states a rule / nothing. */
  value: number | null;
  /** The ordinance text for this cell (verbatim, plus any reviewed reading in brackets). */
  text: string;
}

export interface StandardSet {
  label: string;
  citation: string;
  pageUrl: string | null;
  front: SetbackValue;
  side: SetbackValue;
  rear: SetbackValue;
  streetSide: SetbackValue;
  maxHeightFt: SetbackValue;
  maxLotCoveragePct: SetbackValue;
  notes: string[];
}

export interface ParcelSetbackBranch {
  /** Plain-language condition this branch applies under. */
  condition: string;
  standards: StandardSet;
}

export interface EvaluatedFact {
  fact: "horseshoe-bay-zone" | "water-adjacency" | "lot-width" | "cad-category" | "situs-street";
  state: string;
  basis: string;
}

interface ResolutionCommon {
  jurisdictionKey: "marble-falls-tx" | "horseshoe-bay-tx";
  districtCode: string | null;
  /** Horseshoe Bay geographic zone the parcel resolved to ("3/4A", "7", ...), else null. */
  zone: string | null;
  facts: EvaluatedFact[];
  /** Set (to PLAT_NOTE plus the ordinance's own clause) when a recorded plat can override the default. */
  platNote: string | null;
  notes: string[];
}

export type ParcelSetbackResolution =
  | (ResolutionCommon & { outcome: "served"; code: typeof SETBACK_PARCEL_SERVED; standards: StandardSet })
  | (ResolutionCommon & {
      outcome: "conditional";
      code: typeof SETBACK_CONDITIONAL_SET;
      /** Why the standards are conditional, one line. */
      reason: string;
      branches: ParcelSetbackBranch[];
    })
  | (ResolutionCommon & { outcome: "declined"; code: string; detail: string });

export interface BurnetParcelSetbackInput {
  jurisdictionKey: string;
  /** txgio_parcel.zoning_district */
  zoningDistrict: string | null | undefined;
  /** txgio_parcel.zoning_subarea (Horseshoe Bay: the layer's SUBDIVISION). */
  zoningSubarea?: string | null;
  /** txgio_parcel.geometry (GeoJSON Polygon/MultiPolygon, WGS84). */
  geometry?: unknown;
  /** cad_property.property_use_code (latest tax year). */
  propertyUseCode?: string | null;
  /** Situs address (txgio_parcel.situs_address or cad_property.situs_address). */
  situsAddress?: string | null;
}

/* ----------------------------------- data typing ----------------------------------- */

interface Cell {
  value: number | null;
  text: string;
}
interface CellFields {
  front: Cell;
  side: Cell;
  rear: Cell;
  street_side: Cell;
  max_height: Cell;
  max_lot_coverage: Cell;
}
interface MfRow {
  id: string;
  label: string;
  use: "residential" | "nonresidential";
  lot_width_tier_ft: [number, number | null] | null;
  min_lot_width_printed: string | null;
  citation: string;
  page_url: string;
  fields: CellFields;
  lake: null | { rule: string; verbatim: string; adjacent: { side: Cell; rear: Cell; notes?: string[] } };
  notes: string[];
}
interface HsbCombo {
  zoning: string;
  subdivision: string;
  zone: string;
  kind: "standard" | "alternatives" | "pending";
  pending?: string;
  note?: string;
  alternatives?: Array<{ condition: string; citation: string; page_url: string; fields: CellFields; notes: string[] }>;
  citation?: string;
  page_url?: string;
  zone_scope?: string;
  fields?: CellFields;
  waterfront_rear?: Cell | null;
  shoreline_height?: { not_adjacent: number; adjacent: number } | null;
  street_side_lot?: { field: "side"; street: string; on_street: Cell; otherwise: Cell } | null;
  plat_clause?: string | null;
  notes?: string[];
}
interface Data {
  marble_falls: { lake_note_verbatim: string; districts: Record<string, { district_code: string; rows: MfRow[] }> };
  horseshoe_bay: {
    subdivisions: Array<{ subdivision: string; zone: string; status: "name-match" | "inferred"; section: string; basis: string }>;
    unmapped_subdivisions: Array<{ subdivision: string; basis: string }>;
    combos: HsbCombo[];
  };
}
const DATA = standards as unknown as Data;

/** The Marble Falls districts resolved per parcel here (the other 7 are served by the district table). */
export const MARBLE_FALLS_PARCEL_DISTRICTS = Object.keys(DATA.marble_falls.districts);

/** Marble Falls districts whose residential rows are the Table 4.2.2 / 4.2.6.A building-type menu. */
const RESIDENTIAL_TABLE_DISTRICTS: ReadonlySet<string> = new Set(["FR", "RE", "NR", "TR", "MR", "DR"]);

/* ------------------------------------- helpers ------------------------------------- */

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

function toStandard(label: string, citation: string, pageUrl: string | null, f: CellFields, notes: string[]): StandardSet {
  return {
    label,
    citation,
    pageUrl,
    front: { ...f.front },
    side: { ...f.side },
    rear: { ...f.rear },
    streetSide: { ...f.street_side },
    maxHeightFt: { ...f.max_height },
    maxLotCoveragePct: { ...f.max_lot_coverage },
    notes: [...notes],
  };
}

function allFourNumbers(s: StandardSet): boolean {
  return [s.front, s.side, s.rear, s.streetSide].every((v) => typeof v.value === "number");
}

function settle(
  common: ResolutionCommon,
  branches: ParcelSetbackBranch[],
  reason: string,
): ParcelSetbackResolution {
  if (branches.length === 1 && allFourNumbers(branches[0].standards)) {
    return { ...common, outcome: "served", code: SETBACK_PARCEL_SERVED, standards: branches[0].standards };
  }
  return { ...common, outcome: "conditional", code: SETBACK_CONDITIONAL_SET, reason, branches };
}

function declined(common: ResolutionCommon, code: string, detail: string): ParcelSetbackResolution {
  return { ...common, outcome: "declined", code, detail };
}

function waterFact(w: WaterAdjacency): EvaluatedFact {
  return { fact: "water-adjacency", state: `${w.lakeName}: ${w.state}`, basis: w.basis };
}

/* ---------------------------------- Marble Falls ---------------------------------- */

function servedFromDistrictTable(common: ResolutionCommon, d: SetbackDistrict, note: string | undefined): ParcelSetbackResolution {
  const num = (v: number, unit: string): SetbackValue => ({ value: v, text: `${v}${unit}` });
  const standards: StandardSet = {
    label: d.district_name,
    citation: "marble-falls-tx.json (district table, pack E)",
    pageUrl: d.citation_url,
    front: num(d.front_ft, "'"),
    side: num(d.side_ft, "'"),
    rear: num(d.rear_ft, "'"),
    streetSide: num(d.side_corner_ft, "'"),
    // 999 / 100 are the corpus's not_specified sentinels (README), never a real limit.
    maxHeightFt: d.max_height_ft === 999 ? { value: null, text: "NOT SPECIFIED" } : num(d.max_height_ft, "'"),
    maxLotCoveragePct: d.max_lot_coverage_pct === 100 ? { value: null, text: "NOT SPECIFIED" } : num(d.max_lot_coverage_pct, "%"),
    notes: note ? [note] : [],
  };
  return { ...common, outcome: "served", code: SETBACK_PARCEL_SERVED, standards };
}

function resolveMarbleFalls(input: BurnetParcelSetbackInput, code: string): ParcelSetbackResolution {
  const common: ResolutionCommon = { jurisdictionKey: "marble-falls-tx", districtCode: code || null, zone: null, facts: [], platNote: null, notes: [] };
  const district = DATA.marble_falls.districts[code];
  if (!district) {
    // Not one of the 10 per-parcel districts: the district-level path decides (serves, or refuses by code).
    try {
      const table = getSetbackTableForZoning("marble-falls-tx", code);
      const row = table?.districts.find((d) => norm(d.district_name.split(/\s+/)[0]) === code);
      if (!row) return declined(common, "SETBACK_SOURCE_NOT_REGISTERED", `Marble Falls has no served row for district "${code}".`);
      return servedFromDistrictTable(common, row, undefined);
    } catch (err) {
      if (!isSetbackRefusalError(err)) throw err;
      return declined(common, err.code, err.message);
    }
  }

  let rows = district.rows;
  const facts: EvaluatedFact[] = [];
  const notes: string[] = [];

  // CAD category -> which of the district's rows can govern the existing improvement.
  const cat: PtadCategory = ptadCategory(input.propertyUseCode);
  const hasNonres = rows.some((r) => r.use === "nonresidential");
  const hasRes = rows.some((r) => r.use === "residential");
  if (cat === "F" && hasNonres && hasRes) {
    rows = rows.filter((r) => r.use === "nonresidential");
    facts.push({ fact: "cad-category", state: "F (commercial / industrial)", basis: `CAD property_use_code "${input.propertyUseCode}": PTAD category F, so the existing improvement is nonresidential and the Table 4.3.1.B row governs` });
  } else if ((cat === "A" || cat === "B" || cat === "M") && hasNonres && hasRes && RESIDENTIAL_TABLE_DISTRICTS.has(code)) {
    // Only for the districts whose residential rows are the Table 4.2.2 / 4.2.6.A building-type
    // menu. DN and DT are mixed-use districts whose ONLY residential row is the townhouse row, and a
    // residential PTAD category (A also covers a detached house) does not say "townhouse", so there
    // the nonresidential/mixed-use row stays in the set.
    rows = rows.filter((r) => r.use === "residential");
    facts.push({ fact: "cad-category", state: `${cat} (residential)`, basis: `CAD property_use_code "${input.propertyUseCode}": PTAD category ${cat} (residential), so the nonresidential Table 4.3.1.B row is set aside; which residential building type governs is not in the CAD record` });
  } else {
    facts.push({
      fact: "cad-category",
      state: cat === "none" ? "no CAD use code" : cat,
      basis: cat === "none" ? "no CAD property_use_code on record: building type unknown" : `CAD property_use_code "${input.propertyUseCode}" does not narrow this district's rows`,
    });
  }

  // Table 4.2.6.A lot-width bands (DR only).
  if (rows.some((r) => r.lot_width_tier_ft)) {
    const w: LotWidthMeasure = measureLotWidth(input.geometry);
    if (w.intervalFt) {
      const kept = rows.filter((r) => !r.lot_width_tier_ft || widthBandIntersects(r.lot_width_tier_ft, w.intervalFt!));
      if (kept.length > 0) rows = kept;
      facts.push({ fact: "lot-width", state: `[${w.intervalFt[0]}, ${w.intervalFt[1]}] ft`, basis: w.basis });
    } else {
      facts.push({ fact: "lot-width", state: "undetermined", basis: w.basis });
    }
  }

  // Lake Marble Falls (Table 4.3.1.B note 1): only rows that carry the lake rule.
  let water: WaterAdjacency | null = null;
  if (rows.some((r) => r.lake)) {
    water = measureWaterAdjacency(input.geometry, "lake-marble-falls");
    facts.push(waterFact(water));
  }

  const branches: ParcelSetbackBranch[] = [];
  const many = rows.length > 1;
  for (const r of rows) {
    const typeCond = many ? `developed as: ${r.label}` : "";
    const rowNotes = [...r.notes];
    if (r.min_lot_width_printed) rowNotes.push(`Minimum lot width for this row (printed): ${r.min_lot_width_printed}`);
    const base = toStandard(r.label, r.citation, r.page_url, r.fields, rowNotes);
    if (!r.lake || !water) {
      branches.push({ condition: typeCond || "all parcels in the district", standards: base });
      continue;
    }
    const adjacent: StandardSet = {
      ...base,
      side: { ...r.lake.adjacent.side },
      rear: { ...r.lake.adjacent.rear },
      notes: [...base.notes, `Table 4.3.1.B note 1 (verbatim): ${r.lake.verbatim}`, ...(r.lake.adjacent.notes ?? [])],
    };
    const join = (a: string, b: string) => (a ? `${a}; ${b}` : b);
    if (water.state === "not-adjacent") branches.push({ condition: join(typeCond, "not adjacent to Lake Marble Falls"), standards: base });
    else if (water.state === "adjacent") branches.push({ condition: join(typeCond, "adjacent to Lake Marble Falls"), standards: adjacent });
    else {
      branches.push({ condition: join(typeCond, "if the parcel is not adjacent to Lake Marble Falls"), standards: base });
      branches.push({ condition: join(typeCond, "if the parcel is adjacent to Lake Marble Falls"), standards: adjacent });
    }
  }

  const reasons: string[] = [];
  if (rows.length > 1) reasons.push(`the ordinance gives ${code} ${rows.length} building-type rows and the parcel's data does not say which is built`);
  if (water?.state === "undetermined") reasons.push("adjacency to Lake Marble Falls is undetermined");
  if (water?.state === "adjacent") reasons.push("the side/rear adjacent to Lake Marble Falls takes the note 1 setback");
  if (branches.some((b) => !allFourNumbers(b.standards)) && reasons.length === 0) reasons.push("a setback is stated as a rule or a build-to line, not one number");
  return settle({ ...common, facts, notes }, branches, reasons.join("; ") || "conditional standards");
}

/* ---------------------------------- Horseshoe Bay ---------------------------------- */

function resolveHorseshoeBay(input: BurnetParcelSetbackInput, code: string): ParcelSetbackResolution {
  const subarea = norm(input.zoningSubarea);
  const common: ResolutionCommon = { jurisdictionKey: "horseshoe-bay-tx", districtCode: code || null, zone: null, facts: [], platNote: null, notes: [] };

  // The register first: a code with no sourced text (MH-1), no dimensional standards (LA, MOR, CA,
  // DR, PD) or an unverified source refuses whatever the zone. Only the zone-varying codes
  // (conditional-not-evaluated) and the cleared-but-untabled ones go on to zone resolution.
  const verdict = checkSetbackEditionCurrency({ city: "Horseshoe Bay", districtCode: code || null });
  if (verdict.code !== SETBACK_CONDITIONAL_NOT_EVALUATED && verdict.code !== SETBACK_EDITION_CURRENT) {
    return declined(common, verdict.code, verdict.detail);
  }

  if (!subarea) {
    return declined(
      common,
      SETBACK_ZONE_UNRESOLVED,
      `Horseshoe Bay ${code}: standards differ by geographic zone and this parcel carries no zone (txgio_parcel.zoning_subarea is empty -- the zoning stamp has not written the layer's SUBDIVISION for it yet).`,
    );
  }
  const unmapped = DATA.horseshoe_bay.unmapped_subdivisions.find((u) => u.subdivision === subarea);
  const mapped = DATA.horseshoe_bay.subdivisions.find((s) => s.subdivision === subarea);
  if (unmapped || !mapped) {
    return declined(
      common,
      SETBACK_ZONE_UNMAPPED,
      unmapped
        ? `Horseshoe Bay SUBDIVISION "${subarea}" is not mapped to a zone: ${unmapped.basis}`
        : `Horseshoe Bay SUBDIVISION "${subarea}" is not in the reviewed SUBDIVISION -> zone table.`,
    );
  }
  const zoneFact: EvaluatedFact = {
    fact: "horseshoe-bay-zone",
    state: `SUBDIVISION ${subarea} -> Zone ${mapped.zone} (${mapped.status})`,
    basis: mapped.basis,
  };
  const withZone: ResolutionCommon = { ...common, zone: mapped.zone, facts: [zoneFact] };
  const combo = DATA.horseshoe_bay.combos.find((c) => c.zoning === code && c.subdivision === subarea);
  if (!combo) {
    return declined(
      withZone,
      SETBACK_ZONE_COMBINATION_UNTABLED,
      `Horseshoe Bay ${code} in Zone ${mapped.zone} (SUBDIVISION ${subarea}): no reviewed standard for this district in this zone.`,
    );
  }
  if (combo.kind === "pending") return declined(withZone, SETBACK_SOURCE_PENDING, `Horseshoe Bay ${code}, Zone ${combo.zone}: ${combo.pending}`);

  if (combo.kind === "alternatives") {
    const branches = combo.alternatives!.map((a) => ({
      condition: a.condition,
      standards: toStandard(`${code} (Zone ${combo.zone})`, a.citation, a.page_url, a.fields, a.notes),
    }));
    return { ...withZone, notes: combo.note ? [combo.note] : [], outcome: "conditional", code: SETBACK_CONDITIONAL_SET, reason: combo.note ?? "alternatives", branches };
  }

  const facts = [...withZone.facts];
  const fields: CellFields = JSON.parse(JSON.stringify(combo.fields));
  const reasons: string[] = [];

  if (combo.street_side_lot) {
    const s = combo.street_side_lot;
    const situs = norm(input.situsAddress);
    const onStreet = new RegExp(`\\b${s.street}\\s+(DR|DRIVE)\\b`).test(situs);
    fields[s.field] = onStreet ? { ...s.on_street } : { ...s.otherwise };
    facts.push({
      fact: "situs-street",
      state: situs ? (onStreet ? `on ${s.street} Drive` : `not on ${s.street} Drive`) : "no situs address",
      basis: situs ? `situs address "${situs}"` : "no situs address on record",
    });
  }

  const needsWater = Boolean(combo.waterfront_rear || combo.shoreline_height);
  const water = needsWater ? measureWaterAdjacency(input.geometry, "lake-lbj") : null;
  if (water) facts.push(waterFact(water));

  const notes = [...(combo.notes ?? [])];
  const platNote = combo.plat_clause ? `${PLAT_NOTE} The ordinance's yard text opens: ${combo.plat_clause}.` : null;
  const label = `${code} (Zone ${combo.zone})`;

  const variant = (waterfront: boolean): StandardSet => {
    const f: CellFields = JSON.parse(JSON.stringify(fields));
    if (waterfront && combo.waterfront_rear) f.rear = { ...combo.waterfront_rear };
    if (combo.shoreline_height) {
      const h = waterfront ? combo.shoreline_height.adjacent : combo.shoreline_height.not_adjacent;
      f.max_height = { value: h, text: `${f.max_height.text} [${waterfront ? "lot contiguous with the shoreline" : "lot not contiguous with the shoreline"}: ${h} ft]` };
    }
    return toStandard(label, combo.citation!, combo.page_url ?? null, f, notes);
  };

  const branches: ParcelSetbackBranch[] = [];
  if (!water || water.state === "not-adjacent") branches.push({ condition: water ? "not a waterfront (Lake LBJ) lot" : "all parcels in the district and zone", standards: variant(false) });
  else if (water.state === "adjacent") branches.push({ condition: "waterfront (Lake LBJ) lot", standards: variant(true) });
  else {
    branches.push({ condition: "if the lot is not on Lake LBJ", standards: variant(false) });
    branches.push({ condition: "if the lot is a waterfront (Lake LBJ) lot", standards: variant(true) });
    reasons.push("whether the lot is on Lake LBJ is undetermined");
  }
  if (branches.some((b) => !allFourNumbers(b.standards))) reasons.push("a setback is stated as a rule (total side yards, an abutting-residential rule) or not stated, not one number");
  return settle({ ...withZone, facts, notes: [], platNote }, branches, reasons.join("; ") || "conditional standards");
}

/* ------------------------------------- entry ------------------------------------- */

export function resolveBurnetParcelSetbacks(input: BurnetParcelSetbackInput): ParcelSetbackResolution {
  const key = (input.jurisdictionKey ?? "").trim().toLowerCase().replace(/_/g, "-");
  const code = norm(input.zoningDistrict);
  if (key === "marble-falls-tx") return resolveMarbleFalls(input, code);
  if (key === "horseshoe-bay-tx") return resolveHorseshoeBay(input, code);
  throw new TypeError(`resolveBurnetParcelSetbacks handles marble-falls-tx and horseshoe-bay-tx only, got "${input.jurisdictionKey}"`);
}

/**
 * One line per branch, for a caller that renders text ("if X: front 25 ft, side 5 ft ..."). A
 * value-less cell prints its ordinance text. Never collapses branches into one number.
 */
export function describeParcelSetbacks(r: ParcelSetbackResolution): string[] {
  const fmt = (s: StandardSet) =>
    [
      ["front", s.front],
      ["side", s.side],
      ["rear", s.rear],
      ["street side", s.streetSide],
    ]
      .map(([k, v]) => {
        const sv = v as SetbackValue;
        return `${k} ${sv.value !== null ? `${sv.value} ft` : `"${sv.text}"`}`;
      })
      .join(", ");
  if (r.outcome === "served") return [`${r.standards.label}: ${fmt(r.standards)}${r.platNote ? ` (${PLAT_NOTE})` : ""}`];
  if (r.outcome === "conditional") return r.branches.map((b) => `if ${b.condition}: ${fmt(b.standards)}${r.platNote ? ` (${PLAT_NOTE})` : ""}`);
  return [`declined ${r.code}: ${r.detail}`];
}
