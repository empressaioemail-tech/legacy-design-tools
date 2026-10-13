#!/usr/bin/env node
/**
 * One-off (but rerunnable) driver for pack E (2026-10-13): Marble Falls and Horseshoe Bay
 * ordinance text, read by the operator's browser agent from the cities' official code hosts
 * (Marble Falls: library.municode.com, every table value checked by script against the live
 * Municode tables; Horseshoe Bay: ecode360.com Ch. 14 Art. 14.02, every value cell string-matched
 * against the live text). Source file:
 *   doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_browser_packE.csv  (163 rows, 81 MF / 82 HSB)
 *
 * Usage: node apply-packE-to-burnet-register.mjs <path-to-packE.csv>
 *
 * WRITES
 *   ../src/local/setbacks/burnet-tx-ordinance-register.json  -- replaces the Marble Falls rows and
 *       the Horseshoe Bay rows pack E covers; every other row is kept byte-for-byte.
 *   ../src/local/setbacks/marble-falls-tx.json               -- the served Marble Falls table.
 *   ../src/local/setbacks/horseshoe-bay-tx-zone-standards.json -- Horseshoe Bay's standards keyed by
 *       (district code, geographic zone). NOT a SETBACK_TABLES entry and NOT served: see that file's
 *       own `status` and the README section "Horseshoe Bay is keyed by geographic zone".
 *
 * Nothing here guesses. Every Marble Falls serve/refuse decision and every Horseshoe Bay code
 * mapping is an explicit, reviewed table below; a pack-E row this script does not expect throws.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./convert-ordinance-register-csv.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETBACKS = join(HERE, "../src/local/setbacks");
const REGISTER_PATH = join(SETBACKS, "burnet-tx-ordinance-register.json");
const MF_TABLE_PATH = join(SETBACKS, "marble-falls-tx.json");
const HSB_ZONES_PATH = join(SETBACKS, "horseshoe-bay-tx-zone-standards.json");

const CSV_PATH = process.argv[2];
if (!CSV_PATH) throw new Error("usage: apply-packE-to-burnet-register.mjs <packE.csv>");

const csv = parseCsv(readFileSync(CSV_PATH, "utf8"));
const indexed = csv.map((r, i) => ({ ...r, _row: i }));
const mfRows = indexed.filter((r) => r.city === "Marble Falls");
const hsbRows = indexed.filter((r) => r.city === "Horseshoe Bay");
if (csv.length !== 163 || mfRows.length !== 81 || hsbRows.length !== 82) {
  throw new Error(`pack E shape changed: ${csv.length} rows (${mfRows.length} MF / ${hsbRows.length} HSB); expected 163 (81/82)`);
}

const MF = "Marble Falls";
const HSB = "Horseshoe Bay";
const DIM = ["front_ft", "side_ft", "rear_ft", "corner_or_street_side_ft"];
const REG_FIELD = { front_ft: "front_ft", side_ft: "side_ft", rear_ft: "rear_ft", corner_or_street_side_ft: "corner_ft" };
const FIELD_LABEL = {
  front_ft: "front setback",
  side_ft: "side setback",
  rear_ft: "rear setback",
  corner_or_street_side_ft: "corner / street-side setback",
  max_height: "maximum height",
  max_lot_coverage: "maximum lot coverage",
  max_impervious_cover: "maximum impervious cover",
};

/* ================================== MARBLE FALLS ================================== */

// The adopting and amending ordinances, from the browser agent's notes (operator brief, 2026-10-13)
// and each row's own section history note.
const MF_ORDINANCE_HISTORY =
  "Adopting ordinance: Ord. No. 2018-O-10A (adopted 2018-10-23). Amendments: 2019-O-05A, 2020-O-03D, 2021-O-07B, " +
  "2022-O-06A and 2025-O-08C (2025-08-05, amends Sec. 4.2.2). Sec. 4.3.4 is unchanged since 2018-O-10A.";
const MF_EDITION = { ordinance: "Ord. No. 2026-O-04A", effective_date: "2026-04-07" };

/** One pack-E row per district: "DN; DT", "FR, RE", "NR, TR, DR, MR" each name several districts. */
function expandCodes(code) {
  return code.split(/[;,]\s*/).map((c) => c.trim()).filter(Boolean);
}

const MF_STAMPED = ["ENZ.1", "ENZ.2", "ENZ.3", "ENZ.4", "ENZ.5", "NR", "GC", "DR", "NC", "DN", "TR", "DT", "RE", "BP", "FR", "MR", "IN"];

/**
 * THE BUILDING-TYPE RULE (per district). Marble Falls' tables give one row per BUILDING TYPE, not
 * one per district, and pack E records that none of them marks a row as the district's primary row.
 * The serving path resolves by district only. Rule: serve a district only when its governing table
 * gives it exactly ONE Single-Family Detached row (or only one row at all); quote every other row.
 * Otherwise refuse SETBACK_CONDITIONAL_NOT_EVALUATED, because which row governs depends on the
 * building type built, which this pipeline does not know.
 */
const MF_SERVED = {
  "ENZ.1": { pick: (r) => r.section_citation.includes("4.2.7.A"), rule: "Table 4.2.7.A gives ENZ.1 a single row (building type \"N/A\"); served." },
  "ENZ.2": { pick: (r) => r.section_citation.includes("4.2.7.A"), rule: "Table 4.2.7.A gives ENZ.2 a single row (\"Single-Family Detached, Single-Family Zero Lot Line, Single-Family Attached, Duplex\"); served." },
  "ENZ.3": { pick: (r) => r.building_type_row.startsWith("Single-Family Detached"), rule: "Table 4.2.7.A gives ENZ.3 five building-type rows, exactly one of which is the Single-Family Detached row (shared with Zero Lot Line, Attached and Duplex); that row is served and the Townhouse, Tri-plex, Quadplex and Tiny House rows are quoted." },
  "ENZ.4": { pick: (r) => r.building_type_row.startsWith("Single-Family Detached"), rule: "Table 4.2.7.A gives ENZ.4 six building-type rows, exactly one of which is the Single-Family Detached row (shared with Zero Lot Line, Attached and Duplex); that row is served and the Townhouse, Tri-plex, Quadplex, Apartment and Tiny House rows are quoted." },
  "ENZ.5": { pick: (r) => r.building_type_row.startsWith("Manufactured Home, Single-Family Detached"), rule: "Table 4.2.7.A gives ENZ.5 two rows, exactly one of which includes Single-Family Detached (shared with Manufactured Home, Attached and Duplex); that row is served and the Tiny House row (identical setbacks) is quoted." },
  BP: { pick: (r) => r.section_citation.includes("4.3.1.B"), rule: "Table 4.3.1.B gives BP a single row; served." },
  IN: { pick: (r) => r.section_citation.includes("4.3.1.B"), rule: "Table 4.3.1.B gives IN a single row; served." },
};

