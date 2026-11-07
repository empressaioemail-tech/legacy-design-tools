#!/usr/bin/env node
/**
 * Builds ../src/local/setbacks/burnet-parcel-standards.json: the per-PARCEL standards for the
 * Marble Falls and Horseshoe Bay districts that cannot be served by district code alone
 * (OPS-24 stage 6, operator ruling 2026-10-13: "don't ship Burnet half way; do the districts").
 *
 * Usage: node build-burnet-parcel-standards.mjs <path-to-packE.csv>
 *   (doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_browser_packE.csv, 163 rows)
 *
 * READS
 *   - pack E (the same CSV apply-packE-to-burnet-register.mjs reads): every Marble Falls number
 *     below is parsed from a pack E cell and carries that cell verbatim.
 *   - ../src/local/setbacks/horseshoe-bay-tx-zone-standards.json (written from pack E by
 *     apply-packE-to-burnet-register.mjs): every Horseshoe Bay number below is that file's
 *     `fields.<f>.value` for a named pack E row, and carries its `verbatim`.
 *
 * NOTHING HERE GUESSES. Every row is named in an explicit table below (district, pack E row
 * index, the building-type label pack E printed); a pack E row this script does not expect, or an
 * expected row whose label changed, throws. A cell is turned into a number only when it is a single
 * plain feet value (90', 7.5'); every other cell (5'/0', 0' /5', NOT SPECIFIED, a rule sentence) is
 * kept as text with `value: null`, and the resolver treats a null as "not a single number", never
 * as zero. The only cells given a number that pack E did not print as one plain value are the
 * reviewed entries in HSB_FIELD_REVIEWS and MF_LAKE_SPLIT, each with its reasoning in the output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./convert-ordinance-register-csv.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETBACKS = join(HERE, "../src/local/setbacks");
const OUT_PATH = join(SETBACKS, "burnet-parcel-standards.json");
const ZONE_FILE = JSON.parse(readFileSync(join(SETBACKS, "horseshoe-bay-tx-zone-standards.json"), "utf8"));

const CSV_PATH = process.argv[2];
if (!CSV_PATH) throw new Error("usage: build-burnet-parcel-standards.mjs <packE.csv>");
const csv = parseCsv(readFileSync(CSV_PATH, "utf8")).map((r, i) => ({ ...r, _row: i }));
if (csv.length !== 163) throw new Error(`pack E shape changed: ${csv.length} rows, expected 163`);

/* ===================================== cell parsing ===================================== */

const NUM_FT = /^(\d+(?:\.\d+)?)'$/;
const NUM_PCT = /^(\d+(?:\.\d+)?)%$/;

/** A pack E cell as {value, text}. `value` is set ONLY for a single plain number; everything else is text. */
function cell(raw, kind) {
  const text = raw.trim();
  const re = kind === "pct" ? NUM_PCT : NUM_FT;
  const m = re.exec(text);
  return { value: m ? Number(m[1]) : null, text };
}

/* ===================================== MARBLE FALLS ===================================== */

const MF_CITATION_BASE = "Marble Falls Code of Ordinances, App. B Development Code, Art. 4";

/**
 * Every pack E row the 10 conditional districts use, by pack E row index (0-based data row, the
 * same index apply-packE-to-burnet-register.mjs calls `_row`). `use`:
 *   residential    -- a Table 4.2.2 / 4.2.6.A building-type row.
 *   nonresidential -- the Table 4.3.1.B row ("Nonresidential and Mixed-Use Development").
 * `tier` (DR only): the Table 4.2.6.A "Min. Lot Width" column for that row, as [min, belowFt). A
 * building type with several width rows (Cottage, SFD, ZLL, SFA: 30'/40'/50') gets the half-open
 * band up to the next row; a building type with ONE row gets [min, null) (no upper bound).
 */
