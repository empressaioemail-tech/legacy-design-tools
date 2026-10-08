/**
 * GATE 2 (audit section 5.2, WDLL section 4.1) -- SOURCE REGISTER AND EDITION CURRENCY.
 *
 * THE DEFECT THIS CLOSES (P5, "stale or superseded sources served as current"). Bastrop setbacks
 * were served from a repealed ordinance (B3 / 2019-51, repealed 2026-04-14) twice -- once through
 * the card, once through a freshness gate on the PDFs. The fix that landed
 * (`bastrop-setback-currency.ts`, `isStaleBastropCitySetbackRule`) is real, but it is a BASTROP
 * BLOCKLIST: a hard-coded jurisdiction-key set and a hard-coded repealed-DID-marker list. The
 * 2026-10-07 pipeline audit (section 3, pattern P5) re-confirmed today: "the general edition-currency
 * gate (R16), 'owed before national', is still a Bastrop-specific blocklist," and Burnet is outside
 * every scope list that mechanism touches -- so nothing today stops Burnet's six provisional/
 * unverified ordinance rows (see the register) from being served as if they were current law.
 *
 * WHAT THIS MODULE IS. A GENERALIZED check: given a city and a district code, look up a
 * machine-readable ORDINANCE REGISTER (one row per city/district, carrying the edition, its
 * effective date, its citation and its verification state) and refuse with a named code when the
 * edition is unverified, unregistered, or superseded. It does not replace Bastrop's R13 mechanism
 * (`bastrop-setback-currency.ts`), which stays as the city's own established control; it is the
 * GENERAL FORM the audit asked for, applied today to the register that exists (Burnet's eight
 * cities, seeded from W1-H's 2026-10-07 research) and written so that a second county's register can
 * be added the same way without a second copy of this logic (DEV_PROCESS 2.4).
 *
 * THE REGISTER: `./burnet-tx-ordinance-register.json`. Originally 117 rows converted verbatim from
 * `doc_repo/_inbox/2026-10-07_burnet_W1H_setbacks.csv` (W1-H's own research artifact). As of
 * 2026-10-07 (pack C, P5 continuation), the Burnet, Granite Shoals, Cottonwood Shores, Bertram and
 * Highland Haven rows were REPLACED (and, for Burnet, which W1-H left entirely blank, newly added --
 * all 27 Chart 1 districts) with rows converted from
 * `doc_repo/_inbox/2026-10-07_burnet_B3_groundtruth_browser_packC.csv`, a person-paced honest browser
 * read that copied each code's own edition line verbatim; see
 * `../scripts/convert-ordinance-register-csv.mjs` and `../scripts/apply-packC-to-burnet-register.mjs`
 * for the (reusable) conversion. Meadowlakes was also refreshed from pack C, confirming its chapter
 * has no dimensional numbers at all. Marble Falls and Horseshoe Bay are untouched by pack C. The
 * `verification` column's vocabulary, as of pack C:
 *   "transcribed" / "verified-browser-read" / "source: city GIS layer ..." -- USABLE (cleared, though
 *       not ordinance-verified for the GIS-sourced Horseshoe Bay numbers specifically -- see the CSV's
 *       own notes column).
 *   "provisional-*" (ua-spoofed / proxy-bypassed) -- NOT USABLE. Reached through a bot-block
 *       workaround the honest-access rule forbids relying on; "needs honest re-source" in every row.
 *   "unverified" -- NOT USABLE. No access method reached a number at all for that district.
 *   "edition-ambiguous" -- NOT USABLE. The row's own source is internally inconsistent about which
 *       edition is current (Burnet R-3 only -- see SETBACK_EDITION_AMBIGUOUS).
 *   "no-dimensional-standards" -- NOT USABLE. The row's zoning text was read and confirmed to have no
 *       dimensional numbers for this district (Meadowlakes' eight districts; Granite Shoals AG;
 *       Highland Haven A and B -- see SETBACK_NO_DIMENSIONAL_STANDARDS).
 *   "conditional-not-evaluated" -- NOT USABLE. At least one dimensional field's value genuinely
 *       depends on a condition this pipeline cannot evaluate today -- road pavement width, unit or
 *       tenant count, abutting-zone, which physical side of the lot, lot position relative to a lake
 *       (21 cells across Burnet, Granite Shoals, Bertram and Highland Haven -- see
 *       SETBACK_CONDITIONAL_NOT_EVALUATED). The ordinance's own text for every branch is carried
 *       verbatim in the row's `conditional` map; no branch's number is ever recorded as THE value
 *       (WDLL check 8, "zero wrong values": the most-restrictive branch would be wrong for every
 *       parcel on the other branch).
 *
 * NAMED REFUSALS:
 *   SETBACK_EDITION_CURRENT     -- the only pass.
 *   SETBACK_SOURCE_NOT_REGISTERED -- the city, or the city's district, has no register row at all.
 *   SETBACK_EDITION_UNVERIFIED  -- the row exists but its verification state is not cleared
 *                                  (provisional-* or unverified).
 *   SETBACK_EDITION_SUPERSEDED  -- the row's edition predates a KNOWN supersession cutoff (the
 *                                  Bastrop B3/2026-04-14 shape, generalized: see
 *                                  SUPERSEDED_ORDINANCE_EDITIONS).
 *   SETBACK_EDITION_AMBIGUOUS   -- the row's own source cannot say which edition is current.
 *   SETBACK_NO_DIMENSIONAL_STANDARDS -- the row's zoning text has no numbers for this district.
 *   SETBACK_CONDITIONAL_NOT_EVALUATED -- at least one of the row's dimensional values has more than
 *                                  one real number and this pipeline cannot pick between them.
 *
 * Executes: wired into `getSetbackTableForZoning` (./index.ts) for Burnet's eight city jurisdiction
 * keys, ahead of the generic SETBACK_TABLES lookup -- see that file's own comment at the call site.
 */