const MF_REFUSED_REASON = {
  FR:
    "Table 4.2.2 gives FR one row per building type -- Farm and Ranch, Farm and Ranch Cluster and Conservation (all three Single-Family Detached), Manufactured Home Subdivision, Manufactured Home Park and Tiny House Development -- and Table 4.3.1.B adds a nonresidential row. The table marks no row as the district's primary row and three different Single-Family Detached rows exist, so which numbers govern depends on the building type / development option, which this pipeline does not know.",
  RE:
    "Table 4.2.2 gives RE two Single-Family Detached rows (Estate; Estate Cluster) with different numbers, and Table 4.3.1.B adds a nonresidential row. No row is marked primary, so which numbers govern depends on the building type / development option, which this pipeline does not know.",
  NR:
    "Table 4.2.2 gives NR eight building-type rows, three of them Single-Family Detached with different numbers (Suburban; Neighborhood; Neighborhood (Rear-Loaded)), and Table 4.3.1.B adds a nonresidential row. No row is marked primary, so which numbers govern depends on the building type, which this pipeline does not know.",
  TR:
    "Table 4.2.2 gives TR twelve building-type rows, two of them Single-Family Detached with different numbers (Neighborhood; Neighborhood (Rear-Loaded)), and Table 4.3.1.B adds a nonresidential row. No row is marked primary, so which numbers govern depends on the building type, which this pipeline does not know.",
  MR:
    "Table 4.2.2 gives MR nine building-type rows (manufactured home, tiny house, townhouse, triplex, quadplex and two apartment-density rows) and no Single-Family Detached row at all, and Table 4.3.1.B adds a nonresidential row. No row is marked primary, so which numbers govern depends on the building type, which this pipeline does not know.",
  DR:
    "Table 4.2.2 defers DR to Sec. 4.2.6 / Table 4.2.6.A, which keys every building type to a minimum lot width tier (30', 40', 50'). The three Single-Family Detached tiers differ (street side 7.5' / 7.5' / 10'), lot width is not known per parcel, and Table 4.3.1.B adds a nonresidential row, so which numbers govern cannot be decided here.",
  NC:
    "Table 4.3.1.B gives NC side 5'/10' and rear 15'/10': per note 1, side and rear setbacks adjacent to Lake Marble Falls change to 10 feet (or the edge of the boardwalk). Lake adjacency is not evaluated per parcel.",
  GC:
    "Table 4.3.1.B gives GC side 5'/10' and rear 15'/10': per note 1, side and rear setbacks adjacent to Lake Marble Falls change to 10 feet (or the edge of the boardwalk). Lake adjacency is not evaluated per parcel.",
  DN:
    "DN's front is a build-to line, not a setback (Table 4.3.1.B note 5 / Sec. 4.3.4.B: built to the front and side property lines abutting a street); side and rear are 0'/10' depending on adjacency to Lake Marble Falls (note 1); and Table 4.2.2 adds a townhouse row with its own numbers. No single setback set exists.",
  DT:
    "DT's front is a build-to line (Table 4.3.1.B note 6: built within 10 feet of the front property line, averaged along the block; Sec. 4.3.4.B), side is 0'/10' depending on adjacency to Lake Marble Falls (note 1), and Table 4.2.2 adds a townhouse row with its own numbers. No single setback set exists.",
};

function feet(cell, where) {
  const m = /^(\d+(?:\.\d+)?)'$/.exec(cell.trim());
  if (!m) throw new Error(`${where}: expected a plain feet value like 25', got ${JSON.stringify(cell)}`);
  return Number(m[1]);
}
function pct(cell, where) {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(cell.trim());
  if (!m) throw new Error(`${where}: expected a plain percent like 50%, got ${JSON.stringify(cell)}`);
  return Number(m[1]);
}

/** Footnote entries in pack E's footnotes_verbatim for one field ("side: note 7 = ..."). */
function footnotesFor(row, prefix) {
  if (!row.footnotes_verbatim || row.footnotes_verbatim === "NONE") return [];
  return row.footnotes_verbatim
    .split(" | ")
    .filter((f) => f.startsWith(`${prefix}:`) || f.startsWith("building_type:") || f.startsWith("row:"));
}

const mfByDistrict = new Map();
for (const r of mfRows) {
  for (const code of expandCodes(r.district_code)) {
    if (!mfByDistrict.has(code)) mfByDistrict.set(code, []);
    mfByDistrict.get(code).push(r);
  }
}
for (const code of MF_STAMPED) {
  if (!mfByDistrict.has(code)) throw new Error(`pack E has no Marble Falls row for stamped code ${code}`);
  if (!MF_SERVED[code] && !MF_REFUSED_REASON[code]) throw new Error(`no serve/refuse decision for Marble Falls ${code}`);
}
for (const code of mfByDistrict.keys()) {
  if (!MF_STAMPED.includes(code)) throw new Error(`pack E Marble Falls code ${code} is not in the stamped vocabulary`);
}

function rowLabel(r) {
  return `${r.section_citation.replace("App. B Development Code, Art. 4, ", "")} "${r.building_type_row}"`;
}
function rowSummary(r) {
  return `${rowLabel(r)}: front ${r.front_ft}, side ${r.side_ft}, rear ${r.rear_ft}, street side ${r.corner_or_street_side_ft}, height ${r.max_height}, lot coverage ${r.max_lot_coverage}`;
}

