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
 * Every RESOLUTIONS entry below is a row this agent read and decided by hand
 * because the cell could not be resolved mechanically (see the comment on
 * each). Running this script with an empty RESOLUTIONS map throws, naming
 * every cell that still needs one -- that was how this list was built.
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

const RESOLUTIONS = new Map([
  // --- Burnet: "20/25 ft depending on road pavement width" rows -- the road-width number (31) is a
  // threshold, not a candidate setback; 25 is the more restrictive of the two actual setback values.
  ["Burnet|R-1|front_ft", 25],
  ["Burnet|R-6|front_ft", 25],
  ["Burnet|R-6-13|front_ft", 25],
  ["Burnet|M-1|front_ft", 25],
  ["Burnet|NC|front_ft", 25],
  // Burnet R-2 / R-2 A: "25 ft for two unit, 30 ft for three/four unit" front; "10 ft, 15 ft when
  // abutting R-1" rear. Most restrictive of each pair.
  ["Burnet|R-2|front_ft", 30],
  ["Burnet|R-2|rear_ft", 15],
  ["Burnet|R-2 A|front_ft", 30],
  ["Burnet|R-2 A|rear_ft", 15],
  // Burnet M-2 rear: same "10 ft / 15 ft abutting R-1" shape as R-2.
  ["Burnet|M-2|rear_ft", 15],
  // Burnet M-2 side: "10 ft. and one foot per unit" is open-ended (no fixed cap stated) -- there is no
  // single most-restrictive number. Recording the BASE value (10) only, per the task's fallback
  // instruction that a numeric field gets a single value when a consumer needs one; the open-ended
  // per-unit language is preserved verbatim in notes so nothing downstream mistakes 10 for a ceiling.
  ["Burnet|M-2|side_ft", 10],
  // Burnet C-3 side: "15 ft single tenant, 25 ft multi-tenant".
  ["Burnet|C-3|side_ft", 25],
  // Burnet R-3: Ord. 2026-12 (4-20-26) amended this district's Chart 1 values, but Municode's OWN front
  // page also lists 2026-12 under "Adopted Ordinances Not Yet Codified" -- so it is unknown whether the
  // Chart 1 numbers as currently read already reflect that amendment or not. Marked edition-ambiguous
  // (a new, distinct refusal code) rather than verified-browser-read: the dimensional values below are
  // recorded as read for provenance, but the gate must refuse to serve them.
  ["Burnet|R-3|verification", "edition-ambiguous"],

  // --- Granite Shoals
  // M-2 side: chart value is "no side yard on one side, 12 ft on the other", but the SAME section's
  // notes (not the dimensional cell) add "20-foot side yard ... when M-2 borders a residential zone" --
  // the real most-restrictive number (20) lives outside the cell this script parses mechanically.
  ["Granite Shoals|M-2|side_ft", 20],
  // Industrial district I: "15/20 ft when adjacent to residential" (front), "none/12 ft/20 ft when
  // abutting residential" (side), "15/20 ft when abutting residential" (rear) -- most restrictive each.
  ["Granite Shoals|I|front_ft", 20],
  ["Granite Shoals|I|side_ft", 20],
  ["Granite Shoals|I|rear_ft", 20],
  // GB-1 / GB-2 rear: "none, except not less than 10 feet when rear lot line abuts ... residential" --
  // confirms the single number (10) is the one to record, since "none" has no digit of its own.
  ["Granite Shoals|GB-1|rear_ft", 10],
  ["Granite Shoals|GB-2|rear_ft", 10],

  // --- Bertram
  // R-1-A side: the dimensional cell reads "5 ft. (2)", but footnote (2) is explicit that the real rule
  // is "ten (10) feet on one side, and a zero lot line ... on the other" -- 5 is not even one of the two
  // real values. Recording the most restrictive real value (10), not the misleading chart cell.
  ["Bertram|R-1-A|side_ft", 10],

  // --- Highland Haven
  // R1 rear: three scenarios (waterfront 25 ft / through-lot 20 ft / back-to-back 25 ft) -- most
  // restrictive is 25.
  ["Highland Haven|R1|rear_ft", 25],
  // R1 side / corner: single real number, but the cell's "adjacent"/"of the side lot line adjacent to"
  // wording trips the conditional-language safety net -- confirming the plain reading (5, 10).
  ["Highland Haven|R1|side_ft", 5],
  ["Highland Haven|R1|corner_ft", 10],
  // R2 side: same "adjacent" wording as R1, same real value.
  ["Highland Haven|R2|side_ft", 5],
  // R2 rear: cell literally says "same as R1" (no digit at all) -- propagating R1's resolved rear value.
  ["Highland Haven|R2|rear_ft", 25],
]);

const csvText = readFileSync(CSV_PATH, "utf8");
const csvRows = parseCsv(csvText);

const { rows: newRows, reviewedLog } = convertRows({ csvRows, targetCities: TARGET_CITIES, resolutions: RESOLUTIONS, cityEdition: CITY_EDITION });

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
console.log(`Reviewed overrides applied (${reviewedLog.length}):`);
for (const e of reviewedLog) console.log(`  ${e.city} ${e.district} ${e.field} -> ${e.value}  (raw: ${e.raw})`);
