#!/usr/bin/env node
/**
 * Converts a groundtruth ordinance CSV (the W1-H / pack-C shape: one row per
 * city/district, with a verbatim edition line, a source URL and an access
 * date) into rows for `../src/local/setbacks/burnet-tx-ordinance-register.json`
 * (the `OrdinanceRegisterRow[]` consumed by `county-edition-currency.ts`).
 *
 * This is the conversion script the register's own header comment says should
 * exist ("look for a conversion script ... reuse or extend it") but did not,
 * when this script was written (2026-10-07, pack-C update): the original 117
 * rows were hand-assembled directly into JSON in the same commit that wrote
 * county-edition-currency.ts. This script exists so the NEXT register update
 * (another pack, another county) has one to extend instead of hand-editing
 * JSON again.
 *
 * WHY THIS CANNOT BE A PURE "COPY THE CELL" MACHINE CONVERSION, UNLIKE THE
 * ORIGINAL ONE: the original CSV (W1-H) had already-resolved numeric cells.
 * Pack C's groundtruth CSV sometimes states a dimensional value conditionally
 * ("20 ft. for any road over 31 feet of pavement. 25 ft. for roads shorter
 * than 31 ft.") or lets a second, more restrictive number live only in the
 * row's footnote/notes columns rather than the dimensional cell itself
 * (Bertram R-1-A's side cell literally says "5 ft. (2)", but footnote (2)
 * says the true rule is 10 ft on one side / zero-lot-line on the other). A
 * mechanical "take the biggest number in the cell" parser would get both of
 * those wrong -- the first by including the road-width threshold (31) as if
 * it were a candidate setback, the second by missing the real number
 * entirely. Neither can be resolved by regex alone.
 *
 * So this script resolves what IS mechanical (CSV parsing, column mapping,
 * citation/edition/URL/access-date passthrough, "NOT SPECIFIED" detection, a
 * footnote-only cell like "(9)", a cell with exactly one unambiguous number
 * and no conditional language) automatically, and REQUIRES an explicit,
 * reviewed entry in `resolutions` for every other cell -- it throws, naming
 * the city/district/field and the raw text, rather than ever guessing. Every
 * entry actually used by a run is listed in that run's console output, which
 * is also the source for the PR body's "conditional rows" list.
 *
 * Usage (library): import { parseCsv, convertRows } and call with the
 * pack's rows, a `resolutions` Map and a `cityEdition` table -- see
 * apply-packC-to-burnet-register.mjs for the real call.
 */
import { readFileSync } from "node:fs";

/* ------------------------------- CSV parsing ------------------------------- */

/** Minimal RFC4180 parser: handles quoted fields, embedded commas, "" escapes. No embedded newlines inside a field (not present in this source). */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const rows = lines.map(parseCsvLine);
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = cells[i] ?? ""));
    return obj;
  });
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

/* ------------------------------ cell resolution ----------------------------- */

const WORD_NUMBERS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
  twentyfive: 25,
  thirty: 30,
  "thirty-five": 35,
  thirtyfive: 35,
  forty: 40,
  "forty-five": 45,
  fortyfive: 45,
  fifty: 50,
};

/** Language that marks a cell as conditional even when only one number is mechanically found in it (the OTHER value lives in wording this regex catches, e.g. "...on one sideline and a 12-foot side yard on the other"). Deliberately broad: a false positive just means one more cell needs a reviewed confirmation entry, which is cheap; a false negative means a condition ships unreviewed, which is the defect this script exists to prevent. */
const CONDITIONAL_RE =
  /\bexcept\b|\bwhen\b|\bunless\b|\babutting\b|\badjacent\b|\bper unit\b|\btenant\b|\bpavement\b|\bconnected units?\b|\bother\b|\bsame as\b|\bfor (two|three|four|roads?|structures?)\b/i;

/**
 * Extracts every distinct number out of a cell's text: digit runs (treating a
 * trailing "½" as +0.5), and any whole number-word from WORD_NUMBERS. Strips
 * parenthetical digit markers like "(20)" or "(2)" first, so a footnote
 * reference is never miscounted as a second candidate number (a word-form
 * duplicate elsewhere in the same cell, e.g. "twenty (20)", still resolves
 * via the word).
 */