const mfRegister = [];
const mfTableDistricts = [];
const mfSample = {};
for (const code of MF_STAMPED) {
  const rows = mfByDistrict.get(code);
  const first = rows.find((r) => !r.district_code.includes(",") && !r.district_code.includes(";")) ?? rows[0];
  const districtName = first.district_name;
  const base = {
    city: MF,
    district_code: code,
    district_name: districtName,
    ordinance: MF_EDITION.ordinance,
    effective_date: MF_EDITION.effective_date,
    edition_line_verbatim: first.edition_line_verbatim,
    source_url: first.page_url,
    access_date: first.access_date,
  };
  const history = [...new Set(rows.map((r) => r.adopting_or_amending_ordinance))].join(" || ");

  if (MF_SERVED[code]) {
    const picked = rows.filter(MF_SERVED[code].pick);
    if (picked.length !== 1) throw new Error(`Marble Falls ${code}: building-type rule picked ${picked.length} rows, expected exactly 1`);
    const r = picked[0];
    const others = rows.filter((x) => x !== r);
    const w = `Marble Falls ${code}`;
    const vals = {
      front_ft: feet(r.front_ft, w),
      side_ft: feet(r.side_ft, w),
      rear_ft: feet(r.rear_ft, w),
      side_corner_ft: feet(r.corner_or_street_side_ft, w),
      max_height_ft: feet(r.max_height, w),
      max_lot_coverage_pct: pct(r.max_lot_coverage, w),
    };
    if (r.max_impervious_cover !== "NOT SPECIFIED") throw new Error(`${w}: impervious cover unexpectedly stated`);
    mfRegister.push({
      ...base,
      front_ft: String(vals.front_ft),
      side_ft: String(vals.side_ft),
      rear_ft: String(vals.rear_ft),
      corner_ft: String(vals.side_corner_ft),
      citation: `${r.section_citation} (row "${r.building_type_row}")`,
      verification: "verified-browser-read",
      notes:
        `BUILDING-TYPE RULE: ${MF_SERVED[code].rule}` +
        (others.length ? ` Other rows (quoted, not served): ${others.map(rowSummary).join(" || ")}.` : "") +
        ` Height ${r.max_height}; lot coverage ${r.max_lot_coverage}; impervious cover NOT SPECIFIED (no Marble Falls table states one).` +
        (r.footnotes_verbatim !== "NONE" ? ` Footnotes on the served row (verbatim): ${r.footnotes_verbatim}.` : "") +
        ` Pack E notes: ${r.notes}` +
        ` | ${MF_ORDINANCE_HISTORY} | Ordinance history: ${history}`,
    });

    const section = r.section_citation;
    const sel = `district "${code}", building-type row "${r.building_type_row}"`;
    const q = (fieldKey, cell, prefix) => {
      const fns = prefix ? footnotesFor(r, prefix) : [];
      return `${section} -- ${FIELD_LABEL[fieldKey]} (${sel}): "${cell}".` + (fns.length ? ` Footnotes on this row (verbatim): ${fns.join(" | ")}` : "");
    };
    const prov = (quote, confidence = 0.9, extra = {}) => ({
      section_number: section,
      confidence,
      verification_state: "primary-source-verified",
      ...extra,
      quote,
    });
    const tableNotes = r.notes.includes("Table 4.2.7.B") ? ` ${r.notes.slice(r.notes.indexOf("Table 4.2.7.B"))}` : "";
    mfTableDistricts.push({
      // Code-first: districtMapping.ts's districtCode() reads the first whitespace token.
      district_name: code.startsWith("ENZ.")
        ? `${code} Existing Neighborhood Zone ${code.slice(4)} (${code})`
        : `${code} ${districtName.replace(` (${code}) District`, " District")} (${code})`,
      citation_url: r.page_url,
      provenance: {
        front_ft: prov(q("front_ft", r.front_ft, "front") + tableNotes),
        rear_ft: prov(q("rear_ft", r.rear_ft, "rear")),
        side_ft: prov(q("side_ft", r.side_ft, "side")),
        side_corner_ft: prov(q("corner_or_street_side_ft", r.corner_or_street_side_ft, "street_side"), 0.85),
        max_height_ft: prov(q("max_height", r.max_height, "height")),
        max_lot_coverage_pct: prov(q("max_lot_coverage", r.max_lot_coverage, "coverage"), 0.85),
        max_impervious_pct: prov(
          `${section} -- ${FIELD_LABEL.max_impervious_cover} (${sel}): "NOT SPECIFIED". ${r.notes.match(/Table [0-9.A-Z]+ has no impervious-cover column\./)?.[0] ?? ""} No Marble Falls table read for pack E states an impervious-cover figure; silence is not read as zero.`,
          0.85,
          { not_specified: true },
        ),
      },
      ...vals,
      max_impervious_pct: 100,
    });
    mfSample[code] = { served: true, row: r.building_type_row, vals };
  } else {
    // Refused: record each dimensional field's value across every row of the district. A field whose
    // value is the same single number on every row keeps it (for provenance); any other field goes
    // into `conditional`, every row's raw cell quoted with its building-type label.
    const numericRows = rows.filter((r) => r.front_ft !== "NOT SHOWN");
    const conditional = {};
    const reg = {};
    for (const f of DIM) {
      const distinct = [...new Set(numericRows.map((r) => r[f]))];
      const clean = distinct.length === 1 && /^(\d+(?:\.\d+)?)'$/.test(distinct[0]);
      if (clean) {
        reg[REG_FIELD[f]] = distinct[0].replace("'", "");
      } else {
        reg[REG_FIELD[f]] = "";
        const prefix = { front_ft: "front", side_ft: "side", rear_ft: "rear", corner_or_street_side_ft: "street_side" }[f];
        const fnText = [
          ...new Set(
            numericRows.flatMap((r) =>
              (r.footnotes_verbatim === "NONE" ? [] : r.footnotes_verbatim.split(" | ")).filter((x) => x.startsWith(`${prefix}:`)),
            ),
          ),
        ];
        conditional[REG_FIELD[f]] =
          numericRows.map((r) => `${rowLabel(r)}: ${r[f]}`).join(" | ") + (fnText.length ? ` || footnotes (verbatim): ${fnText.join(" | ")}` : "");
      }
    }
    if (Object.keys(conditional).length === 0) throw new Error(`Marble Falls ${code} refused but no field varies`);
    const pointers = rows.filter((r) => r.front_ft === "NOT SHOWN");
    mfRegister.push({
      ...base,
      ...reg,
      citation: [...new Set(rows.map((r) => r.section_citation))].join("; "),
      verification: "conditional-not-evaluated",
      conditional,
      conditional_reason: MF_REFUSED_REASON[code],
      notes:
        `CONDITIONAL (not evaluated; see SETBACK_CONDITIONAL_NOT_EVALUATED): ${MF_REFUSED_REASON[code]}` +
        ` Rows (quoted, none served): ${numericRows.map(rowSummary).join(" || ")}.` +
        (pointers.length ? ` Pointer rows (verbatim): ${pointers.map((p) => `${rowLabel(p)} -- ${p.footnotes_verbatim}`).join(" || ")}.` : "") +
        ` Impervious cover NOT SPECIFIED (no Marble Falls table states one). Pack E notes: ${[...new Set(rows.map((r) => r.notes))].join(" || ")}` +
        ` | ${MF_ORDINANCE_HISTORY} | Ordinance history: ${history}`,
    });
    mfSample[code] = { served: false };
  }
}

/* ================================== HORSESHOE BAY ================================== */

const HSB_EDITION = { ordinance: "Ord. No. 2026-18", effective_date: "2026-06-16" };
const HSB_ORDINANCE_HISTORY =
  "Code edition: \"Includes legislation through Ord. No. 2026-18 adopted June 16, 2026\". Latest amendment to Art. 14.02: Ord. 2026-12 (adopted 2026-05-19).";

/**
 * Geographic zone of each pack-E row (by CSV row index), read from the row's own `building_type_row`
 * / `section_citation` label. Keyed by index rather than parsed so every assignment is reviewed.
 */
const HSB_ZONE = {};
const setZone = (from, to, zone) => { for (let i = from; i <= to; i++) HSB_ZONE[i] = zone; };
setZone(81, 84, "2");
setZone(85, 85, "5");
setZone(86, 88, "6");
setZone(89, 89, "7");
setZone(90, 91, "8");
setZone(92, 97, "9");
setZone(98, 101, "3/4A"); // § 14.02.406 headings: "within Zones 3 and 4A"
setZone(102, 102, "3 (25 listed lots)");
setZone(103, 103, "4A (Marina Village)");
setZone(104, 104, "3/4"); // R-6 heading: "within Zones 3 and 4"
setZone(105, 105, "4B");
setZone(106, 106, "3/4A");
setZone(107, 107, "3/4"); // A-1 heading: "within Zones 3 and 4"
setZone(108, 108, "4A");
setZone(109, 109, "3/4A/4B");
setZone(110, 110, "4A");
setZone(111, 113, "10");
setZone(114, 126, "11");
setZone(127, 127, "13");
setZone(128, 130, "15");
setZone(131, 134, "4A (former Zone 14 tracts)");
setZone(135, 135, "16");
setZone(136, 136, "17");
setZone(137, 139, "18");
setZone(140, 143, "19");
setZone(144, 158, "12");
setZone(159, 161, "1");
setZone(162, 162, "all zones (PD default rule)");

/**
 * EXPLICIT SPELLING MAP: pack E's district_code -> the layer's ZONING code (the only field the stamp
 * reads; `Public/Zoning/FeatureServer/2`), plus the layer's SUB_ZONING where one exists. Never fuzzy:
 * every pack-E spelling is listed, and an unlisted one throws. `null` = no layer code carries it
 * (the layer's ZONING domain, read 2026-10-13, is: A-1 AM-1 C-2 C-3 GH GUI LA M-1 MH-1 MOR MURC-1 PD
 * R-1 R-16 R-2 R-4 R-6 R-6.5 RR DR).
 */