import register from "./burnet-tx-ordinance-register.json" with { type: "json" };

export const SETBACK_EDITION_CURRENT = "SETBACK_EDITION_CURRENT";
export const SETBACK_SOURCE_NOT_REGISTERED = "SETBACK_SOURCE_NOT_REGISTERED";
export const SETBACK_EDITION_UNVERIFIED = "SETBACK_EDITION_UNVERIFIED";
export const SETBACK_EDITION_SUPERSEDED = "SETBACK_EDITION_SUPERSEDED";
/**
 * The row's own edition is internally inconsistent about whether a later ordinance is already
 * reflected in it (the Burnet R-3 shape: Ord. 2026-12 amended R-3's Chart 1, and the history note
 * says that amendment IS in the codified text, but Municode's own front page ALSO lists 2026-12 under
 * "Adopted Ordinances Not Yet Codified" -- so a verified-browser-read of the SAME page cannot say
 * which Chart 1 numbers are actually current). Distinct from UNVERIFIED (nobody read it) and from
 * SUPERSEDED (a known cutoff date proves the edition read is simply the wrong, older one): here the
 * edition WAS read, and the ambiguity is about currency, not about access.
 */
export const SETBACK_EDITION_AMBIGUOUS = "SETBACK_EDITION_AMBIGUOUS";
/**
 * The row's own zoning text was read and confirmed to carry no dimensional numbers for this district
 * at all (the Meadowlakes Ch. 32 shape: only use statements and nonconforming-structure rules).
 * Distinct from UNVERIFIED (which means "unread" or "read via a disallowed access method"): refusing
 * here is not a provenance problem, it is that inventing a number where the ordinance states none
 * would itself be the P5 defect this gate exists to prevent.
 */
export const SETBACK_NO_DIMENSIONAL_STANDARDS = "SETBACK_NO_DIMENSIONAL_STANDARDS";
/**
 * At least one of the row's dimensional fields (front_ft/side_ft/rear_ft/corner_ft) has no single
 * value: the ordinance states two or more branches (road pavement width, unit or tenant count,
 * abutting-zone, which physical side of the lot, lot position relative to a lake...) and this pipeline
 * has no data today to evaluate which branch applies to a given parcel. WDLL check 8 ("zero wrong
 * values") forbids recording the most-restrictive branch as THE setback: that number would be wrong
 * for every parcel where the OTHER branch applies. Distinct from NO_DIMENSIONAL_STANDARDS (the
 * ordinance states no number at all, for ANY parcel) and from UNVERIFIED (nobody read it): here the
 * ordinance was read, and it states MULTIPLE real numbers, not zero. The gate is per DISTRICT, not per
 * field -- see the row's own `conditional` map and the comment at this code's only throw site
 * (`checkSetbackEditionCurrency`) for why a district with 3 clean fields and 1 conditional field still
 * refuses as a whole.
 */