export function extractNumbers(text) {
  const t = text.replace(/\(\d+\)/g, " ");
  const found = new Set();
  const digitRe = /(\d+(?:\.\d+)?)(½)?/g;
  let m;
  while ((m = digitRe.exec(t))) {
    let n = parseFloat(m[1]);
    if (m[2]) n += 0.5;
    found.add(n);
  }
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(t)) found.add(n);
  }
  return [...found];
}

export function isNotSpecified(text) {
  const t = text.trim();
  return /^NOT SPECIFIED\b/i.test(t) || t === "" || t.toLowerCase() === "n/a";
}

export function isFootnoteOnly(text) {
  return /^\(\d+\)$/.test(text.trim());
}

const FIELD_LABELS = ["front_ft", "side_ft", "rear_ft", "corner_ft"];

/**
 * Resolves one dimensional cell.
 *
 * Priority, highest first:
 *   1. A `conditionalCells` entry for this city/district/field -> the cell's
 *      single value genuinely depends on a condition this pipeline cannot
 *      evaluate today (road width, unit/tenant count, abutting-zone, which
 *      physical side of the lot, ...). No number is recorded -- WDLL check 8
 *      ("zero wrong values") forbids serving one branch's number as if it
 *      were the rule, since it would be wrong for every parcel on the other
 *      branch. The raw text (every branch, verbatim) is carried on the
 *      result for the caller to put in a structured `conditional` field.
 *   2. An explicit `resolutions` entry for this city/district/field always
 *      wins (and is always recorded as a reviewed override in notes) --
 *      this is how a cell the conditional-language safety net flagged, but
 *      which this agent confirmed on reading has only ONE real value (e.g.
 *      "within five (5) feet of the ADJACENT lot line" -- "adjacent" trips
 *      the safety net, but there is no second branch), gets confirmed
 *      instead of needlessly refused.
 *   3. "NOT SPECIFIED" / empty / "n/a" -> no value.
 *   4. A bare parenthetical footnote marker, e.g. "(9)" -> deferred to
 *      another district's base-use table, not a number at all.
 *   5. Conditional language, or more than one distinct number -> THROWS
 *      unless `conditionalCells` or `resolutions` already covered it above
 *      (one of them must -- this is the forcing function that makes every
 *      conditional cell an explicit, reviewed, named decision).
 *   6. Exactly one number -> used directly, no review needed.
 */
export function resolveCell({ city, districtCode, field, text, resolutions, conditionalCells }) {
  const key = `${city}|${districtCode}|${field}`;

  if (conditionalCells.has(key)) {
    return { value: "", conditional: true, condition: conditionalCells.get(key), reviewed: false, deferred: false, raw: text };
  }
  if (resolutions.has(key)) {
    return { value: String(resolutions.get(key)), conditional: false, reviewed: true, deferred: false, raw: text };
  }
  if (isNotSpecified(text)) return { value: "", conditional: false, reviewed: false, deferred: false, raw: text };
  if (isFootnoteOnly(text)) return { value: "", conditional: false, reviewed: false, deferred: true, raw: text };

  const numbers = extractNumbers(text);
  const conditionalLanguage = CONDITIONAL_RE.test(text);

  if (conditionalLanguage || numbers.length > 1) {
    throw new Error(
      `resolveCell: "${key}" needs a reviewed conditionalCells or resolutions entry -- raw text "${text}" is conditional=${conditionalLanguage}, candidate numbers=[${numbers.join(", ")}]. Add it to CONDITIONAL_CELLS (if it is a genuine unevaluated condition) or RESOLUTIONS (if review confirms a single real value).`
    );
  }
  if (numbers.length === 1) {
    return { value: String(numbers[0]), conditional: false, reviewed: false, deferred: false, raw: text };
  }
  throw new Error(`resolveCell: no number found in "${text}" for "${key}" -- add a resolutions entry.`);
}

/* --------------------------------- convert ---------------------------------- */