const HSB_CODE_MAP = {
  "R-1": { zoning: "R-1", basis: "same spelling" },
  GH: { zoning: "GH", basis: "same spelling" },
  "R-2": { zoning: "R-2", basis: "same spelling" },
  "R-4": { zoning: "R-4", basis: "same spelling" },
  "R-6": { zoning: "R-6", basis: "same spelling" },
  "A-1": { zoning: "A-1", basis: "same spelling" },
  "C-2": { zoning: "C-2", basis: "same spelling" },
  GUI: { zoning: "GUI", basis: "same spelling" },
  "C-3": { zoning: "C-3", basis: "same spelling" },
  "AM-1": { zoning: "AM-1", basis: "same spelling" },
  "MURC-1": { zoning: "MURC-1", basis: "same spelling" },
  "R-6.5": { zoning: "R-6.5", basis: "same spelling" },
  "R-16": { zoning: "R-16", basis: "same spelling" },
  RR: { zoning: "RR", basis: "same spelling (Zone 17 'RR Rural Residential')" },
  "R-R": { zoning: "RR", basis: "the layer's ZONING domain has no 'R-R'; Zone 5's 'R-R Rural Residential' (§ 14.02.401 spells Zone 5 'R-R', Zone 17 'RR') -- the layer's 34 BAY COUNTRY features carry 'RR'" },
  LA: { zoning: "LA", basis: "same spelling" },
  DR: { zoning: "DR", basis: "same spelling" },
  PD: { zoning: "PD", basis: "same spelling" },
  "M-1": { zoning: "M-1", basis: "same spelling. NOTE: pack E's M-1 is the Zone 4B (Horseshoe Bay South) manufactured-home classification, but the layer's 3 M-1 features sit in PROPER / THE TRAILS, not SOUTH; the layer's SOUTH manufactured-home land is coded MH-1 (766 Burnet features), which pack E does not name -- MH-1 is NOT mapped to M-1 (never fuzzy)" },
  Moratorium: { zoning: "MOR", basis: "§ 14.02.401 lists 'Zone 13 (Caprock)(Currently subject to Moratorium)'; the layer's moratorium label is MOR" },
  CA: { zoning: "CA", basis: "the register's existing CA (common area) row; the layer itself carries common-area land with a BLANK ZONING (LANDUSE 'COMMON AREA')" },
  "R-1 Estate": { zoning: "R-1", basis: "Zone 9 (Escondido) classification; the layer's ESCONDIDO features carry only R-1 / R-6 / C-2 / A-1 / LA in ZONING, so an R-1 Estate lot is stamped R-1 (inferred from the domain; SUB_ZONING not confirmed). NOT the Zone 12 code R-1-EST" },
  "R-1 Villa": { zoning: "R-1", basis: "Zone 9 classification stamped R-1 (inferred, as R-1 Estate). NOT the Zone 12 code R-1-VIL" },
  "Lago Estate": { zoning: "R-1", basis: "Zone 9 'Lago Escondido Estate'; not in the § 14.02.401 list; stamped R-1 (inferred, as R-1 Estate)" },
  "R-6 Casita": { zoning: "R-6", basis: "Zone 9 classification; the layer's 88 ESCONDIDO R-6 features are the only R-6 land in Zone 9" },
  "R-1 Townhouse": { zoning: "R-1", basis: "Zone 10 R-1 townhome lots within lots 17 and 18 (R-1 per the ordinance's own heading)" },
  "R-1-CAB": { zoning: "R-1", subZoning: "R-1-CAB", basis: "Zone 12 sub-classification; layer SUB_ZONING R-1-CAB" },
  "R-1-COT": { zoning: "R-1", subZoning: "R-1-COT", basis: "Zone 12 sub-classification; layer SUB_ZONING R-1-COT" },
  "R-1-EST": { zoning: "R-1", subZoning: "R-1-EST", basis: "Zone 12 sub-classification; layer SUB_ZONING R-1-EST. NOT Zone 9's 'R-1 Estate'" },
  "R-1-GOLF": { zoning: "R-1", subZoning: "R-1-GOLF", basis: "Zone 12 sub-classification; layer SUB_ZONING R-1-GOLF" },
  "R-1-VIL": { zoning: "R-1", subZoning: "R-1-VIL", basis: "Zone 12 sub-classification; layer SUB_ZONING R-1-VIL. NOT Zone 9's 'R-1 Villa'" },
  "R-1 Family Homesteads": { zoning: "R-1", subZoning: null, basis: "Zone 12 sub-classification; the layer's SUB_ZONING domain has an R-1-HS value that may be this, but nothing in pack E says so, so no SUB_ZONING is asserted" },
  "R-2 Villas": { zoning: "R-2", subZoning: null, basis: "Zone 12 sub-classification of R-2 (no matching SUB_ZONING value in the layer domain)" },
  "R-4-CAB": { zoning: "R-4", subZoning: "R-4-CAB", basis: "Zone 12 sub-classification; layer SUB_ZONING R-4-CAB" },
  "MA-1": { zoning: null, basis: "not in the layer's ZONING domain" },
  "F-1": { zoning: null, basis: "not in the layer's ZONING domain" },
  "LR-1": { zoning: null, basis: "not in the layer's ZONING domain; not in the § 14.02.401 list" },
  "C-2 (PD authorization)": { zoning: null, basis: "tract-level PD authorization (§ 14.02.417 editor's note), assigned to individual lots in Zone 4A; not a district code" },
  "M-1 Marina (PD authorization)": { zoning: null, basis: "tract-level PD authorization (§ 14.02.417 editor's note); not a district code" },
};

/**
 * The layer's SUBDIVISION attribute (a coded domain, 17 values) -> geographic zone. Every value whose
 * name is the ordinance's own zone name maps by that name; PROPER / WEST / SOUTH are the three
 * "Horseshoe Bay" sub-areas of § 14.02.406 ("Zones 3, 4A & 4B").
 */
const SUBDIVISION_TO_ZONE = [
  { subdivision: "APPLEHEAD ISLAND", zones: ["1"], section: "§ 14.02.404", basis: "name match: 'Zone 1 (Applehead Island)'" },
  { subdivision: "APPLEHEAD", zones: ["2"], section: "§ 14.02.405", basis: "name match: 'Zone 2 (Applehead)'" },
  { subdivision: "PROPER", zones: ["3", "4A"], section: "§ 14.02.406", basis: "INFERRED. The layer's PROPER features include MURC-1 (Marina Village, which § 14.02.406 places in Zone 4A) and the Burnet 'HORSESHOE BAY NORTH' lots. Whether PROPER is Zone 3, Zone 4A or both is not stated anywhere in pack E. § 14.02.406 states the same text for 'Zones 3 and 4A' for R-1, GH, R-2, R-4 and C-2 (R-6 and A-1: 'Zones 3 and 4'), so the 3-vs-4A split does not change those codes' numbers" },
  { subdivision: "WEST", zones: ["3", "4A"], section: "§ 14.02.406", basis: "INFERRED, as PROPER. Caution: the layer's 2 WEST MOR features are the Zone 13 (Caprock) moratorium tract ('Horseshoe Bay West Plat No. W15.67'), so WEST is not always one zone" },
  { subdivision: "SOUTH", zones: ["4B"], section: "§ 14.02.406", basis: "name match: pack E labels Zone 4B 'Horseshoe Bay South'. Caution: § 14.02.406's R-1 yard text is headed 'Zones 3 and 4A'; pack E records only a floor-area/masonry sentence for Zone 4B R-1, so a SOUTH R-1 lot's setbacks are NOT established by zone alone" },
  { subdivision: "BAY COUNTRY", zones: ["5"], section: "§ 14.02.407", basis: "name match: 'Zone 5 (Bay Country)'" },
  { subdivision: "PECAN CREEK", zones: ["6"], section: "§ 14.02.408", basis: "name match: 'Zone 6 (Pecan Creek)'" },
  { subdivision: "PENINSULA", zones: ["7"], section: "§ 14.02.409", basis: "name match: 'Zone 7 (Peninsula)'" },
  { subdivision: "MATERN ISLAND", zones: ["8"], section: "§ 14.02.410", basis: "name match: 'Zone 8 (Matern Island)'" },
  { subdivision: "ESCONDIDO", zones: ["9"], section: "§ 14.02.411", basis: "name match: 'Zone 9 (Escondido)'" },
  { subdivision: "SIENA CREEK", zones: ["10"], section: "§ 14.02.412", basis: "name match: 'Zone 10 (Siena Creek)'" },
  { subdivision: "THE TRAILS", zones: ["11"], section: "§ 14.02.413", basis: "name match: 'Zone 11 (The Trails)'" },
  { subdivision: "SUMMIT ROCK", zones: ["12"], section: "§ 14.02.414", basis: "name match: 'Zone 12 (Summit Rock)'" },
  { subdivision: "CAPROCK", zones: ["13"], section: "§ 14.02.416", basis: "name match: 'Zone 13 (Caprock)' (no feature carries it today; the moratorium tract is coded WEST/PROPER)" },
  { subdivision: "AIRPORT", zones: ["15"], section: "§ 14.02.418", basis: "name match: 'Zone 15 (Airport)'" },
  { subdivision: "THE HILLS", zones: ["17"], section: "§ 14.02.420", basis: "name match: 'Zone 17 (The Hills)'" },
  { subdivision: "THE PARKS AT HORSESHOE BAY", zones: ["18"], section: "§ 14.02.421", basis: "name match: 'Zone 18 (The Parks at Horseshoe Bay)'" },
];

