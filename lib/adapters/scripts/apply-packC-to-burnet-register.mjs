#!/usr/bin/env node
/**
 * One-off (but rerunnable) driver: converts
 * doc_repo/_inbox/2026-10-07_burnet_B3_groundtruth_browser_packC.csv (pack C,
 * a person-paced honest browser read, 2026-10-07) through
 * convert-ordinance-register-csv.mjs, and replaces the Burnet, Granite
 * Shoals, Cottonwood Shores, Bertram, Highland Haven and Meadowlakes rows in
 * burnet-tx-ordinance-register.json with the result. Marble Falls and
 * Horseshoe Bay rows are left byte-for-byte untouched (out of scope; GIS-
 * sourced / already usable).
 *
 * TWO kinds of reviewed cell, kept deliberately separate:
 *   RESOLUTIONS       -- the conditional-language safety net flagged this
 *                         cell, but reading it confirms there is only ONE
 *                         real value (no second branch exists). Serves a
 *                         number; nothing is lost.
 *   CONDITIONAL_CELLS -- the cell's value genuinely depends on a condition
 *                         this pipeline cannot evaluate today (road width,
 *                         unit/tenant count, abutting-zone, which physical
 *                         side of the lot, lot configuration relative to the
 *                         lake...). Per WDLL check 8 ("zero wrong values"),
 *                         recording the most-restrictive branch as THE
 *                         number would be wrong for every parcel where the
 *                         other branch applies, so no number is recorded at
 *                         all -- the raw text (every branch) goes into the
 *                         row's `conditional` field and the whole district
 *                         refuses SETBACK_CONDITIONAL_NOT_EVALUATED (gate is
 *                         per DISTRICT: index.ts's SetbackDistrict type
 *                         requires all four dimensional fields to be real
 *                         numbers, so there is no partial table to serve
 *                         even when 3 of 4 cells are clean).
 *
 * Running this script with both maps empty throws, naming every cell that
 * still needs classifying into one or the other -- that was how this list
 * was built.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseCsv, convertRows } from "./convert-ordinance-register-csv.mjs";

const CSV_PATH = "P:/seat-worktrees/property/doc_repo/_inbox/2026-10-07_burnet_B3_groundtruth_browser_packC.csv";
const REGISTER_PATH = new URL("../src/local/setbacks/burnet-tx-ordinance-register.json", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");

const TARGET_CITIES = ["Burnet", "Granite Shoals", "Cottonwood Shores", "Bertram", "Highland Haven", "Meadowlakes"];

const CITY_EDITION = {
  Burnet: { ordinance: "Ord. No. 2026-23 (Supp. No. 57)", effectiveDate: "2026-06-23" },
  "Granite Shoals": { ordinance: "Ord. No. 898", effectiveDate: "2026-09-22" },
  "Cottonwood Shores": { ordinance: "Ord. No. 12001", effectiveDate: "2026-04-19" },
  Bertram: { ordinance: "Ord. No. 215-081126", effectiveDate: "2026-08-11" },
  "Highland Haven": { ordinance: "Ord. No. 056 Rev. 18", effectiveDate: "2026-07-07" },
  Meadowlakes: { ordinance: "Ord. No. 2024-07 (Republication)", effectiveDate: "2024-10-15" },
};

// Confirmed-single-value cells: the conditional-language safety net flagged these (usually on the word
// "adjacent"), but reading them confirms there is only one real branch -- no number is lost.
const RESOLUTIONS = new Map([
  // Burnet R-3: Ord. 2026-12 (4-20-26) amended this district's Chart 1 values, but Municode's OWN front
  // page also lists 2026-12 under "Adopted Ordinances Not Yet Codified" -- so it is unknown whether the
  // Chart 1 numbers as currently read already reflect that amendment or not. Marked edition-ambiguous
  // (a distinct refusal code) rather than verified-browser-read: the dimensional values are recorded as
  // read for provenance, but the gate must refuse to serve them.
  ["Burnet|R-3|verification", "edition-ambiguous"],

  // Highland Haven R1/R2 side: "within five (5) feet of the ADJACENT lot line" -- "adjacent" trips the
  // safety net, but this just means "the neighboring lot line"; there is no second branch.
  ["Highland Haven|R1|side_ft", 5],
  ["Highland Haven|R2|side_ft", 5],
  // Highland Haven R1 corner: "ten (10) feet of the side lot line ADJACENT TO the street (corner lots)"
  // -- same false-positive trigger, same single real value.
  ["Highland Haven|R1|corner_ft", 10],
]);

// Genuinely conditional cells: WDLL check 8 ("zero wrong values") forbids recording the most-restrictive
// branch as THE setback, since it would be wrong for every parcel where the other branch applies and
// this pipeline has no data to evaluate which branch applies (no pavement-width layer, no per-building
// unit/tenant counts, no computed abutting-zone check, no per-side lot orientation). No number is
// recorded; the raw text (every branch) is carried verbatim in the row's `conditional` field and the
// whole district refuses SETBACK_CONDITIONAL_NOT_EVALUATED.
const CONDITIONAL_CELLS = new Map([
  // --- Burnet: "20/25 ft depending on road pavement width over/under 31 ft of pavement" (the 31 ft
  // figure is the threshold itself, not a candidate setback).
  ["Burnet|R-1|front_ft", "road pavement width (over vs under 31 ft)"],
  ["Burnet|R-6|front_ft", "road pavement width (over vs under 31 ft)"],
  ["Burnet|R-6-13|front_ft", "road pavement width (over vs under 31 ft)"],
  ["Burnet|M-1|front_ft", "road pavement width (over vs under 31 ft)"],
  ["Burnet|NC|front_ft", "road pavement width (over vs under 31 ft)"],
  // Burnet R-2 / R-2 A front: unit count (two-unit vs three/four-unit, or connected-unit equivalent).
  ["Burnet|R-2|front_ft", "unit count (two-unit vs three/four-unit building)"],
  ["Burnet|R-2 A|front_ft", "unit count (two vs three/four connected units)"],
  // Burnet R-2 / R-2 A / M-2 rear: abutting-residential (R-1) zoning.
  ["Burnet|R-2|rear_ft", "abutting residential (R-1) zoning"],
  ["Burnet|R-2 A|rear_ft", "abutting residential (R-1) zoning"],
  ["Burnet|M-2|rear_ft", "abutting residential (R-1) zoning"],
  // Burnet M-2 side: "10 ft. and one foot per unit" -- open-ended, no stated cap at all (worse than a
  // two-branch condition: there is no largest value to even name as "most restrictive").
  ["Burnet|M-2|side_ft", "unit count, open-ended (base 10 ft plus 1 ft per unit, no stated maximum)"],
  // Burnet C-3 side: single- vs multi-tenant.
  ["Burnet|C-3|side_ft", "tenant count (single- vs multi-tenant)"],

  // --- Granite Shoals
  // M-2 side: "no side yard on one side, 12 ft on the other" (side position), PLUS the same section's
  // notes add "20 ft ... when M-2 borders a residential zone" (abutting-residential) -- compound.
  ["Granite Shoals|M-2|side_ft", "side position (0 ft one side / 12 ft other) and abutting residential zoning (20 ft)"],
  // GB-1 / GB-2 rear: "none, except not less than 10 feet when rear lot line abuts ... residential".
  ["Granite Shoals|GB-1|rear_ft", "abutting residential zoning (none vs 10 ft)"],
  ["Granite Shoals|GB-2|rear_ft", "abutting residential zoning (none vs 10 ft)"],
  // Industrial district I: front/rear are a plain abutting-residential two-branch condition; side is
  // the same compound side-position + abutting-residential shape as Granite Shoals M-2.
  ["Granite Shoals|I|front_ft", "adjacent residential district or use"],
  ["Granite Shoals|I|side_ft", "side position (none one side / 12 ft other) and abutting residential zoning (20 ft)"],
  ["Granite Shoals|I|rear_ft", "abutting residential districts"],

  // --- Bertram
  // R-1-A side: the dimensional cell reads "5 ft. (2)", but footnote (2) says the real rule is "ten
  // (10) feet on one side, and a zero lot line ... on the other" -- two DIFFERENT numbers for two
  // DIFFERENT physical sides of the same lot, not one number. 5 is not even one of the two real values.
  ["Bertram|R-1-A|side_ft", "side position (10 ft one side, zero-lot-line other side)"],

  // --- Highland Haven
  // R1/R2 rear: three scenarios (waterfront channel depth / through-lot / back-to-back) -- which one
  // applies depends on the parcel's position relative to Lake LBJ and adjacent street layout, not on
  // anything this pipeline computes today.
  ["Highland Haven|R1|rear_ft", "lot configuration (waterfront channel depth vs through-lot vs back-to-back)"],
  ["Highland Haven|R2|rear_ft", "lot configuration (same as R1: waterfront/through-lot/back-to-back)"],
]);

const csvText = readFileSync(CSV_PATH, "utf8");
const csvRows = parseCsv(csvText);

const { rows: newRows, reviewedLog, conditionalLog } = convertRows({
  csvRows,
  targetCities: TARGET_CITIES,
  resolutions: RESOLUTIONS,
  conditionalCells: CONDITIONAL_CELLS,
  cityEdition: CITY_EDITION,
});

const register = JSON.parse(readFileSync(REGISTER_PATH, "utf8"));
const untouched = register.filter((r) => !TARGET_CITIES.includes(r.city));

// Preserve the original city ordering: Marble Falls, [Burnet block], [Granite Shoals block],
// Horseshoe Bay, [Cottonwood Shores block], [Meadowlakes block], [Bertram block], [Highland Haven block].
const byCity = (city) => newRows.filter((r) => r.city === city);
const marbleFalls = untouched.filter((r) => r.city === "Marble Falls");
const horseshoeBay = untouched.filter((r) => r.city === "Horseshoe Bay");

const finalRows = [
  ...marbleFalls,
  ...byCity("Burnet"),
  ...byCity("Granite Shoals"),
  ...horseshoeBay,
  ...byCity("Cottonwood Shores"),
  ...byCity("Meadowlakes"),
  ...byCity("Bertram"),
  ...byCity("Highland Haven"),
];

// Sanity: every untouched row must still be present (nothing from Marble Falls/Horseshoe Bay lost).
if (marbleFalls.length + horseshoeBay.length !== untouched.length) {
  throw new Error(`untouched-row accounting mismatch: untouched=${untouched.length}, marbleFalls=${marbleFalls.length}, horseshoeBay=${horseshoeBay.length}`);
}

writeFileSync(REGISTER_PATH, JSON.stringify(finalRows, null, 2) + "\n", "utf8");

console.log(`Wrote ${finalRows.length} rows (${untouched.length} untouched + ${newRows.length} converted from pack C).`);
console.log(`By city: ${JSON.stringify(Object.fromEntries(TARGET_CITIES.map((c) => [c, byCity(c).length])))}`);
console.log(`Reviewed overrides applied (${reviewedLog.length}) -- confirmed single value, served:`);
for (const e of reviewedLog) console.log(`  ${e.city} ${e.district} ${e.field} -> ${e.value}  (raw: ${e.raw})`);
console.log(`Conditional cells applied (${conditionalLog.length}) -- refused SETBACK_CONDITIONAL_NOT_EVALUATED, no number served:`);
for (const e of conditionalLog) console.log(`  ${e.city} ${e.district} ${e.field} [${e.condition}]  (raw: ${e.raw})`);
console.log(`Districts refused for conditional-not-evaluated: ${new Set(conditionalLog.map((e) => `${e.city}|${e.district}`)).size}`);