export function convertRows({ csvRows, targetCities, resolutions, conditionalCells, cityEdition }) {
  const out = [];
  const reviewedLog = [];
  const conditionalLog = [];

  for (const r of csvRows) {
    if (!targetCities.includes(r.city)) continue;

    const cellInputs = [
      ["front_ft", r.front_ft],
      ["side_ft", r.side_ft],
      ["rear_ft", r.rear_ft],
      ["corner_ft", r.corner_or_street_side_ft],
    ];
    const resolved = cellInputs.map(([field, text]) =>
      resolveCell({ city: r.city, districtCode: r.district_code, field, text, resolutions, conditionalCells })
    );
    const [front, side, rear, corner] = resolved;

    const allEmpty = resolved.every((c) => c.value === "" && !c.deferred && !c.conditional);

    const edition = cityEdition[r.city];
    if (!edition) throw new Error(`convertRows: no cityEdition entry for "${r.city}"`);

    const reviewedNotes = [];
    const deferredNotes = [];
    const conditionalFields = {};
    resolved.forEach((c, i) => {
      const field = FIELD_LABELS[i];
      if (c.conditional) {
        conditionalFields[field] = c.raw;
        conditionalLog.push({ city: r.city, district: r.district_code, field, condition: c.condition, raw: c.raw });
      }
      if (c.reviewed) {
        const note = `${field} recorded as ${c.value || "(none)"} (reviewed override, confirmed single value) -- raw ordinance text: "${c.raw}".`;
        reviewedNotes.push(note);
        reviewedLog.push({ city: r.city, district: r.district_code, field, value: c.value, raw: c.raw });
      }
      if (c.deferred) {
        deferredNotes.push(`${field} is a footnote reference ("${c.raw}"), not a number -- see footnotes_verbatim.`);
      }
    });

    const noteParts = [];
    if (r.footnotes_verbatim && !isNotSpecified(r.footnotes_verbatim)) noteParts.push(`Footnotes: ${r.footnotes_verbatim}`);
    if (Object.keys(conditionalFields).length) {
      const parts = Object.entries(conditionalFields).map(
        ([field, raw]) => `${field} [${conditionalCells.get(`${r.city}|${r.district_code}|${field}`)}] -- raw ordinance text: "${raw}"`
      );
      noteParts.push(`CONDITIONAL (not evaluated; see SETBACK_CONDITIONAL_NOT_EVALUATED): ${parts.join(" ")}`);
    }
    if (reviewedNotes.length) noteParts.push(`REVIEWED OVERRIDE: ${reviewedNotes.join(" ")}`);
    if (deferredNotes.length) noteParts.push(`DEFERRED TO BASE-USE DISTRICT: ${deferredNotes.join(" ")}`);
    if (r.notes) noteParts.push(r.notes);
    if (r.adopting_or_amending_ordinance) noteParts.push(`Ordinance history: ${r.adopting_or_amending_ordinance}`);

    let verification = "verified-browser-read";
    const forcedVerification = resolutions.get(`${r.city}|${r.district_code}|verification`);
    if (forcedVerification) {
      verification = forcedVerification;
      reviewedLog.push({ city: r.city, district: r.district_code, field: "verification", value: forcedVerification, raw: "(forced)" });
    } else if (Object.keys(conditionalFields).length) {
      // GATE IS PER DISTRICT, NOT PER FIELD: the real numeric SetbackDistrict type (index.ts) requires
      // front_ft/side_ft/rear_ft/side_corner_ft to ALL be numbers -- there is no partial table to serve
      // even when 3 of 4 cells are clean. So one conditional cell refuses the whole district, the same
      // way one unverified/ambiguous/no-dimensional cell already does. The clean cells KEEP their
      // resolved numbers in this JSON (for provenance and so a future per-field gate costs no re-work),
      // but the row-level verification refuses the district today regardless.
      verification = "conditional-not-evaluated";
    } else if (allEmpty) {
      verification = "no-dimensional-standards";
      noteParts.unshift(
        "NO DIMENSIONAL STANDARDS: this district's zoning text carries no front/side/rear/corner numbers at all (verified-browser-read confirms the absence, not a failure to read)."
      );
    }

    out.push({
      city: r.city,
      district_code: r.district_code,
      district_name: r.district_name,
      front_ft: front.value,
      side_ft: side.value,
      rear_ft: rear.value,
      corner_ft: corner.value,
      citation: r.section_citation,
      ordinance: edition.ordinance,
      effective_date: edition.effectiveDate,
      verification,
      edition_line_verbatim: r.edition_line_verbatim,
      source_url: r.page_url,
      access_date: r.access_date,
      ...(Object.keys(conditionalFields).length ? { conditional: conditionalFields } : {}),
      notes: noteParts.join(" | "),
    });
  }
  return { rows: out, reviewedLog, conditionalLog };
}

// CLI entry point (debugging aid: prints the first few parsed CSV rows)
if (import.meta.url === `file://${process.argv[1]}`) {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("usage: node convert-ordinance-register-csv.mjs <csv-path>");
    process.exit(1);
  }
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
}