export const SETBACK_CONDITIONAL_NOT_EVALUATED = "SETBACK_CONDITIONAL_NOT_EVALUATED";

export interface OrdinanceRegisterRow {
  city: string;
  district_code: string;
  district_name: string;
  front_ft: string;
  side_ft: string;
  rear_ft: string;
  corner_ft: string;
  citation: string;
  ordinance: string;
  effective_date: string;
  verification: string;
  notes: string;
  /** The edition's own citation line, copied verbatim from the source (e.g. Municode/eCode360's "Codified through Ordinance No. ..." banner). Optional: older rows (W1-H) predate this field. */
  edition_line_verbatim?: string;
  /** The page this row was read from. Optional for the same reason. */
  source_url?: string;
  /** The date (YYYY-MM-DD) the page was read. Optional for the same reason. */
  access_date?: string;
  /**
   * Present only when `verification` is "conditional-not-evaluated". Maps each AFFECTED dimensional
   * field name (front_ft/side_ft/rear_ft/corner_ft) to the ordinance's own raw text for that cell,
   * verbatim and including every branch (e.g. "20 ft. for any road over 31 feet of pavement. 25 ft.
   * for roads shorter than 31 ft."). That field's own string value (e.g. `front_ft`) is always "" when
   * it has an entry here -- the raw text is the record of what the ordinance says, never a collapsed
   * single number. A row can have this on only SOME of its four fields; the other, clean fields keep
   * their resolved numbers here for provenance even though the district as a whole still refuses today.
   */
  conditional?: Record<string, string>;
}

export type EditionCurrencyCode =
  | typeof SETBACK_EDITION_CURRENT
  | typeof SETBACK_SOURCE_NOT_REGISTERED
  | typeof SETBACK_EDITION_UNVERIFIED
  | typeof SETBACK_EDITION_SUPERSEDED
  | typeof SETBACK_EDITION_AMBIGUOUS
  | typeof SETBACK_NO_DIMENSIONAL_STANDARDS
  | typeof SETBACK_CONDITIONAL_NOT_EVALUATED;

export interface EditionCurrencyVerdict {
  verdict: "pass" | "fail";
  code: EditionCurrencyCode;
  city: string;
  districtCode: string | null;
  detail: string;
  ordinance: string | null;
  effectiveDate: string | null;
  citation: string | null;
  verification: string | null;
}

/**
 * Edition cutoffs KNOWN to be superseded -- the generalized form of Bastrop's own
 * `REPEALED_ATOM_DID_MARKERS` (bastrop-setback-currency.ts), keyed by city rather than hard-coded
 * into one jurisdiction's module. Each entry names the cutoff date and its source, so a register row
 * whose `effective_date` is BEFORE the cutoff refuses even if its `verification` state would
 * otherwise clear -- an accurately-transcribed repealed ordinance is still the wrong law (the exact
 * Bastrop B3/2019-51 shape).
 */
export const SUPERSEDED_ORDINANCE_EDITIONS: Readonly<Record<string, { supersededBefore: string; reason: string }>> = Object.freeze({
  "granite shoals": {
    supersededBefore: "2025-12-09",
    reason:
      'Chapter 40 (zoning) "was amended and replaced with similar provisions by Ordinance 885 adopted 12/9/2025" (W1-H research, 2026-10-07, section 4). Any edition dated or effective before 2025-12-09 is the repealed former Chapter 40, the WDLL 4.1 break-test case for this gate.',
  },
});

function normalizeCity(s: string): string {
  return s.trim().toLowerCase();
}