/**
 * Coded number for one HSB cell, or null with the reason. Mechanical rules only; every result is
 * printed in the run log for review, and OVERRIDES pins the cells that need a reader.
 */
const CONDITION_WORDS = /\b(except|whichever|greater|adjoin|abut|plat|unless|contour line along|BMPE|Water Quality Easement|Single-family dwellings|same development provisions|depending|provided that|provided, however|None required|no setbacks|perimeter)\b/i;
/** "total side yards of not less than X with not less than Y on one side" -- side cells only (coverage text says "total lot area"). */
const TOTAL_SIDE = /\btotal\b/i;
const HSB_OVERRIDES = {
  // Printing errors, copied as printed: never corrected into a number.
  "143|front_ft": { value: null, reason: "printed as 25\" (an inch mark) in the official text; copied as printed, not corrected" },
  "138|front_ft": { value: null, reason: "printed 'Street: 25' with no unit; copied as printed" },
  "138|corner_or_street_side_ft": { value: null, reason: "printed 'Street: 25' with no unit; copied as printed" },
  "132|side_ft": { value: null, reason: "printed 'often (10) feet' (likely 'of ten'); copied as printed" },
  "132|rear_ft": { value: null, reason: "printed 'often (10) feet' (likely 'of ten'); copied as printed" },
  // "total side yards of not less than 5 feet on EACH side": one per-side number, not a total split.
  "82|side_ft": { value: 5, reason: null, review: "'total side yards of not less than 5 feet on each side of the lot' = 5 ft on each side" },
  "99|side_ft": { value: 5, reason: null, review: "'total side yards of not less than 5 feet on each side of the lot' = 5 ft on each side" },
  "90|side_ft": { value: 5, reason: null, review: "'total side yards with not less than five (5) feet on each side' = 5 ft on each side" },
  // A stated base figure whose alternate is an optional reduction (same reading as Marble Falls'
  // Table 4.2.7.B averaging): the base is coded, the alternate stays in the verbatim text.
  "86|front_ft": { value: 20, reason: null, review: "base 20 ft; 'in the case of side-entry garages the front setback may be less' is an optional reduction, quoted" },
  // Zone 10 R-1: "(applicable to all lot boundaries that abut rights-of-way)" names WHICH boundaries,
  // it is not an abutting-zone condition.
  "111|front_ft": { value: 30, reason: null, review: "'Front (applicable to all lot boundaries that abut rights-of-way) 30''" },
  "111|corner_or_street_side_ft": { value: 15, reason: null, review: "'Side (applicable to all lot boundaries that abut rights-of-way) 15''" },
  // AM-1 coverage: pack E's cell joins two statements ("Building area shall not exceed sixty percent
  // (60%)" | "Lot coverage (maximum percentage): Subject to approval.") -- not one figure.
  "130|max_lot_coverage": { value: null, reason: "two statements in one cell (60% building area; lot coverage subject to approval)" },
  // M-1 side: the 40 inches is a clearance for awnings/projections, not a second setback.
  "105|side_ft": { value: 5, reason: null, review: "'at least five (5) feet ... with a minimum clearance of forty (40) inches from awnings or other projections' -- 5 ft setback; the 40 in. is a projection clearance" },
};