const MF_ROWS = {
  FR: [
    { row: 0, label: "Farm and Ranch (Single-Family Detached)", use: "residential" },
    { row: 1, label: "Farm and Ranch Cluster (Single-Family Detached)", use: "residential" },
    { row: 2, label: "Conservation (Single-Family Detached)", use: "residential" },
    { row: 3, label: "Manufactured Home Subdivision", use: "residential" },
    { row: 4, label: "Manufactured Home Park", use: "residential" },
    { row: 5, label: "Tiny House Development", use: "residential" },
    { row: 79, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
  ],
  RE: [
    { row: 6, label: "Estate (Single-Family Detached)", use: "residential" },
    { row: 7, label: "Estate Cluster (Single-Family Detached)", use: "residential" },
    { row: 79, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
  ],
  NR: [
    { row: 8, label: "Suburban (Single-Family Detached)", use: "residential" },
    { row: 9, label: "Neighborhood (Single-Family Detached)", use: "residential" },
    { row: 10, label: "Neighborhood (Rear-Loaded) (Single-Family Detached)", use: "residential" },
    { row: 11, label: "Single-Family Zero Lot Line", use: "residential" },
    { row: 12, label: "Cottage", use: "residential" },
    { row: 13, label: "Manufactured Home Subdivision", use: "residential" },
    { row: 14, label: "Manufactured Home Park", use: "residential" },
    { row: 15, label: "Tiny House Development", use: "residential" },
    { row: 80, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
  ],
  TR: [
    { row: 16, label: "Neighborhood (Single-family Detached)", use: "residential" },
    { row: 17, label: "Neighborhood (Rear-Loaded) (Single-family Detached)", use: "residential" },
    { row: 18, label: "Single-Family Attached", use: "residential" },
    { row: 19, label: "Single-Family Attached (Rear-Loaded)", use: "residential" },
    { row: 20, label: "Single-Family Zero Lot Line", use: "residential" },
    { row: 21, label: "Duplex", use: "residential" },
    { row: 22, label: "Townhouse (Front-Loaded Single-Entry)", use: "residential" },
    { row: 23, label: "Townhouse (Rear-Loaded)", use: "residential" },
    { row: 24, label: "Tiny House Development", use: "residential" },
    { row: 25, label: "Triplex", use: "residential" },
    { row: 26, label: "Quadplex", use: "residential" },
    { row: 27, label: "Apartment", use: "residential" },
    { row: 80, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
  ],
  MR: [
    { row: 28, label: "Manufactured Home Subdivision", use: "residential" },
    { row: 29, label: "Manufactured Home Park", use: "residential" },
    { row: 30, label: "Tiny House Development", use: "residential" },
    { row: 31, label: "Townhouse (Front-Loaded Single-Entry)", use: "residential" },
    { row: 32, label: "Townhouse (Rear-Loaded)", use: "residential" },
    { row: 33, label: "Triplex", use: "residential" },
    { row: 34, label: "Quadplex", use: "residential" },
    { row: 35, label: "Apartment (5-14 units/ac.)", use: "residential" },
    { row: 36, label: "Apartment (15-24 units/ac.)", use: "residential" },
    { row: 80, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
  ],
  DR: [
    { row: 40, label: "Cottage | Min. Lot Width 30'", use: "residential", tier: [30, 40] },
    { row: 41, label: "Cottage | Min. Lot Width 40'", use: "residential", tier: [40, 50] },
    { row: 42, label: "Cottage | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 43, label: "Single-Family Detached | Min. Lot Width 30'", use: "residential", tier: [30, 40] },
    { row: 44, label: "Single-Family Detached | Min. Lot Width 40'", use: "residential", tier: [40, 50] },
    { row: 45, label: "Single-Family Detached | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 46, label: "Single-Family Zero Lot Line | Min. Lot Width 30'", use: "residential", tier: [30, 40] },
    { row: 47, label: "Single-Family Zero Lot Line | Min. Lot Width 40'", use: "residential", tier: [40, 50] },
    { row: 48, label: "Single-Family Zero Lot Line | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 49, label: "Single-Family Attached | Min. Lot Width 30'", use: "residential", tier: [30, 40] },
    { row: 50, label: "Single-Family Attached | Min. Lot Width 40'", use: "residential", tier: [40, 50] },
    { row: 51, label: "Single-Family Attached | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 52, label: "Duplex | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 53, label: "Townhouse | Min. Lot Width 22' /32'", use: "residential", tier: [22, null] },
    { row: 54, label: "Triplex | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 55, label: "Quadplex | Min. Lot Width 50'", use: "residential", tier: [50, null] },
    { row: 56, label: "Apartment | Min. Lot Width 100'", use: "residential", tier: [100, null] },
    { row: 57, label: "Tiny House Development | Min. Lot Width 40'", use: "residential", tier: [40, null] },
    { row: 80, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
  ],
  NC: [{ row: 73, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential", only: true }],
  GC: [{ row: 74, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential", only: true }],
  DN: [
    { row: 75, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
    { row: 39, label: "Townhouse (Rear-Loaded)", use: "residential", district: "DN" },
  ],
  DT: [
    { row: 76, label: "Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", use: "nonresidential" },
    { row: 39, label: "Townhouse (Rear-Loaded)", use: "residential", district: "DT" },
  ],
};

/** The MF pack E rows deliberately NOT used as a standard (pointer rows that only say "see ..."). */
const MF_POINTER_ROWS = { 37: "DR pointer row (Table 4.2.2 sends DR to Table 4.2.6.A)", 38: "DN/DT Apartment / Loft pointer row (Table 4.2.2 note 9 sends apartments and lofts to Sec. 4.3.1 -- i.e. the Table 4.3.1.B row, which is used)" };

/**
 * Table 4.3.1.B note 1 (lake). For the four districts it names, the Table 4.3.1.B side and rear
 * cells print two numbers ("5'/10'"); note 1 is the only footnote on those cells and says what the
 * second number is: the side / rear setback ADJACENT TO LAKE MARBLE FALLS. So the first number is
 * the setback when the parcel is not adjacent to the lake and the second applies only to the side or
 * rear that is adjacent to it. Reviewed per cell; the parse below throws if the printed cell changes.
 */
const MF_LAKE_SPLIT = {
  NC: { side_ft: ["5'/10'", 5], rear_ft: ["15'/10'", 15] },
  GC: { side_ft: ["5'/10'", 5], rear_ft: ["15'/10'", 15] },
  DN: { side_ft: ["0'/10'", 0], rear_ft: ["0'/10'", 0] },
  DT: { side_ft: ["0'/10'", 0], rear_ft: ["10'", 10] },
};

/** The verbatim lake sentence (Table 4.3.1.B note 1), taken from pack E's own footnote cell. */
function lakeNoteVerbatim() {
  const r = csv[73];
  const m = /side: note 1 = (.*?) \| rear: note 1/.exec(r.footnotes_verbatim);
  if (!m) throw new Error("Table 4.3.1.B note 1 not found on the NC row");
  return m[1];
}

/** Townhouse row #39 (DN; DT): its front cell 0'/10' is note 14's build-to line, read per district. */
const MF_TOWNHOUSE_FRONT = {
  DN: { value: 0, text: "0'/10' -- note 14: \"Townhouses in the Downtown (DN) District are required to be built-to the front property line\" (a build-to line at 0 ft)" },
  DT: { value: null, text: "0'/10' -- note 14: \"townhouses in the Downtown Transition (DT) District are required to be built within ten (10) feet of the front property line\" (a build-to line, not a minimum setback)" },
};

function mfStandard(code, spec, lakeNote) {
  const r = csv[spec.row];
  if (r.city !== "Marble Falls") throw new Error(`MF ${code} row ${spec.row} is ${r.city}`);
  const label = r.building_type_row.trim();
  if (label !== spec.label) throw new Error(`MF ${code} row ${spec.row}: label changed: ${JSON.stringify(label)} != ${JSON.stringify(spec.label)}`);
  const codes = r.district_code.split(/[;,]\s*/).map((c) => c.trim());
  if (!codes.includes(code)) throw new Error(`MF ${code} row ${spec.row}: pack E names ${r.district_code}`);
  const f = {
    front: cell(r.front_ft),
    side: cell(r.side_ft),
    rear: cell(r.rear_ft),
    street_side: cell(r.corner_or_street_side_ft),
    max_height: cell(r.max_height),
    max_lot_coverage: cell(r.max_lot_coverage, "pct"),
  };
  const notes = [];
  if (spec.district && code === "DN" || spec.district && code === "DT") {
    if (f.front.text !== "0'/10'") throw new Error(`MF ${code} townhouse front changed: ${f.front.text}`);
    f.front = { ...MF_TOWNHOUSE_FRONT[code] };
  }
  const split = MF_LAKE_SPLIT[code];
  let lake = null;
  if (split && spec.use === "nonresidential") {
    for (const [field, [printed, base]] of Object.entries(split)) {
      const key = field === "side_ft" ? "side" : "rear";
      if (f[key].text !== printed) throw new Error(`MF ${code} ${field}: expected ${printed}, pack E prints ${f[key].text}`);
      f[key] = { value: base, text: `${printed} -- ${base}' where not adjacent to Lake Marble Falls (Table 4.3.1.B note 1)` };
    }
    lake = {
      rule: "Table 4.3.1.B note 1",
      verbatim: lakeNote,
      adjacent: {
        side: { value: null, text: `the side adjacent to Lake Marble Falls: 10 feet (or the edge of the boardwalk) per note 1; any other side: ${split.side_ft[1]}'` },
        rear: { value: null, text: `a rear adjacent to Lake Marble Falls: 10 feet (or the edge of the boardwalk) per note 1; otherwise: ${split.rear_ft[1]}'` },
      },
    };
    if (code === "DN" || code === "DT") {
      lake.adjacent.notes = ["Sec. 4.3.4.B.3.c (verbatim, pack E): \"The front build-to requirement shall not be applicable to properties directly adjacent to Lake Marble Falls.\""];
    }
  }
  if (code === "DN" && spec.use === "nonresidential") {
    if (f.front.text !== "0'") throw new Error("DN front changed");
    f.front = { value: 0, text: "0' -- note 5: \"Buildings in the DN district are required to be built to front and side property lines abutting a street, except as provided in Subsection 4.3.4.B\" (a build-to line at the property line)" };
  }
  if (code === "DT" && spec.use === "nonresidential") {
    if (f.front.text !== "0'") throw new Error("DT front changed");
    f.front = { value: 0, text: "0' -- note 6: \"Buildings in the DT district are required to be built within 10 feet of the front property line, except as provided in Subsection 4.3.4.B ... The setback line may be averaged along the entire block.\" (0 ft minimum; build-to within 10 ft)" };
  }
  if (r.footnotes_verbatim && r.footnotes_verbatim !== "NONE") notes.push(`Footnotes (pack E, verbatim): ${r.footnotes_verbatim}`);
  const minWidth = /min_lot_width: ([^;]+);/.exec(r.notes)?.[1]?.trim() ?? null;
  return {
    id: `MF-${code}-${spec.row}`,
    pack_e_row: spec.row,
    label: spec.label,
    use: spec.use,
    lot_width_tier_ft: spec.tier ?? null,
    min_lot_width_printed: minWidth,
    citation: `${MF_CITATION_BASE}, ${r.section_citation.replace(/^App\. B Development Code, Art\. 4, /, "")}`,
    page_url: r.page_url,
    fields: f,
    lake,
    notes,
  };
}

function buildMarbleFalls() {
  const lakeNote = lakeNoteVerbatim();
  const used = new Set(Object.keys(MF_POINTER_ROWS).map(Number));
  const districts = {};
  for (const [code, specs] of Object.entries(MF_ROWS)) {
    districts[code] = {
      district_code: code,
      rows: specs.map((s) => {
        used.add(s.row);
        return mfStandard(code, s, lakeNote);
      }),
    };
  }
  // Every MF pack E row is either one of the 10 districts' rows above, a pointer row, or one of the
  // 7 districts the district-level table already serves (ENZ.1-5, BP, IN: rows 58-72, 77, 78).
  const servedElsewhere = new Set([...Array.from({ length: 15 }, (_, i) => 58 + i), 77, 78]);
  for (const r of csv.filter((r) => r.city === "Marble Falls")) {
    if (!used.has(r._row) && !servedElsewhere.has(r._row)) {
      throw new Error(`MF pack E row ${r._row} (${r.district_code} / ${r.building_type_row}) is not accounted for`);
    }
  }
  return { lake_note_verbatim: lakeNote, pointer_rows: MF_POINTER_ROWS, districts };
}

/* ===================================== HORSESHOE BAY ===================================== */

/**
 * SUBDIVISION -> zone, REVIEWED. The 14 name matches are the ordinance's own zone names (the
 * layer's coded-domain values are those names); SOUTH is pack E's own "Zone 4B Horseshoe Bay South".
 * PROPER is INFERRED, with its basis spelled out; WEST is deliberately UNMAPPED. Anything not listed
 * (and a blank value) resolves to no zone.
 */
const HSB_SUBDIVISIONS = [
  ...ZONE_FILE.subdivision_to_zone
    .filter((s) => !["PROPER", "WEST", "SOUTH"].includes(s.subdivision))
    .map((s) => ({ subdivision: s.subdivision, zone: s.zones[0], status: "name-match", section: s.section, basis: s.basis })),
  {
    subdivision: "SOUTH",
    zone: "4B",
    status: "name-match",
    section: "§ 14.02.406",
    basis: "Pack E's own row label: 'Zone 4B Horseshoe Bay South' (§ 14.02.406, M-1 row). Every Burnet SOUTH feature's legal description is a HORSESHOE BAY SOUTH (S5221) or HORSESHOE BAY (S5220) plat or an acreage abstract.",
  },
  {
    subdivision: "PROPER",
    zone: "3/4A",
    status: "inferred",
    section: "§ 14.02.406",
    basis:
      "INFERRED, NOT A NAME MATCH. § 14.02.406 is the section for 'Zones 3, 4A & 4B (Horseshoe Bay)'. The layer's 17-value SUBDIVISION domain gives 14 values that are the ordinance's names for Zones 1, 2, 5-13, 15, 17 and 18, plus three Horseshoe Bay values: SOUTH (= Zone 4B, the ordinance's own 'Horseshoe Bay South'), WEST and PROPER. Every Burnet PROPER feature (517, read 2026-10-13) is on a HORSESHOE BAY (S5220) or HORSESHOE BAY NORTH (S5222) plat, JONATHAN COVE (S5226), SPRING-FED LAKESIDE TOWNHOMES (S7953) or an acreage abstract (A0248). PROPER is therefore read as Zone 3 and/or Zone 4A -- which of the two is not stated in pack E, so a PROPER parcel is served ONLY for a code whose § 14.02.406 text is the same entry for both ('Zones 3 and 4A' / 'Zones 3 and 4'). Pack F task 2 asks for the ordinance's own subdivision list per zone, which confirms or overturns this.",
  },
];
const HSB_UNMAPPED = [
  {
    subdivision: "WEST",
    basis:
      "Not mapped. The only place pack E names 'Horseshoe Bay West' is Zone 13 (Caprock)'s moratorium tract ('Tract BBB-2A of Horseshoe Bay West Plat No. W15.67', § 14.02.416), so WEST is not one zone; its 4 Burnet features (R-1 x2, A-1 x2) are acreage abstracts with no plat name. Declines SETBACK_ZONE_UNMAPPED until pack F task 2.",
  },
];

/** A zone-file standards entry, by its pack E row index, as fields {value, text}. */
function hsbEntry(packERow) {
  const e = ZONE_FILE.standards.find((s) => s.pack_e_row === packERow);
  if (!e) throw new Error(`zone file has no pack E row ${packERow}`);
  const fv = (k) => ({ value: e.fields[k].value, text: e.fields[k].verbatim });
  return {
    entry: e,
    fields: {
      front: fv("front_ft"),
      side: fv("side_ft"),
      rear: fv("rear_ft"),
      street_side: fv("corner_or_street_side_ft"),
      max_height: fv("max_height"),
      max_lot_coverage: fv("max_lot_coverage"),
    },
  };
}

/**
 * Cells given a number that the zone file left as text, each reviewed. Only pure arithmetic on the
 * printed words; nothing interpretive.
 */
const HSB_FIELD_REVIEWS = {
  "89:side": {
    value: 15,
    review:
      "'total side yards of not less than thirty (30) feet with not less than fifteen (15) feet on any one (1) side': every side is at least 15 ft, and 15 + 15 = 30 meets the total, so the per-side minimum is 15 ft on each side.",
  },
  "104:max_height": {
    value: 32,
    review:
      "'thirty-two (32) feet above the highest natural contour of the applicable lot; provided that in the case of a multiple dwelling complex containing more than twenty (20) dwelling units, a maximum of three (3) stories is allowed': 32 ft is the height; the more-than-20-unit proviso is carried as a note.",
  },
};

/** Lake LBJ waterfront rules, verbatim (pack E notes). */
const HSB_WATERFRONT_REAR_U =
  "§ 14.02.402(b)(15)(U) (verbatim, pack E): 'Rear setbacks for waterfront lots are zero (0) feet, where no setbacks are shown on the plats for those lots.'";
const HSB_ZONE7_SHORELINE =
  "§ 14.02.409 (verbatim, pack E): 'Structures on any shoreline lots may be located at the shoreline of Lake Lyndon B. Johnson, provided they are constructed a minimum of one foot (1') above the floodplain elevation for such lot, as shown on the FEMA federal insurance rate map (FIRM).'";

function applyReviews(packERow, fields) {
  const out = { ...fields };
  for (const [k, rv] of Object.entries(HSB_FIELD_REVIEWS)) {
    const [row, field] = k.split(":");
    if (Number(row) !== packERow) continue;
    if (out[field].value !== null) throw new Error(`review ${k}: the zone file already has a number`);
    out[field] = { value: rv.value, text: `${out[field].text} [reviewed: ${rv.review}]` };
  }
  return out;
}

/**
 * One entry per (ZONING, SUBDIVISION) combination carried by a Burnet (county='GBU') feature on the
 * Horseshoe Bay layer (read 2026-10-13), plus nothing else. `kind`:
 *   standard -- one standard set (pack E row `row`), with optional modifiers the resolver evaluates:
 *       waterfront_rear  : rear is 0 ft for a waterfront lot (§ 14.02.402(b)(15)(U)); Lake LBJ adjacency
 *       shoreline_height : the height for a lot contiguous with the shoreline (Lake LBJ adjacency)
 *       street_side_lot  : a field whose value depends on the street the lot is on (situs street)
 *       plat_clause      : the yard paragraph opens with the approved-plat override sentence
 *   alternatives -- several standard sets the parcel's own data cannot choose between.
 *   pending -- the text is not in pack E (pack F asks for it). Declines SETBACK_SOURCE_PENDING.
 */
const HSB_COMBOS = [
  {
    zoning: "R-1", subdivision: "PENINSULA", zone: "7", kind: "standard", row: 89,
    waterfront_rear: { value: 0, text: `${HSB_WATERFRONT_REAR_U} ${HSB_ZONE7_SHORELINE}` },
    plat_clause: "'Except as specified to the contrary on an approved plat, which specification will control, the following will apply' (§ 14.02.409)",
  },
  {
    zoning: "R-1", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 98,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    shoreline_height: { not_adjacent: 32, adjacent: 35 },
    street_side_lot: {
      field: "side",
      street: "LIGHTHOUSE",
      on_street: { value: 5, text: "'lots located on Lighthouse Drive shall provide total side yards with not less than five (5) feet on each side' -> 5 ft on each side (situs on Lighthouse Drive)" },
      otherwise: { value: null, text: "'total side yards of not less than fifteen (15) feet with not less than five (5) feet on one (1) side, except that lots located on Lighthouse Drive shall provide total side yards with not less than five (5) feet on each side' (a total across both sides, not one per-side number; the situs is not on Lighthouse Drive)" },
    },
    plat_clause: "'Except as specified to the contrary on an approved plat, which specification shall control, the following shall apply' (§ 14.02.406)",
  },
  {
    zoning: "GH", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 99,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: null,
  },
  {
    zoning: "R-2", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 100,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: "'Except as specified to the contrary on an approved plat, which specifications shall control, the following shall apply' (§ 14.02.406)",
  },
  {
    zoning: "R-4", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 101, same_as_rows: [102],
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: "'Except where there is specifically called out on an approved plat, which specification shall control, the following shall apply' (§ 14.02.406)",
  },
  {
    zoning: "R-6", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 104,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: "R-6 is 'Same as in the R-4 area except that front setback lines shall be twenty (20) feet and rear setback lines shall be fifteen (15) feet', and the R-4 yard paragraph opens 'Except where there is specifically called out on an approved plat, which specification shall control' (§ 14.02.406)",
    extra_notes: ["Height proviso (verbatim): 'in the case of a multiple dwelling complex containing more than twenty (20) dwelling units, a maximum of three (3) stories is allowed.'"],
  },
  {
    zoning: "C-2", subdivision: "PROPER", zone: "3/4A", kind: "alternatives",
    alternatives: [
      { condition: "any C-2 lot in Zones 3/4A that is not one of the § 14.02.417 PD-authorized tracts below: § 14.02.406 states no setbacks for C-2", row: 106 },
      { condition: "Tract J-7 of Horseshoe Bay Plat No. 28.49 (§ 14.02.417 PD authorization)", row: 131 },
      { condition: "Lot 28043-C of Horseshoe Bay Plat No. 28.52 (§ 14.02.417 PD authorization)", row: 132 },
      { condition: "6.10 acres of Tract AAA-2A, Horseshoe Bay Plat No. 64.3, Members Club Complex (§ 14.02.417 PD authorization)", row: 133 },
    ],
    note: "Which of these applies is the lot's identity against the § 14.02.417 editor's-note tracts; it is not evaluated from data.",
  },
  {
    zoning: "A-1", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 107,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: null,
  },
  {
    zoning: "GUI", subdivision: "PROPER", zone: "3/4A", kind: "standard", row: 109,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: null,
  },
  {
    zoning: "A-1", subdivision: "SUMMIT ROCK", zone: "12", kind: "standard", row: 155,
    waterfront_rear: { value: 0, text: HSB_WATERFRONT_REAR_U },
    plat_clause: null,
  },
  {
    zoning: "R-1", subdivision: "SOUTH", zone: "4B", kind: "pending",
    pending:
      "No R-1 yard text for Zone 4B (Horseshoe Bay South) in pack E: § 14.02.406's R-1 yards are headed 'Zones 3 and 4A'; for Zone 4B pack E records only a floor-area/masonry sentence. Pack F task 3 asks for South R-1.",
  },
  {
    zoning: "MH-1", subdivision: "SOUTH", zone: "4B", kind: "pending",
    pending:
      "MH-1 is not named anywhere in pack E. Pack E's Zone 4B 'M-1 Manufactured Home' text is not mapped to MH-1 (the layer carries a separate M-1 code; no fuzzy match). Pack F task 3 asks for MH-1.",
  },
  {
    zoning: "A-1", subdivision: "SOUTH", zone: "4B", kind: "pending",
    pending:
      "§ 14.02.406's A-1 text covers 'all land within Zones 3 and 4 classified as A-1'; whether 'Zone 4' includes Zone 4B is not stated (the same section names 4A and 4B separately elsewhere, e.g. GUI 'Zones 3, 4A and 4B'). Pack F task 2 (zone definitions) settles it.",
  },
];

function buildHorseshoeBay() {
  const combos = HSB_COMBOS.map((c) => {
    const base = { zoning: c.zoning, subdivision: c.subdivision, zone: c.zone, kind: c.kind };
    if (c.kind === "pending") return { ...base, pending: c.pending };
    if (c.kind === "alternatives") {
      return {
        ...base,
        note: c.note,
        alternatives: c.alternatives.map((a) => {
          const { entry, fields } = hsbEntry(a.row);
          return { condition: a.condition, pack_e_row: a.row, citation: `Horseshoe Bay Code of Ordinances, ${entry.section}`, page_url: entry.page_url, fields, notes: entry.notes ? [entry.notes] : [] };
        }),
      };
    }
    const { entry, fields } = hsbEntry(c.row);
    if (entry.layer_zoning !== c.zoning) throw new Error(`combo ${c.zoning}/${c.subdivision}: row ${c.row} is ${entry.layer_zoning}`);
    for (const other of c.same_as_rows ?? []) {
      const o = hsbEntry(other).fields;
      for (const k of Object.keys(fields)) {
        if (o[k].value !== fields[k].value) throw new Error(`combo ${c.zoning}/${c.subdivision}: rows ${c.row} and ${other} differ on ${k}`);
      }
    }
    const reviewed = applyReviews(c.row, fields);
    const notes = [];
    if (entry.notes) notes.push(entry.notes);
    if (entry.footnotes_verbatim && entry.footnotes_verbatim !== "NONE") notes.push(`Footnote (verbatim): ${entry.footnotes_verbatim}`);
    for (const n of c.extra_notes ?? []) notes.push(n);
    if (c.same_as_rows) notes.push(`Pack E row(s) ${c.same_as_rows.join(", ")} (the 25 listed Zone 3 R-4 lots) state the same setbacks, height and coverage; only the minimum dwelling size differs.`);
    return {
      ...base,
      pack_e_row: c.row,
      citation: `Horseshoe Bay Code of Ordinances, ${entry.section}`,
      page_url: entry.page_url,
      zone_scope: entry.zone_scope,
      fields: reviewed,
      waterfront_rear: c.waterfront_rear ?? null,
      shoreline_height: c.shoreline_height ?? null,
      street_side_lot: c.street_side_lot ?? null,
      plat_clause: c.plat_clause ?? null,
      notes,
    };
  });
  return { subdivisions: HSB_SUBDIVISIONS, unmapped_subdivisions: HSB_UNMAPPED, combos };
}

/* ======================================== write ======================================== */

const out = {
  generated_by: "lib/adapters/scripts/build-burnet-parcel-standards.mjs",
  source:
    "doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_browser_packE.csv (pack E; Marble Falls from library.municode.com, Horseshoe Bay from ecode360.com Ch. 14 Art. 14.02) via horseshoe-bay-tx-zone-standards.json for Horseshoe Bay.",
  status:
    "Per-PARCEL standards read by burnet-parcel-setbacks.ts. Not a SETBACK_TABLES entry: a district-code-only caller still gets the register's named refusal for these districts.",
  marble_falls: buildMarbleFalls(),
  horseshoe_bay: buildHorseshoeBay(),
};
writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
const mf = out.marble_falls.districts;
console.log(`MF: ${Object.entries(mf).map(([k, v]) => `${k}=${v.rows.length}`).join(" ")}`);
console.log(`HSB: ${out.horseshoe_bay.combos.map((c) => `${c.zoning}/${c.subdivision}:${c.kind}`).join(" ")}`);