function normalizeDistrict(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether a register row's `verification` value clears the gate. "n/a" (MOR, LA, UNK -- documented
 * non-dimensional GIS labels, not adopted districts) and "unverified" are NOT usable; neither is any
 * "provisional-*" state (a bot-block or UA-spoof workaround, per the honest-access rule), nor
 * "edition-ambiguous" (the edition was read, but it is unclear which numbers are current -- see
 * SETBACK_EDITION_AMBIGUOUS) nor "no-dimensional-standards" (the edition was read and confirmed to
 * have no numbers for this district -- see SETBACK_NO_DIMENSIONAL_STANDARDS) nor
 * "conditional-not-evaluated" (the edition was read and states MULTIPLE numbers this pipeline cannot
 * choose between -- see SETBACK_CONDITIONAL_NOT_EVALUATED). Everything else --
 * "transcribed", "verified-browser-read", or the GIS-layer-sourced note for Horseshoe Bay -- clears.
 */
export function isUsableVerification(verification: string | null | undefined): boolean {
  const v = (verification ?? "").trim().toLowerCase();
  if (!v || v === "unverified" || v === "n/a") return false;
  if (v.startsWith("provisional")) return false;
  if (v === "edition-ambiguous" || v === "no-dimensional-standards" || v === "conditional-not-evaluated") return false;
  return true;
}

function findRow(rows: OrdinanceRegisterRow[], city: string, districtCode?: string | null): OrdinanceRegisterRow | undefined {
  const cityRows = rows.filter((r) => normalizeCity(r.city) === normalizeCity(city));
  if (cityRows.length === 0) return undefined;
  if (!districtCode) return cityRows[0];
  const wanted = normalizeDistrict(districtCode);
  return (
    cityRows.find((r) => normalizeDistrict(r.district_code) === wanted) ??
    cityRows.find((r) => normalizeDistrict(r.district_name) === wanted)
  );
}

/**
 * THE CHECK. Looks up `city`/`districtCode` in `opts.register` (defaults to the Burnet register),
 * and returns a verdict naming exactly which of the four states applies. Pure: takes the register as
 * data, so a second county's register can be checked with the same function and a test can supply a
 * synthetic register without touching the real file.
 */