function codeHsbCell(rowIdx, field, text, footnotes) {
  const ov = HSB_OVERRIDES[`${rowIdx}|${field}`];
  if (ov) return ov;
  const t = text.trim();
  if (t === "NOT SPECIFIED") return { value: null, reason: "not stated" };
  if (/^None required\.?$/i.test(t)) return { value: 0, reason: null, review: "'None required.' -- an explicit statement of no setback, not silence" };
  if (/Per Plat|plat\/replat/i.test(t)) return { value: null, reason: "plat-controlled" };
  if (t.includes("*") && footnotes && footnotes !== "NONE") return { value: null, reason: `asterisk footnote changes the figure: ${footnotes}` };
  // '("Except as provided below")' points at the section's other rules (reverse-corner / lake);
  // the stated figure is coded and the pointer stays in the verbatim text.
  const stripped = t.replace(/\s*\("Except as provided below"\)$/, "");
  if (CONDITION_WORDS.test(stripped)) return { value: null, reason: "conditional, by-reference or not a single distance" };
  if (field === "side_ft" && TOTAL_SIDE.test(stripped)) return { value: null, reason: "total side yard with a one-side minimum" };
  const body = stripped.replace(/^Same as R-1 in Zones 3 and 4 \(§ 14\.02\.406\):\s*/, "").replace(/^Same as in the R-4 area:\s*/, "");
  const nums = new Set();
  for (const m of body.matchAll(/\((\d+(?:\.\d+)?)%?\)/g)) nums.add(Number(m[1]));
  for (const m of body.matchAll(/(\d+(?:\.\d+)?)\s*(?:'|feet|foot|ft\b|%|percent)/g)) nums.add(Number(m[1]));
  if (nums.size === 1) return { value: [...nums][0], reason: null };
  return { value: null, reason: nums.size === 0 ? "no number stated" : `more than one number stated (${[...nums].join(", ")})` };
}

const hsbEntries = hsbRows.map((r) => {
  const map = HSB_CODE_MAP[r.district_code];
  if (!map) throw new Error(`pack E Horseshoe Bay code ${JSON.stringify(r.district_code)} has no explicit spelling map entry`);
  const zone = HSB_ZONE[r._row];
  if (!zone) throw new Error(`pack E row ${r._row} (${r.district_code}) has no zone assignment`);
  const fields = {};
  for (const f of [...DIM, "max_height", "max_lot_coverage", "max_impervious_cover"]) {
    fields[f] = { verbatim: r[f], ...codeHsbCell(r._row, f, r[f], r.footnotes_verbatim) };
  }
  return {
    pack_e_row: r._row,
    pack_e_code: r.district_code,
    layer_zoning: map.zoning,
    layer_sub_zoning: map.subZoning ?? null,
    zone,
    zone_scope: r.building_type_row,
    section: r.section_citation,
    page_url: r.page_url,
    district_name: r.district_name,
    fields,
    min_lot_area: r.min_lot_area,
    footnotes_verbatim: r.footnotes_verbatim,
    notes: r.notes,
  };
});

/**
 * Per-field signature used to decide identical-vs-varies: the coded number; else "null" plus every
 * number the verbatim cell states (so "Subject to approval" and "Subject to approval by the city"
 * compare equal, while "10' except ... 40'" and "Rear: 20'" do not).
 */
const numbersIn = (s) => [...new Set([...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])))].sort((a, b) => a - b);
const sigField = (e, f) => (e.fields[f].value !== null ? `#${e.fields[f].value}` : `null[${numbersIn(e.fields[f].verbatim).join(",")}]`);
const SIG_FIELDS = [...DIM, "max_height", "max_lot_coverage", "max_impervious_cover"];
const signature = (e) => SIG_FIELDS.map((f) => sigField(e, f)).join(" ; ");

/** Every layer-vocabulary code with a pack-E row, grouped. Keyed by the layer's ZONING code. */
const byLayerCode = new Map();
for (const e of hsbEntries) {
  if (!e.layer_zoning) continue;
  if (!byLayerCode.has(e.layer_zoning)) byLayerCode.set(e.layer_zoning, []);
  byLayerCode.get(e.layer_zoning).push(e);
}
/** The Zone-12 SUB_ZONING codes the register already carries rows for (W1-H's GIS DS_ZONE values). */
const bySubZoning = new Map();
for (const e of hsbEntries) {
  if (!e.layer_sub_zoning) continue;
  bySubZoning.set(e.layer_sub_zoning, [...(bySubZoning.get(e.layer_sub_zoning) ?? []), e]);
}

const HSB_STAMPED = ["R-1", "MH-1", "R-4", "GH", "R-6", "R-2", "A-1", "C-2", "GUI"];

function analyse(entries) {
  const zones = [...new Set(entries.map((e) => e.zone))];
  const sigs = new Set(entries.map(signature));
  return { zones, identical: sigs.size === 1, distinctStandards: sigs.size };
}

/** A non-zone condition present in EVERY entry (so it holds even if the zone were known). */
function nonZoneConditions(entries) {
  const out = [];
  const uncoded = (e, f, re) => e.fields[f].value === null && (re.test(e.fields[f].verbatim) || (e.fields[f].verbatim.includes("*") && re.test(e.footnotes_verbatim)));
  const any = (f, re) => entries.some((e) => uncoded(e, f, re));
  if (any("side_ft", /adjoin|abut/i) || any("rear_ft", /adjoin|abut/i) || any("front_ft", /adjoin|abut/i)) out.push("abutting residential classification changes the side/rear figure");
  if (any("side_ft", /\btotal\b/i)) out.push("a total side yard with a one-side minimum (which side gets which width is not determined)");
  if (DIM.some((f) => any(f, /plat/i))) out.push("plat-controlled figures");
  if (DIM.some((f) => any(f, /contour|BMPE|easement|greater/i))) out.push("a setback stated as a line or the greater of two distances");
  if (DIM.some((f) => any(f, /same development provisions/i))) out.push("standards adopted by reference to another zone");
  return out;
}

/** "not stated" in every entry -> recorded as "" (not_specified), not as a condition. */
const isNotStated = (v) => v.value === null && v.reason === "not stated";

function hsbConditionalMap(entries) {
  const conditional = {};
  const reg = {};
  for (const f of DIM) {
    const values = entries.map((e) => e.fields[f]);
    const distinct = new Set(values.map((v) => (v.value !== null ? `#${v.value}` : isNotStated(v) ? "NS" : `"${v.verbatim}"`)));
    const single = distinct.size === 1 && (values[0].value !== null || isNotStated(values[0]));
    if (single) {
      reg[REG_FIELD[f]] = values[0].value !== null ? String(values[0].value) : "";
    } else {
      reg[REG_FIELD[f]] = "";
      conditional[REG_FIELD[f]] = entries
        .map((e) => `Zone ${e.zone} (${e.section.replace("Code of Ordinances Ch. 14 Zoning, Art. 14.02, ", "")}; ${e.pack_e_code}; ${e.zone_scope.replace(/^Zones? [^:]*:\s*/, "")}): "${e.fields[f].verbatim}"`)
        .join(" | ");
    }
  }
  return { conditional, reg };
}

const HSB_ZONE_REASON = "standards vary by Horseshoe Bay geographic zone; parcel zone not resolved";

const hsbRegister = new Map(); // code -> row
const hsbVerdicts = [];
function hsbBase(code, entries) {
  const first = entries[0];
  const src = hsbRows.find((r) => r._row === first.pack_e_row);
  return {
    city: HSB,
    district_code: code,
    district_name: first.district_name,
    ordinance: HSB_EDITION.ordinance,
    effective_date: HSB_EDITION.effective_date,
    edition_line_verbatim: src.edition_line_verbatim,
    source_url: first.page_url,
    access_date: src.access_date,
  };
}
function zoneList(entries) {
  return entries.map((e) => `Zone ${e.zone} [${e.pack_e_code}] (${e.section.replace("Code of Ordinances Ch. 14 Zoning, Art. 14.02, ", "")})`).join("; ");
}

/** Codes pack E states no dimensional standards for, in any zone where they appear. */
const HSB_NO_DIMENSIONAL = new Set(["LA", "MOR", "CA", "DR", "PD"]);

function buildHsbRow(code, entries, { keyKind }) {
  const a = analyse(entries);
  const ncond = nonZoneConditions(entries);
  const { conditional, reg } = hsbConditionalMap(entries);
  const base = hsbBase(code, entries);
  const history = [...new Set(entries.map((e) => hsbRows.find((r) => r._row === e.pack_e_row).adopting_or_amending_ordinance))].join(" || ");
  const allZonesText = entries
    .map((e) => `Zone ${e.zone} [${e.pack_e_code}] ${e.section.replace("Code of Ordinances Ch. 14 Zoning, Art. 14.02, ", "")} (${e.zone_scope}): front "${e.fields.front_ft.verbatim}"; side "${e.fields.side_ft.verbatim}"; rear "${e.fields.rear_ft.verbatim}"; street side "${e.fields.corner_or_street_side_ft.verbatim}"; height "${e.fields.max_height.verbatim}"; lot coverage "${e.fields.max_lot_coverage.verbatim}"; impervious "${e.fields.max_impervious_cover.verbatim}". Notes: ${e.notes}`)
    .join(" || ");

  if (HSB_NO_DIMENSIONAL.has(code)) {
    const anyNumber = entries.some((e) => DIM.some((f) => e.fields[f].value !== null));
    if (anyNumber) throw new Error(`HSB ${code} marked no-dimensional-standards but a setback number was coded`);
    hsbVerdicts.push({ code, keyKind, zones: a.zones, standards: "no dimensional standards stated", verdict: "SETBACK_NO_DIMENSIONAL_STANDARDS" });
    return {
      ...base,
      front_ft: "",
      side_ft: "",
      rear_ft: "",
      corner_ft: "",
      citation: entries.map((e) => e.section).join("; "),
      verification: "no-dimensional-standards",
      notes: `NO DIMENSIONAL STANDARDS: pack E's reading of Art. 14.02 states no front/side/rear/street-side setback for ${code} in any zone where it appears (${zoneList(entries)}). | ${allZonesText} | ${HSB_ORDINANCE_HISTORY} | Ordinance history: ${history}`,
    };
  }

  const varies = !a.identical;
  const fieldConditional = Object.keys(conditional).length > 0;
  if (!varies && !fieldConditional && ncond.length === 0) {
    // Identical in every zone where the code appears, and every setback field is one number (or not
    // stated): the ordinance text supports one number set. Registered verified-browser-read. No
    // horseshoe-bay-tx SETBACK_TABLES entry is vendored in this PR (see the README), so it refuses
    // SETBACK_TABLE_ABSENT by design.
    hsbVerdicts.push({ code, keyKind, zones: a.zones, standards: a.zones.length > 1 ? "identical across zones" : "single zone", verdict: "verified-browser-read; no table vendored -> SETBACK_TABLE_ABSENT" });
    return {
      ...base,
      ...reg,
      citation: entries.map((e) => e.section).join("; "),
      verification: "verified-browser-read",
      notes: `VERIFIED, NOT TABLED: ${code} appears in ${a.zones.length === 1 ? "one zone only" : "several zones with identical standards"} (${zoneList(entries)}) and the text states one figure per setback field, but no horseshoe-bay-tx SETBACK_TABLES entry is vendored (no stamped Horseshoe Bay code serves, and R-16 / R-6.5 are prefix-neighbours of the stamped, refused R-1 / R-6 that districtMapping.ts's prefix fallback would cross into on any path that skips the edition gate), so it refuses SETBACK_TABLE_ABSENT by design. No Burnet (county GBU) feature on the layer carries ${code} today. | ${allZonesText} | ${HSB_ORDINANCE_HISTORY} | Ordinance history: ${history}`,
    };
  }

  const reasons = [];
  if (varies) reasons.push(HSB_ZONE_REASON);
  reasons.push(...ncond);
  if (reasons.length === 0) {
    const why = [...new Set(entries.flatMap((e) => DIM.map((f) => e.fields[f]).filter((v) => v.value === null && !isNotStated(v)).map((v) => v.reason)))];
    reasons.push(`a setback cell is not one figure (${why.join("; ")})`);
  }
  const reason = reasons.join("; ");
  hsbVerdicts.push({
    code,
    keyKind,
    zones: a.zones,
    standards: varies ? `varies (${a.distinctStandards} distinct standard sets)` : a.zones.length > 1 ? "identical across zones" : "single zone",
    verdict: `SETBACK_CONDITIONAL_NOT_EVALUATED (${reason})`,
  });
  const cond = Object.keys(conditional).length ? conditional : {};
  if (Object.keys(cond).length === 0) {
    // Identical numbers but a non-zone condition the numbers alone do not show (e.g. GUI's
    // "10'.*" with the footnote's 25 ft adjoining-residential rule): carry the raw text anyway.
    for (const f of ["side_ft", "rear_ft"]) {
      cond[REG_FIELD[f]] = entries
        .map((e) => `Zone ${e.zone} (${e.section.replace("Code of Ordinances Ch. 14 Zoning, Art. 14.02, ", "")}): "${e.fields[f].verbatim}"${e.footnotes_verbatim !== "NONE" ? ` [footnote verbatim: ${e.footnotes_verbatim}]` : ""}`)
        .join(" | ");
      reg[REG_FIELD[f]] = "";
    }
  }
  return {
    ...base,
    ...reg,
    citation: entries.map((e) => e.section).join("; "),
    verification: "conditional-not-evaluated",
    conditional: cond,
    conditional_reason: reason,
    notes: `CONDITIONAL (not evaluated; see SETBACK_CONDITIONAL_NOT_EVALUATED): ${reason}. Zones where ${code} appears: ${zoneList(entries)}. | ${allZonesText} | ${HSB_ORDINANCE_HISTORY} | Ordinance history: ${history}`,
  };
}

for (const [code, entries] of byLayerCode) hsbRegister.set(code, buildHsbRow(code, entries, { keyKind: "ZONING" }));
for (const [code, entries] of bySubZoning) {
  if (hsbRegister.has(code)) throw new Error(`SUB_ZONING ${code} collides with a ZONING code`);
  hsbRegister.set(code, buildHsbRow(code, entries, { keyKind: "SUB_ZONING" }));
}

// MH-1: stamped (746 Burnet parcels), but pack E names no MH-1. Refused as unsourced; never mapped
// onto pack E's Zone-4B "M-1" (that would be a fuzzy match).
const MH1_NOTE =
  "UNSOURCED (pack E, 2026-10-13): MH-1 is stamped on Burnet parcels (746 in txgio_parcel; every MH-1 feature on the layer is SUBDIVISION 'SOUTH') but pack E's reading of Art. 14.02 names no MH-1 district. Pack E's 'M-1 Manufactured Home' row is the Zone 4B (Horseshoe Bay South) classification and its setbacks (10/5/15/10) equal the GIS attributes the earlier W1-H row recorded for MH-1, but the layer ALSO carries a separate ZONING value 'M-1' (3 features, PROPER / THE TRAILS), so equating MH-1 with the ordinance's M-1 would be a fuzzy match. Refused SETBACK_EDITION_UNVERIFIED until an ordinance read names MH-1 or the city confirms the equivalence.";

const UNTOUCHED_NOTE_PREFIX = "NOT IN PACK E (2026-10-13): ";

const register = JSON.parse(readFileSync(REGISTER_PATH, "utf8"));
const out = [];
let mfInserted = false;
const seenHsb = new Set();
for (const row of register) {
  if (row.city === MF) {
    if (row.district_code === "PD") {
      out.push(
        ...(!mfInserted ? mfRegister : []),
        {
          ...row,
          notes:
            `${UNTOUCHED_NOTE_PREFIX}pack E did not extract the Div. 4.4 MPC/PDD standards (each PDD is set by its own granting ordinance), so this row stays unverified and keeps its earlier W1-H content for audit. | ${row.notes}`,
        },
      );
      mfInserted = true;
    }
    continue; // every other MF row is replaced by mfRegister
  }
  if (row.city === HSB) {
    const code = row.district_code;
    if (code === "MH-1") {
      out.push({
        ...row,
        verification: "unverified",
        notes: `${MH1_NOTE} | Earlier W1-H content kept for audit: ${row.notes}`,
      });
    } else if (hsbRegister.has(code)) {
      out.push(hsbRegister.get(code));
    } else {
      out.push({
        ...row,
        notes: row.notes.startsWith(UNTOUCHED_NOTE_PREFIX)
          ? row.notes
          : `${UNTOUCHED_NOTE_PREFIX}pack E's reading of Art. 14.02 has no row spelled "${code}" (a W1-H GIS-layer label, not in the layer's current ZONING domain); row kept as-is. | ${row.notes}`,
      });
    }
    seenHsb.add(code);
    continue;
  }
  out.push(row);
}
if (!mfInserted) throw new Error("Marble Falls PD anchor row not found");
// Codes pack E covers that the register had no row for (DR, PD): append after the last HSB row.
const newHsb = [...hsbRegister.keys()].filter((c) => !seenHsb.has(c));
if (newHsb.length) {
  const lastHsb = out.map((r) => r.city).lastIndexOf(HSB);
  out.splice(lastHsb + 1, 0, ...newHsb.map((c) => hsbRegister.get(c)));
}
for (const code of HSB_STAMPED) {
  if (!out.some((r) => r.city === HSB && r.district_code === code)) throw new Error(`stamped HSB code ${code} has no register row`);
}
// The register's own key order (pack C's), with conditional_reason after conditional.
const KEY_ORDER = ["city", "district_code", "district_name", "front_ft", "side_ft", "rear_ft", "corner_ft", "citation", "ordinance", "effective_date", "verification", "edition_line_verbatim", "source_url", "access_date", "conditional", "conditional_reason", "notes"];
const ordered = out.map((row) => {
  const o = {};
  for (const k of KEY_ORDER) if (k in row) o[k] = row[k];
  for (const k of Object.keys(row)) if (!(k in o)) throw new Error(`unexpected register key ${k}`);
  return o;
});
writeFileSync(REGISTER_PATH, JSON.stringify(ordered, null, 2) + "\n", "utf8");

/* ---------------------------------- the MF table ---------------------------------- */
const mfTable = {
  $schema: "./schema.json",
  jurisdictionKey: "marble-falls-tx",
  jurisdictionDisplayName: "City of Marble Falls, TX",
  effectiveDate: MF_EDITION.effective_date,
  note:
    "City of Marble Falls, TX. INSTRUMENT: Code of Ordinances App. B Development Code (UDC), Art. 4 -- Table 4.2.2 (residential building types), Table 4.2.6.A (Downtown Residential), Table 4.2.7.A (Existing Neighborhood Zone sub-districts), Table 4.3.1.B (nonresidential and mixed-use) and Sec. 4.3.4 (Downtown build-to lines). EDITION: \"Codified through Ordinance No. 2026-O-04A, adopted April 7, 2026. (Supp. No. 98)\". " +
    MF_ORDINANCE_HISTORY +
    " SOURCE: library.municode.com (linked from marblefallstx.gov), read by the operator's browser agent on 2026-10-12 (doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_browser_packE.csv, \"pack E\"); every table value was checked by script against the live Municode tables. This replaces the earlier zoneomics-mirror transcription (W1-H), which LDT #805 downgraded to unverified. SCOPE: 7 of the 17 stamped districts -- ENZ.1, ENZ.2, ENZ.3, ENZ.4, ENZ.5, BP, IN. The other 10 stay UNROWED and refuse SETBACK_CONDITIONAL_NOT_EVALUATED in the register: FR, RE, NR, TR and MR (Table 4.2.2 gives one row per building type, marks none as primary, and the district has several Single-Family Detached rows with different numbers -- or, for MR, none); DR (Table 4.2.6.A keys every building type to a lot-width tier whose numbers differ); NC and GC (side/rear change for lots adjacent to Lake Marble Falls, Table 4.3.1.B note 1); DN and DT (build-to lines, lake-adjacent side/rear, plus townhouse rows). PD stays unverified (pack E did not extract Div. 4.4). BUILDING-TYPE RULE: a district is served only when its governing table gives it exactly one Single-Family Detached row (or only one row at all); that row is served and every other row is quoted in the register. ENZ.3/ENZ.4/ENZ.5 serve their single Single-Family Detached row; ENZ.1, ENZ.2, BP and IN have one row each. READING RULES: Table 4.2.7.B's alternate standards (front setback averaging, front-porch reduction, street-side averaging) are optional reductions from the stated figure, so the stated figure is coded and the alternates are quoted in front_ft's provenance. No Marble Falls table states an impervious-cover figure, so max_impervious_pct is not_specified everywhere (never read as zero). SENTINELS: not_specified = 100, except max_height_ft's canonical 999 (no served row needs it). No code-section atom corpus exists yet for marble_falls_tx; every value is primary-source-verified.",
  districts: mfTableDistricts,
};
writeFileSync(MF_TABLE_PATH, JSON.stringify(mfTable, null, 2) + "\n", "utf8");

/* ------------------------------ the HSB zone-keyed file ------------------------------ */
const hsbZoneFile = {
  jurisdictionKey: "horseshoe-bay-tx",
  status:
    "NOT SERVED. Horseshoe Bay's dimensional standards keyed by (district code, geographic zone). The serving path resolves by (jurisdiction, district code) only and no parcel's geographic zone is resolved today, so this file is NOT a SETBACK_TABLES entry; every stamped Horseshoe Bay code refuses in the register. It exists so the per-parcel zone resolution specified in `zone_resolution_spec` has a reviewed, quote-carrying table to read once it is built.",
  edition_line_verbatim: hsbRows[0].edition_line_verbatim,
  edition: HSB_ORDINANCE_HISTORY,
  source:
    "ecode360.com Code of Ordinances Ch. 14 Art. 14.02 (linked as 'Code of Ordinances' from horseshoe-bay-tx.gov), read 2026-10-12 by the operator's browser agent; every value cell string-matched against the live text (doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_browser_packE.csv, pack E).",
  zone_resolution_spec: {
    finding:
      "KNOWABLE FOR MOST LAND, NOT BUILT. The city's own zoning layer (horseshoebaygis.newedgeservices.com Public/Zoning/FeatureServer/2, 'Zoning Parcels' -- the same feature the stamp already joins to by PROP_ID + county='GBU') carries a SUBDIVISION attribute: a 17-value coded domain whose values are the ordinance's own zone names (APPLEHEAD ISLAND = Zone 1 ... THE PARKS AT HORSESHOE BAY = Zone 18), populated on all 2,532 Burnet (GBU) features (read 2026-10-13: PROPER 386, SOUTH 1,997, PENINSULA 12, WEST 4, SUMMIT ROCK 2 ... see `burnet_features_by_subdivision`). It also carries SUB_ZONING (R-1-SF, R-1-CAB, R-1-COT, R-1-GOLF, R-1-HS, R-1-EST, R-1-VIL, R-4-MF, R-4-CAB, R-2-2F), which the stamp does not read today.",
    how_to_resolve_per_parcel: [
      "1. At stamp time (lib/cad-ingest zoning-stamp), read SUBDIVISION and SUB_ZONING from the SAME matched feature whose ZONING is stamped (PROP_ID join restricted to county='GBU', with the interior-point containment check; point-lookup fallback) and persist them next to zoning_district (e.g. a zoning_subarea column on txgio_parcel). Never take them from a neighbouring feature.",
      "2. Map SUBDIVISION to a zone with `subdivision_to_zone` below -- an explicit table, never a name heuristic at runtime. Blank or unlisted SUBDIVISION -> no zone -> refuse.",
      "3. Look up (ZONING, zone) in `standards`. Serve only when exactly one entry matches and every dimensional field is a coded number. PROPER and WEST map to {3, 4A}; serve them only for codes whose Zone 3 and Zone 4A entries are the same entry (§ 14.02.406 text headed 'Zones 3 and 4A').",
      "4. Refuse (SETBACK_CONDITIONAL_NOT_EVALUATED) where the zone does not settle the number: lot-level sub-areas (Zone 11's per-lot table rows; Zone 3's 25 listed R-4 lots; Lighthouse Drive R-1 side yards; shoreline-lot heights; Zone 9 Plat 1.6 lots), 'total side yards ... not less than X on one side', abutting-residential side/rear rules, and plat-controlled cells.",
      "5. Known gaps a resolver must refuse on: Zone 19 (Monarch Ridge) has no SUBDIVISION value at all; Zone 16 (LA) is defined by code, not SUBDIVISION; the Zone 13 moratorium tract is coded WEST/PROPER, not CAPROCK; SOUTH (Zone 4B) R-1 has no yard text of its own in pack E (§ 14.02.406's R-1 yards are headed 'Zones 3 and 4A').",
      "6. Every Horseshoe Bay residential yard paragraph opens 'Except as specified to the contrary on an approved plat, which specification shall control' -- a served number must carry that caveat (operator decision whether that alone is a refusal).",
    ],
    burnet_features_by_subdivision:
      "county='GBU' features by SUBDIVISION / ZONING (layer statistics query, 2026-10-13): PENINSULA R-1 11; PROPER R-1 238, GH 50, R-2 41, R-4 90, R-6 51, C-2 12, A-1 8, GUI 5, blank 22; SOUTH R-1 1,229, MH-1 766, A-1 2; SUMMIT ROCK A-1 2; WEST R-1 2, A-1 2. Total 2,532.",
  },
  subdivision_to_zone: SUBDIVISION_TO_ZONE,
  code_spelling_map: Object.entries(HSB_CODE_MAP).map(([pack_e_code, m]) => ({
    pack_e_code,
    layer_zoning: m.zoning,
    layer_sub_zoning: m.subZoning ?? null,
    basis: m.basis,
  })),
  per_code_verdicts: hsbVerdicts,
  standards: hsbEntries,
};
writeFileSync(HSB_ZONES_PATH, JSON.stringify(hsbZoneFile, null, 2) + "\n", "utf8");

/* ---------------------------------- run log ---------------------------------- */
console.log(`Register: ${out.length} rows (MF ${out.filter((r) => r.city === MF).length}, HSB ${out.filter((r) => r.city === HSB).length}).`);
console.log(`Marble Falls served (${mfTableDistricts.length}): ${Object.entries(mfSample).filter(([, v]) => v.served).map(([k, v]) => `${k} [${v.row}] ${JSON.stringify(v.vals)}`).join("\n  ")}`);
console.log(`Marble Falls refused: ${Object.entries(mfSample).filter(([, v]) => !v.served).map(([k]) => k).join(", ")}`);
console.log("Horseshoe Bay per-code verdicts:");
for (const v of hsbVerdicts) console.log(`  ${v.code.padEnd(8)} [${v.keyKind}] zones ${v.zones.join(", ")} -> ${v.standards} -> ${v.verdict}`);
console.log("Horseshoe Bay coded cells (review):");
for (const e of hsbEntries) {
  console.log(`  #${e.pack_e_row} ${e.pack_e_code} Z${e.zone}: ` + [...DIM, "max_height", "max_lot_coverage", "max_impervious_cover"].map((f) => `${f.replace("_ft", "").replace("corner_or_street_side", "corner").replace("max_", "")}=${e.fields[f].value ?? "-"}`).join(" "));
}