export function checkSetbackEditionCurrency(opts: {
  city: string;
  districtCode?: string | null;
  register?: OrdinanceRegisterRow[];
}): EditionCurrencyVerdict {
  const rows = opts.register ?? (register as unknown as OrdinanceRegisterRow[]);
  const cityHasAnyRow = rows.some((r) => normalizeCity(r.city) === normalizeCity(opts.city));
  if (!cityHasAnyRow) {
    return {
      verdict: "fail",
      code: SETBACK_SOURCE_NOT_REGISTERED,
      city: opts.city,
      districtCode: opts.districtCode ?? null,
      detail: `no ordinance register row exists for "${opts.city}": a setback cannot be served for a city this register has never recorded (gate 2, audit section 5.2).`,
      ordinance: null,
      effectiveDate: null,
      citation: null,
      verification: null,
    };
  }

  const row = findRow(rows, opts.city, opts.districtCode);
  if (!row) {
    return {
      verdict: "fail",
      code: SETBACK_SOURCE_NOT_REGISTERED,
      city: opts.city,
      districtCode: opts.districtCode ?? null,
      detail: `"${opts.city}" is registered, but has no row for district "${opts.districtCode}".`,
      ordinance: null,
      effectiveDate: null,
      citation: null,
      verification: null,
    };
  }

  const supersede = SUPERSEDED_ORDINANCE_EDITIONS[normalizeCity(opts.city)];
  if (supersede && row.effective_date && row.effective_date < supersede.supersededBefore) {
    return {
      verdict: "fail",
      code: SETBACK_EDITION_SUPERSEDED,
      city: opts.city,
      districtCode: row.district_code,
      detail: `${opts.city}'s cited edition (${row.ordinance || "unnamed"}, effective ${row.effective_date}) predates the ${supersede.supersededBefore} supersession cutoff: ${supersede.reason}`,
      ordinance: row.ordinance || null,
      effectiveDate: row.effective_date || null,
      citation: row.citation || null,
      verification: row.verification || null,
    };
  }

  if (!isUsableVerification(row.verification)) {
    const v = (row.verification ?? "").trim().toLowerCase();
    if (v === "edition-ambiguous") {
      return {
        verdict: "fail",
        code: SETBACK_EDITION_AMBIGUOUS,
        city: opts.city,
        districtCode: row.district_code,
        detail: `${opts.city} ${row.district_code} is edition-ambiguous: its own source is internally inconsistent about which edition is current -- ${row.notes || "see register notes"}. The gate refuses rather than guess which numbers are the law today.`,
        ordinance: row.ordinance || null,
        effectiveDate: row.effective_date || null,
        citation: row.citation || null,
        verification: row.verification || null,
      };
    }
    if (v === "no-dimensional-standards") {
      return {
        verdict: "fail",
        code: SETBACK_NO_DIMENSIONAL_STANDARDS,
        city: opts.city,
        districtCode: row.district_code,
        detail: `${opts.city} ${row.district_code}'s zoning text was read and carries no dimensional (front/side/rear/corner) numbers at all -- serving a number here would invent one the ordinance does not state.`,
        ordinance: row.ordinance || null,
        effectiveDate: row.effective_date || null,
        citation: row.citation || null,
        verification: row.verification || null,
      };
    }
    if (v === "conditional-not-evaluated") {
      // GATE IS PER DISTRICT, NOT PER FIELD. index.ts's SetbackDistrict requires front_ft/side_ft/
      // rear_ft/side_corner_ft to ALL be real numbers -- there is no partial table to serve even when
      // only one of this row's four dimensional fields is conditional, so the whole district refuses.
      // The detail below names EVERY affected field and carries its raw ordinance text (every branch),
      // so a caller can render "20 ft or 25 ft depending on road width" instead of a bare refusal.
      const branches = Object.entries(row.conditional ?? {})
        .map(([field, text]) => `${field}: "${text}"`)
        .join("; ");
      return {
        verdict: "fail",
        code: SETBACK_CONDITIONAL_NOT_EVALUATED,
        city: opts.city,
        districtCode: row.district_code,
        detail: `${opts.city} ${row.district_code} has at least one dimensional value this pipeline cannot evaluate today, because the ordinance states more than one number and nothing resolves which applies to a given parcel -- ${branches || "see register notes"}. Recording the most-restrictive branch as THE setback would be wrong for every parcel where the other branch applies (WDLL check 8, zero wrong values), so no number is served.`,
        ordinance: row.ordinance || null,
        effectiveDate: row.effective_date || null,
        citation: row.citation || null,
        verification: row.verification || null,
      };
    }
    return {
      verdict: "fail",
      code: SETBACK_EDITION_UNVERIFIED,
      city: opts.city,
      districtCode: row.district_code,
      detail: `${opts.city} ${row.district_code}'s register row carries verification "${row.verification}" -- not a cleared state, so this gate refuses to serve it rather than treat an unread or bot-block-bypassed source as current law (WDLL section 4.1, gate 2).`,
      ordinance: row.ordinance || null,
      effectiveDate: row.effective_date || null,
      citation: row.citation || null,
      verification: row.verification || null,
    };
  }

  return {
    verdict: "pass",
    code: SETBACK_EDITION_CURRENT,
    city: opts.city,
    districtCode: row.district_code,
    detail: `${opts.city} ${row.district_code} cites ${row.ordinance || "an unnamed edition"}${row.effective_date ? ` (effective ${row.effective_date})` : ""}, verification "${row.verification}".`,
    ordinance: row.ordinance || null,
    effectiveDate: row.effective_date || null,
    citation: row.citation || null,
    verification: row.verification || null,
  };
}

/** The register, as loaded. Exported for the gate 1 register-reading tooling and for tests. */
export function burnetOrdinanceRegister(): OrdinanceRegisterRow[] {
  return register as unknown as OrdinanceRegisterRow[];
}

/** The eight Burnet city jurisdiction keys this gate is wired for (see index.ts). */
export const BURNET_CITY_JURISDICTION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "bertram-tx": "Bertram",
  "burnet-tx": "Burnet",
  "cottonwood-shores-tx": "Cottonwood Shores",
  "granite-shoals-tx": "Granite Shoals",
  "highland-haven-tx": "Highland Haven",
  "horseshoe-bay-tx": "Horseshoe Bay",
  "marble-falls-tx": "Marble Falls",
  "meadowlakes-tx": "Meadowlakes",
});
