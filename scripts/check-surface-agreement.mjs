#!/usr/bin/env node
/**
 * Gate 7 — surface agreement (Phase-0 audit section 5 gate 7; WDLL checks 2-13).
 *
 * WHAT THIS CLOSES. Audit P1 ("done declared before the customer could see it"): "No check
 * that card, PDF and connector agree." Audit P2 ("checks that could not fail"): the Phase 0
 * customer probe "has no cross-surface agreement check". Audit P7 ("one fact derived in
 * several places"): "The card, PDF and connector disagree on setbacks, buildable percentage,
 * ETJ and special district. The PDF composer reads a different store." — and the clearest
 * single instance named in the audit: flood not drawing on the map was "fixed" four times
 * (P-459/P-459b/P-459c), each proof built on a harness using made-up data that ran in no CI
 * job (audit section 4). This file is the "the proof is the real customer route" instrument
 * the audit asks for in response.
 *
 * THE FOUR SURFACES (WDLL section 3, "Surfaces agree", check 12):
 *   - card:  legacy-design-tools artifacts/api-server's `/research/brief` route
 *            (assembleNodeBriefBody, propertyExplorer.ts:204-497).
 *   - pdf:   the Feasibility Study PDF (hauska-engine-api `/v1/property-nodes/:id/
 *            feasibility-export`, proxied by smartsite-mcp's export_instrument /
 *            feasibility-export.ts). A DIFFERENT composition path from the card (audit P7).
 *   - map:   hauska-map's property-explorer BFF, which composes several rails DIRECTLY from
 *            hauska-engine retrieval-api's `/property-nodes/:id/record` ledger-cell read
 *            (hauska-map apps/property-explorer/api/_lib/pe-record-to-facets.ts, read on
 *            origin/main 2026-10-07) -- a THIRD path, independently re-implementing the same
 *            translation legacy-design-tools' own `<rail>FactFromParcelRecord.ts` files apply
 *            to the identical cell (that module's own doc comment: "vendoring choice, not a
 *            rewrite"). Three independently-maintained copies of one fact is exactly P7.
 *   - mcp:   smartsite-mcp's get_smart_site / run_report, which calls
 *            `normalizeR1BodyForExternal` (tool-honesty.ts) on the SAME cortex `/research/
 *            brief` body the card route reads -- this file calls that REAL function (see
 *            `scripts/gate7-mcp-local-transform.mts`), not a re-implementation of it, so an
 *            MCP-specific transform bug is caught by running the real code, not by guessing
 *            at its shape.
 *
 * WHAT IT CHECKS (WDLL section 3, checks 2-11, one row per field group):
 *   address, city/unincorporated, county, appraisal values + tax year, structural facts,
 *   zoning district, setbacks, buildable envelope, flood, school/special district.
 * For each, every surface that has an opinion must agree (check 12), and a field one surface
 * shows while another surface has no representation of it at all is ALSO a failure (also
 * check 12 — "a field one surface shows and another hides is a failure"). It also enforces
 * check 13 (no internal words reach the customer) over every surface's raw served text.
 *
 * NAMED REFUSAL CODES (never a bare warning):
 *   GATE7_BASE_URL_REQUIRED            -- a surface's base URL was not given (see below)
 *   GATE7_PRODUCTION_BASE_URL_REFUSED  -- a surface's base URL is a known production host
 *   GATE7_SURFACE_FIELD_DISAGREEMENT   -- two surfaces both have an opinion and disagree
 *   GATE7_SURFACE_FIELD_HIDDEN         -- one surface shows a field another has no concept of
 *   GATE7_INTERNAL_WORD_LEAKED         -- an internal word/decline code/diagnostic reached a
 *                                          surface's served payload (WDLL check 13)
 *
 * MEASUREMENT IS READ-ONLY, AND NEVER DEFAULTS TO PRODUCTION (WDLL section 4.5; the
 * 2026-10-07 incident is why, and the audit names a second, separate incident of the same
 * SHAPE: "a read-only census run against the production route preceded an outage", r14b/
 * A-334). There is NO built-in default for any of --card-base-url / --pdf-base-url /
 * --map-base-url / --mcp-base-url anywhere in this file: every run must name them, and a
 * run that omits one refuses GATE7_BASE_URL_REQUIRED for THAT surface rather than silently
 * comparing three of four. `assertNotProductionBaseUrl` additionally refuses a short, named
 * list of hosts this session has directly observed hard-coded as production fallbacks
 * elsewhere in this codebase (e.g. hauska-map `apps/property-explorer/api/spine.ts`'s own
 * `process.env.CORTEX_API_URL?.trim() || 'https://cortex-api-...-uc.a.run.app'`). That list
 * is defense in depth, not the guarantee -- the guarantee is that every base URL is REQUIRED,
 * with no fallback value anywhere in this file.
 *
 * PDF TEXT DECODING (2026-10-07 revision). `decodeAllContentStreams` / `assertPdfTextReadable`
 * below are VENDORED, byte-for-byte, from hauska-engine's own `decode-pdf-text.ts` (the
 * decoder hauska-engine already uses to verify its own PDF output is really readable, read on
 * hauska-engine origin/main). `extractPdfFields` now accepts either an already-structured
 * field object (a fixture, still the supported path for the break test below) OR raw PDF
 * bytes; `fetchPdfSurface`'s HTTP leg downloads bytes and decodes them for real.
 *
 * `assertPdfTextReadable` refuses `GATE7_PDF_UNREADABLE` when the PDF draws text (real `Tj`
 * operators) but decodes to zero characters -- the signature of pdf-lib's StandardFonts
 * (Helvetica etc.), which carry NO ToUnicode CMap at all (only a fully fontkit-embedded font
 * does). Treating that empty text as "this surface has nothing to say" would let an unreadable
 * PDF "agree" with every other surface's honest absence by coincidence, which is exactly the
 * P2 "check that could not fail" pattern applied to gate 7 itself -- so it is a refusal, never
 * a silent pass. Proven against two REAL PDFs built by two REAL composers (not two fixtures
 * describing the same thing twice): a pdf-lib StandardFonts page (the broken shape) and
 * hauska-engine's own `emitPdfFloodDrainage` pure-function output (a real, fontkit-embedded,
 * decodable page) -- see this PR's body for both results.
 *
 * Field extraction from READABLE text (`extractPdfFieldsFromText`) is a small set of
 * best-effort regexes against hauska-engine's feasibility-report narrative labels -- a
 * feasibility PDF is prose, not JSON, so this is explicitly narrower and less certain than the
 * other three extractors, and is stated as such rather than oversold.
 *
 * NOT DONE: generating hauska-engine's actual Feasibility Study PDF for a real parcel. That
 * needs either hauska-engine-api's own service (DB, object storage, RETRIEVAL_API_KEY-class
 * credentials this sandbox does not have) or hand-building a `ParcelReportModel` from
 * low-level Atom Instance types (`SetbackRuleAtomInstance`, DEM grids, ...) that do not map
 * from the JSON facts shape the other three surfaces share -- attempting that quickly risked
 * fabricating atom data rather than reading it, so it was not attempted. Named, not silent.
 *
 * SELFTEST (`--selftest`), same convention as `check-cross-repo-literal-drift.mjs` and the
 * `ss-w16-tier2-flood-not-served` CI gate: every refusal code is driven on a fixture that
 * SHOULD trip it and a fixture that should NOT, in both directions, before this file is
 * trusted against anything real. A predicate observed only passing has not been observed
 * working.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export const EXIT = { PASS: 0, FAIL: 1, REFUSE: 2, USAGE: 3 };

export const CODES = Object.freeze({
  BASE_URL_REQUIRED: "GATE7_BASE_URL_REQUIRED",
  PRODUCTION_BASE_URL_REFUSED: "GATE7_PRODUCTION_BASE_URL_REFUSED",
  FIELD_DISAGREEMENT: "GATE7_SURFACE_FIELD_DISAGREEMENT",
  FIELD_HIDDEN: "GATE7_SURFACE_FIELD_HIDDEN",
  INTERNAL_WORD_LEAKED: "GATE7_INTERNAL_WORD_LEAKED",
  PDF_UNREADABLE: "GATE7_PDF_UNREADABLE",
});

export const SURFACES = Object.freeze(["card", "pdf", "map", "mcp"]);

/** WDLL section 3, checks 2-11. `id` is this file's own key into a surface's field map. */
export const WDLL_CHECKS = Object.freeze([
  { id: "address", wdll: 2, label: "Address" },
  { id: "city", wdll: 3, label: "City / unincorporated" },
  { id: "county", wdll: 4, label: "County" },
  { id: "values", wdll: 5, label: "Appraisal values and tax year" },
  { id: "structural", wdll: 6, label: "Structural facts" },
  { id: "zoning", wdll: 7, label: "Zoning district" },
  { id: "setbacks", wdll: 8, label: "Setbacks" },
  { id: "envelope", wdll: 9, label: "Buildable envelope" },
  { id: "flood", wdll: 10, label: "Flood" },
  { id: "schoolSpecialDistrict", wdll: 11, label: "School / special district" },
]);

function refusal(code, message, detail = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, detail);
  return err;
}

/* ============================================================== base URLs */

/**
 * Known production hosts this session directly observed hard-coded as a fallback elsewhere
 * in this codebase. See the header: this is defense in depth, not the guarantee.
 */
export const KNOWN_PRODUCTION_HOSTS = Object.freeze([
  // hauska-map apps/property-explorer/api/spine.ts, read on origin/main 2026-10-07:
  // `process.env.CORTEX_API_URL?.trim() || 'https://cortex-api-tds7av26va-uc.a.run.app'`
  "cortex-api-tds7av26va-uc.a.run.app",
]);

/**
 * Requires a non-empty base URL for `surface`, refuses a known production host, and
 * normalises away a trailing slash. Never supplies a default: the caller passing no value
 * for `rawUrl` is exactly the "forgot to say where to read from" case this exists to catch.
 */
export function assertNotProductionBaseUrl(surface, rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw refusal(
      CODES.BASE_URL_REQUIRED,
      `${surface} base URL is required; gate 7 never defaults to production (2026-10-07 incident; audit r14b/A-334)`,
      { surface },
    );
  }
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    host = rawUrl.trim().toLowerCase();
  }
  if (KNOWN_PRODUCTION_HOSTS.includes(host)) {
    throw refusal(
      CODES.PRODUCTION_BASE_URL_REFUSED,
      `${surface} base URL "${rawUrl}" is a known production host; gate 7 measurement is read-only against a local build or a replica, never production`,
      { surface, host },
    );
  }
  return rawUrl.replace(/\/+$/, "");
}

/* ======================================================= internal words (check 13) */

/**
 * The WDLL's own literal list (section 3, check 13), plus the precedents found in this
 * repo's own tests rather than a single pre-existing consolidated word-list constant: no
 * such constant was found despite a repo-wide search (see this PR's body). The closest
 * precedents are per-field regex assertions --
 * `artifacts/api-server/src/lib/cityLimitsFactFromParcelRecord.test.ts` ("unaccounted maps
 * to unmeasured, never a fabricated ... determination"), `p445ReadCoherence.test.ts`
 * (`not.toMatch(/unmeasured/)`), `parcelRecordCellRead.test.ts` (same) -- and the
 * self-testing CI methodology (`ss-w16-tier2-flood-not-served`, `l5-silent-fallback-greps`
 * in `.github/workflows/pr-checks.yml`): three outcomes (clean / violation / DID-NOT-RUN),
 * never a pass-on-absence, and a predicate driven against a fixture that MUST violate it
 * and one that must NOT before it is trusted. This check reuses that methodology
 * (`--selftest` below) since no literal word-list constant existed to import.
 *
 * Deliberately EXCLUDES the MCP's own deliberate, DECLARED customer-facing vocabulary
 * (`upgrade_required`, `studio-gated`, `parcel_not_found`, `record_retired`, and every
 * token in `@empressaio/atom-contract/display`'s `VOCABULARY` table) -- those are the
 * honest, documented, human-readable-paired codes this product uses ON PURPOSE to tell a
 * customer what state a field is in. Flagging them would not be enforcing honesty, it would
 * be punishing it. What this flags is INTERNAL pipeline jargon that has no display-text
 * pairing and no reason to ever reach a customer: a writer/ledger rail code, a bare decline
 * code, or a stack frame.
 */
export const INTERNAL_WORDS = Object.freeze(["unmeasured", "unaccounted", "[object Object]"]);

/**
 * Raw internal decline/rail codes: the writer-lease, coverage-gate and rail-ledger
 * vocabulary from `hauska-factory` (`RAIL_*`, `LEASE_HELD`, `COVERAGE_UNMEASURED`,
 * `BAKE_STALE_AT_PUBLISH`, `*_REQUIRED`/`*_REFUSED` factory refusal codes) and this file's
 * own gate-7 codes -- none of these have a customer-facing display string anywhere in the
 * product, unlike the MCP's declared vocabulary excluded above.
 */
export const DECLINE_CODE_PATTERN =
  /\b(RAIL_[A-Z_]+|LEASE_HELD|COVERAGE_UNMEASURED|BAKE_STALE_AT_PUBLISH|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:REQUIRED|REFUSED|INVALID|FAILED))\b/;

/** A stack frame, a bundler path, or a raw thrown-error name -- never a customer sentence. */
export const ENGINE_DIAGNOSTIC_PATTERN =
  /(\bat\s+[\w$.<>]+\s+\([^)]*:\d+:\d+\)|\.(?:ts|mjs|cjs|js):\d+(?::\d+)?\b|node_modules[\\/]|(?:Type|Reference|Syntax|Range)Error:)/;

/** Every hit, with its kind and position, over one surface's raw served text. Never a boolean: a position is evidence a reader can go look at. */
export function scanForInternalWords(text) {
  const hits = [];
  if (typeof text !== "string" || text.length === 0) return hits;
  for (const word of INTERNAL_WORDS) {
    let idx = text.indexOf(word);
    while (idx !== -1) {
      hits.push({ kind: "internal-word", word, index: idx });
      idx = text.indexOf(word, idx + word.length);
    }
  }
  const declineMatch = text.match(DECLINE_CODE_PATTERN);
  if (declineMatch) hits.push({ kind: "decline-code", word: declineMatch[0], index: declineMatch.index });
  const diagMatch = text.match(ENGINE_DIAGNOSTIC_PATTERN);
  if (diagMatch) hits.push({ kind: "engine-diagnostic", word: diagMatch[0], index: diagMatch.index });
  return hits;
}

/** One refusal per surface with any hit, naming every hit found (never just the first). */
export function checkInternalWordsAcrossSurfaces(parcelId, rawTextBySurface) {
  const refusals = [];
  for (const surface of SURFACES) {
    const text = rawTextBySurface[surface];
    const hits = scanForInternalWords(text);
    if (hits.length > 0) {
      refusals.push(
        refusal(CODES.INTERNAL_WORD_LEAKED, `${surface} served text for ${parcelId} carries an internal word (WDLL check 13)`, {
          parcelId,
          surface,
          hits,
        }),
      );
    }
  }
  return refusals;
}

/* ================================================================ value canonicalisation */

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Deep, order-independent, tolerant-of-float-noise canonical form for comparing one field's value across surfaces. */
export function canonicalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? round(value, 2) : null;
  if (typeof value === "string") return value.trim().toUpperCase();
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonicalizeValue(value[key]);
      if (v !== null) out[key] = v;
    }
    return out;
  }
  return value;
}

/** A field read is `{ state, value }`. `state` is part of the comparison: "present" with value X is not the same claim as "refused" even if some reader defaulted X in both. */
export function canonicalFieldKey(read) {
  return JSON.stringify({ state: read?.state ?? null, value: canonicalizeValue(read?.value ?? null) });
}

/* ================================================================ the comparator */

/**
 * `bySurface` is `{ card, pdf, map, mcp }`, each a field map `{ [checkId]: FieldRead |
 * undefined }`. `undefined` means this surface's payload has NO REPRESENTATION of this WDLL
 * check at all (the "hides" case); a `FieldRead` of `{ state: "absent"|"refused", value:
 * null }` is a DECLARED absence, which is a legitimate, comparable answer -- so a surface
 * that honestly says "not on file" while another shows a real value is a genuine
 * disagreement (`FIELD_DISAGREEMENT`), not merely a hidden field.
 */
export function compareSurfaces(parcelId, bySurface, { surfaces = SURFACES } = {}) {
  const refusals = [];
  for (const check of WDLL_CHECKS) {
    const reads = surfaces.map((surface) => ({ surface, read: bySurface[surface]?.[check.id] }));
    const represented = reads.filter((r) => r.read !== undefined);
    if (represented.length <= 1) continue; // nothing to compare this check against

    const notRepresented = reads.filter((r) => r.read === undefined);
    const anyPresent = represented.some((r) => r.read.state === "present");
    if (anyPresent && notRepresented.length > 0) {
      refusals.push(
        refusal(CODES.FIELD_HIDDEN, `${check.label} (WDLL check ${check.wdll}) is shown by some surfaces and absent from others' payload entirely`, {
          parcelId,
          checkId: check.id,
          wdll: check.wdll,
          shownBy: represented.filter((r) => r.read.state === "present").map((r) => r.surface),
          hiddenBy: notRepresented.map((r) => r.surface),
        }),
      );
      continue;
    }

    const keyed = represented.map((r) => ({ surface: r.surface, key: canonicalFieldKey(r.read) }));
    const distinct = new Set(keyed.map((k) => k.key));
    if (distinct.size > 1) {
      refusals.push(
        refusal(CODES.FIELD_DISAGREEMENT, `${check.label} (WDLL check ${check.wdll}) disagrees across surfaces for ${parcelId}`, {
          parcelId,
          checkId: check.id,
          wdll: check.wdll,
          bySurface: Object.fromEntries(represented.map((r) => [r.surface, r.read])),
        }),
      );
    }
  }
  return { ok: refusals.length === 0, refusals };
}

/* ================================================================ extractors */

function presentOrUndefined(hasValue, value) {
  return hasValue ? { state: "present", value } : undefined;
}

function declaredAbsence(state, basis) {
  return { state, value: null, basis: basis ?? null };
}

/**
 * Shared by `card` and `mcp`: both read a `brief.sections[]` + root-field shape that
 * ultimately comes from the SAME cortex `/research/brief` body (propertyExplorer.ts
 * `assembleNodeBriefBody`, 204-497; tool-honesty.ts `normalizeR1BodyForExternal` transforms
 * that same object for the MCP wire without changing this overall shape). The MCP caller
 * applies that real transform FIRST (see `scripts/gate7-mcp-local-transform.mts` and
 * `fetchMcpFields` below) and passes the result through this same extractor, so a
 * transform-introduced disagreement is caught by running the real function, not by this
 * extractor guessing at two different shapes.
 *
 * Tolerant of the plain TIER-1 BAKE shape too (`facets.base` / `baseFacts` / `zoning` /
 * `envelope` at the object root, with no `brief.sections`) -- the shape stored directly in
 * `place_layer_snapshots` before the live per-rail merges in `assembleNodeBriefBody` run.
 * Checks this file cannot read off the bake alone (city limits, flood, school/special
 * district -- all live per-rail reads, not baked) come back `undefined` (not represented)
 * rather than guessed, which the comparator above already treats as a real, named gap
 * (`FIELD_HIDDEN`) when another surface DOES carry them -- never a silent pass.
 */
export function extractBriefLikeFields(rawObj) {
  if (!rawObj || typeof rawObj !== "object") return {};
  // GET /api/brokerage/v1/place/node/:id/facets (brokerageNodeFacets.ts, confirmed live
  // 2026-10-07 against a local build) wraps the tier-1 bake under its OWN `facets` key, with
  // the live per-rail facts (floodHazardFact, cityLimitsFact, schoolDistrictFact, ownerFact,
  // valueHistoryFact, setbackRulesFact, ...) at the OUTER top level beside it -- a SECOND,
  // independently-shaped envelope for conceptually the same read `assembleNodeBriefBody`
  // (propertyExplorer.ts) puts everything at one top level for. Flattened here (inner bake
  // first, outer live facts win on any name collision) so one extractor reads either shape;
  // this is itself a live instance of audit P7 inside ONE repo, not just across repos.
  const obj =
    rawObj.facets && typeof rawObj.facets === "object" && ("baseFacts" in rawObj.facets || "countyFips" in rawObj.facets)
      ? { ...rawObj.facets, ...rawObj }
      : rawObj;
  const baseFacts = obj.baseFacts ?? obj.facets?.base ?? {};
  const facetsBase = obj.facets?.base ?? {};
  const onRecord = obj.onRecord ?? {};
  const sections = Array.isArray(obj.brief?.sections) ? obj.brief.sections : [];
  const sectionById = Object.fromEntries(sections.filter((s) => s && typeof s === "object" && s.id).map((s) => [s.id, s]));

  const fields = {};

  const address = baseFacts.situsAddress ?? facetsBase.situsAddress ?? onRecord.situsAddress ?? null;
  fields.address = presentOrUndefined(address != null && address !== "", address);

  // WDLL 2.1 "mailing city vs city limits": `baseFacts.situsCity` / `postalCity` is the
  // MAILING label, never jurisdiction. The city/unincorporated check (3) is `cityLimitsFact`
  // (containment), which is a live read this file has no bake-shape fallback for -- reading
  // `situsCity` here would be exactly the P2-juris defect class the WDLL names.
  const cityLimits = obj.cityLimitsFact;
  if (cityLimits && typeof cityLimits === "object") {
    // Confirmed live 2026-10-07: cityLimitsFact carries `status`, not the `state` key every
    // other FactRead in this response uses (floodHazardFact, schoolDistrictFact, ...) --
    // itself a small instance of "one concept, two vocabularies" worth flagging on its own,
    // not papered over by silently defaulting to one or the other.
    const disposition = cityLimits.state ?? cityLimits.status;
    if (disposition === "present") {
      fields.city = { state: "present", value: { jurisdiction: cityLimits.jurisdiction ?? null, vintage: cityLimits.vintage ?? null } };
    } else if (disposition) {
      fields.city = declaredAbsence(disposition, cityLimits.reason ?? cityLimits.basis ?? null);
    }
  }

  const countyFips = obj.countyFips ?? null;
  fields.county = presentOrUndefined(countyFips != null, countyFips);

  const cadRoll = baseFacts.cadRoll ?? onRecord.cadRoll;
  if (cadRoll && typeof cadRoll === "object") {
    const vals = {};
    for (const key of ["marketValue", "assessedValue", "landValue", "improvementValue"]) {
      const entry = cadRoll[key];
      if (entry && typeof entry === "object") {
        if ("v" in entry) vals[key] = { v: entry.v, vintage: entry.vintage ?? null, valueBasis: entry.valueBasis ?? null };
        else if (entry.state) vals[key] = { refused: entry.state };
      } else if (entry === null) {
        vals[key] = null;
      }
    }
    if (Object.keys(vals).length > 0) fields.values = { state: "present", value: vals };
  }

  const yearBuilt = baseFacts.yearBuilt?.v ?? obj.structuralFact?.yearBuilt ?? null;
  const livingArea = baseFacts.cadRoll?.livingAreaSqft ?? obj.structuralFact?.livingAreaSqft ?? null;
  if (yearBuilt != null || livingArea != null || obj.structuralFact) {
    fields.structural = { state: "present", value: { yearBuilt, livingAreaSqft: livingArea } };
  }

  if (obj.zoning === null && baseFacts.landUse) {
    fields.zoning = declaredAbsence("absent", "no-zoning-stamp");
  } else if (obj.zoning && typeof obj.zoning === "object") {
    fields.zoning = { state: "present", value: { district: obj.zoning.district ?? null, jurisdictionKey: obj.zoning.jurisdictionKey ?? null } };
  } else if (sectionById.zoning) {
    const s = sectionById.zoning;
    fields.zoning = s.disposition === "present" ? { state: "present", value: s.data } : declaredAbsence(s.disposition, s.reason ?? null);
  }

  const setbackRules = obj.setbackRulesFact;
  if (setbackRules && typeof setbackRules === "object") {
    fields.setbacks =
      setbackRules.state === "present"
        ? { state: "present", value: setbackRules.value ?? setbackRules.setbacks ?? null }
        : declaredAbsence(setbackRules.state, setbackRules.reason ?? null);
  } else if (sectionById["setbacks-envelope"]) {
    const s = sectionById["setbacks-envelope"];
    if (s.data?.setbacks) fields.setbacks = { state: "present", value: s.data.setbacks };
  }

  const envelope = obj.envelope;
  if (envelope && typeof envelope === "object") {
    fields.envelope =
      envelope.status === "declined"
        ? declaredAbsence("refused", envelope.declineReason ?? null)
        : { state: "present", value: { buildableAreaSqFt: envelope.buildableAreaSqFt ?? null, buildableAreaPct: envelope.buildableAreaPct ?? null } };
  }

  const flood = obj.floodHazardFact ?? obj.parcelRecordFloodFact;
  if (flood && typeof flood === "object") {
    fields.flood =
      flood.state === "present"
        ? { state: "present", value: { zone: flood.zone ?? null, sfha: flood.sfha ?? flood.sfhaFlag ?? null } }
        : declaredAbsence(flood.state ?? "absent", flood.reason ?? null);
  } else if (sectionById.flood) {
    const s = sectionById.flood;
    fields.flood = s.disposition === "present" ? { state: "present", value: s.data } : declaredAbsence(s.disposition, s.reason ?? null);
  }

  const school = obj.schoolDistrictFact;
  const specialDistrict = obj.specialDistrictFact;
  if (school || specialDistrict) {
    fields.schoolSpecialDistrict = {
      state: "present",
      value: {
        schoolDistrict: school?.state === "present" ? school.value ?? school.district ?? null : null,
        specialDistrict: specialDistrict?.state === "present" ? specialDistrict.value ?? null : null,
      },
    };
  }

  return fields;
}

export function extractCardFields(cardJson) {
  return extractBriefLikeFields(cardJson);
}

/** Applied to the output of the REAL `normalizeR1BodyForExternal` (see fetchMcpFields). */
export function extractMcpFields(normalizedMcpJson) {
  return extractBriefLikeFields(normalizedMcpJson);
}

/**
 * hauska-map's `ParcelRecordResponse.rails` shape (apps/property-explorer/api/_lib/
 * pe-record-to-facets.ts, read on origin/main 2026-10-07): `{ [railKey]: { cell, gate,
 * serve, atom, rendering, companions } }`, plus the zoning/setback OVERRIDE keys
 * (`COMPOSED_ZONING_SETBACK_RAIL_KEYS`) carried at the top level of the composed patch. A
 * rail whose `serve` is not `"record"` carries no cell this module composed (the caller's
 * existing atom-chain/cortex-merge value stands instead, which this extractor cannot see
 * from this response alone -- represented as `undefined`, never guessed).
 */
export function extractMapFields(mapJson) {
  if (!mapJson || typeof mapJson !== "object") return {};
  // Confirmed live 2026-10-07 (handlePropertyAtomsFacets, pe-property-atoms.ts, invoked
  // directly against a local cortex build, PROPERTY_ATOM_PATH unset): when the retrieval-api
  // atom chain is disabled, hauska-map's OWN documented "instant rollback" path
  // (atomEnabled=false) serves the cortex facets body nearly verbatim -- same shape
  // `extractBriefLikeFields` already reads, stripped of envelope (`stripCortexEnvelopeProductTruth`,
  // marked by the `cortexEnvelopeRetired` key this path adds). Reused here rather than a
  // second parser for what is, on THIS path, the identical shape; the atom-chain-ENABLED
  // shape below (`rails`) is a genuinely different composition this repo could not exercise
  // without a RETRIEVAL_API_KEY this sandbox does not have (see this PR's body).
  if (mapJson.rails === undefined && (mapJson.facets || mapJson.floodHazardFact || "cortexEnvelopeRetired" in mapJson)) {
    return extractBriefLikeFields(mapJson);
  }
  const rails = mapJson.rails && typeof mapJson.rails === "object" ? mapJson.rails : {};
  const fields = {};

  const railValue = (key) => {
    const rail = rails[key];
    if (!rail || rail.serve !== "record") return undefined;
    return rail.cell && typeof rail.cell === "object" ? rail.cell : null;
  };

  const situsCity = railValue("situsCity");
  const situsZip = railValue("situsZip");
  const situsState = railValue("situsState");
  if (situsCity !== undefined || situsZip !== undefined || situsState !== undefined) {
    fields.address = mapJson.situsAddress != null ? { state: "present", value: mapJson.situsAddress } : undefined;
  }

  const cityLimits = railValue("cityLimits");
  if (cityLimits !== undefined) {
    fields.city = cityLimits
      ? { state: "present", value: { jurisdiction: cityLimits.jurisdiction ?? cityLimits.value ?? null, vintage: cityLimits.vintage ?? null } }
      : declaredAbsence("absent", null);
  }

  fields.county = presentOrUndefined(mapJson.countyFips != null, mapJson.countyFips);

  const flood = railValue("flood");
  if (flood !== undefined) {
    fields.flood = flood ? { state: "present", value: { zone: flood.zone ?? null, sfha: flood.sfha ?? flood.sfhaFlag ?? null } } : declaredAbsence("absent", null);
  }

  const school = railValue("schoolDistrict");
  const specialDistricts = railValue("specialDistricts");
  if (school !== undefined || specialDistricts !== undefined) {
    fields.schoolSpecialDistrict = { state: "present", value: { schoolDistrict: school?.value ?? school ?? null, specialDistrict: specialDistricts?.value ?? specialDistricts ?? null } };
  }

  const livingArea = railValue("livingAreaSqft");
  const yearBuilt = railValue("yearBuilt");
  if (livingArea !== undefined || yearBuilt !== undefined) {
    fields.structural = { state: "present", value: { yearBuilt: yearBuilt?.value ?? yearBuilt ?? null, livingAreaSqft: livingArea?.value ?? livingArea ?? null } };
  }

  if (mapJson.zoningDistrict !== undefined) {
    fields.zoning = mapJson.zoningDistrict
      ? { state: "present", value: { district: mapJson.zoningDistrict, jurisdictionKey: mapJson.zoningJurisdictionKey ?? null } }
      : declaredAbsence("absent", null);
  }

  const setbackKeys = ["setbackFrontFt", "setbackSideFt", "setbackRearFt", "setbackCornerFt"];
  if (setbackKeys.some((k) => mapJson[k] !== undefined)) {
    fields.setbacks = { state: "present", value: Object.fromEntries(setbackKeys.map((k) => [k, mapJson[k] ?? null])) };
  }

  if (mapJson.envelope && typeof mapJson.envelope === "object") {
    fields.envelope = { state: "present", value: { buildableAreaSqFt: mapJson.envelope.buildableAreaSqFt ?? null, buildableAreaPct: mapJson.envelope.buildableAreaPct ?? null } };
  }

  const cadRoll = mapJson.cadRoll;
  if (cadRoll && typeof cadRoll === "object") {
    fields.values = { state: "present", value: cadRoll };
  }

  return fields;
}

/* ================================================================ PDF text decoding */

/**
 * Vendored, byte-for-byte, from hauska-engine `packages/engine-core/src/site-plan/pdf/
 * __tests__/decode-pdf-text.ts` (read on hauska-engine origin/main 2026-10-07) -- the SAME
 * decoder hauska-engine already uses to verify its own PDF output carries real, readable
 * text. Vendored rather than imported: this is a different repo (no workspace dependency),
 * same convention this codebase already uses for cross-repo reference (see
 * `check-cross-repo-literal-drift.mjs`'s own header on vendoring vs. importing). Kept
 * unmodified so a future upstream fix (or a future upstream regression) is a diff against
 * this exact block, not a silent drift.
 *
 * THE STANDARDFONTS FAILURE MODE THIS EXISTS TO CATCH. pdf-lib's built-in StandardFonts
 * (Helvetica, etc.) draw text as single-byte WinAnsi codes with NO embedded font and NO
 * ToUnicode CMap (`beginbfchar`/`endbfchar`) at all -- that CMap is what `buildGlyphToUnicode`
 * below reads, and it is only ever written for a FULLY EMBEDDED font (fontkit, `subset:
 * false`, matching this repo's own site-plan sheet). A StandardFonts PDF therefore has text
 * ON THE PAGE (real `Tj`/`TJ` show operators) that this decoder cannot map to ANY character
 * -- `remapOperand` returns `null` for every operand, `runs` stays empty, and the tight/
 * spaced reconstructions are both the empty string. That is NOT "the PDF has no text"; it is
 * "the PDF's font choice makes its text undecodable", and `assertPdfTextReadable` below is
 * the one place that tells those two apart and refuses rather than silently treating empty
 * decoded text as an absence this comparator could then "agree" with every other surface's
 * absence by coincidence -- the exact P2 "check that could not fail" shape applied to gate 7
 * itself.
 */
function buildGlyphToUnicode(inflatedStreams) {
  const map = new Map();
  const pairRe = /<([0-9A-Fa-f]{2,4})>\s*<([0-9A-Fa-f]+)>/g;
  for (const s of inflatedStreams) {
    if (!s.includes("beginbfchar")) continue;
    const blockRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let block;
    while ((block = blockRe.exec(s))) {
      let pair;
      pairRe.lastIndex = 0;
      while ((pair = pairRe.exec(block[1]))) {
        const code = pair[1].toUpperCase().padStart(4, "0");
        const uhex = pair[2];
        let chars = "";
        let allNull = true;
        for (let i = 0; i < uhex.length; i += 4) {
          const cp = parseInt(uhex.slice(i, i + 4), 16);
          if (cp !== 0) allNull = false;
          chars += String.fromCodePoint(cp);
        }
        if (!allNull && !map.has(code)) map.set(code, chars);
      }
    }
  }
  return map;
}

/** Vendored unchanged from decode-pdf-text.ts (see the block comment above). */
export function decodeAllContentStreams(pdfBytes) {
  const raw = Buffer.from(pdfBytes);
  const text = raw.toString("latin1");
  const streamRe = /(?<!end)stream\r?\n/g;
  let match;
  const decoded = [];
  let searchFloor = 0;
  while ((match = streamRe.exec(text))) {
    const startIndex = match.index + match[0].length;
    const dict = text.slice(searchFloor, match.index);
    const lengthMatches = [...dict.matchAll(/\/Length\s+(\d+)(?!\s+\d+\s+R)/g)];
    const lengthMatch = lengthMatches.length > 0 ? lengthMatches[lengthMatches.length - 1] : null;
    let endIndex;
    if (lengthMatch) {
      endIndex = startIndex + parseInt(lengthMatch[1], 10);
    } else {
      const naiveEnd = text.indexOf("endstream", startIndex);
      if (naiveEnd === -1) continue;
      let trimmed = naiveEnd;
      if (text[trimmed - 1] === "\n") trimmed--;
      if (text[trimmed - 1] === "\r") trimmed--;
      endIndex = trimmed;
    }
    const streamBytes = raw.subarray(startIndex, endIndex);
    try {
      decoded.push(inflateSync(streamBytes).toString("latin1"));
    } catch {
      decoded.push(streamBytes.toString("latin1"));
    }
    searchFloor = endIndex;
    streamRe.lastIndex = Math.max(streamRe.lastIndex, endIndex);
  }
  const glyphToUni = buildGlyphToUnicode(decoded);
  const joined = decoded.join("\n");

  const remapOperand = (hex) => {
    if (hex.length % 4 !== 0) return null;
    let out = "";
    let mapped = false;
    for (let i = 0; i < hex.length; i += 4) {
      const code = hex.slice(i, i + 4).toUpperCase();
      const ch = glyphToUni.get(code);
      if (ch !== undefined) {
        out += ch;
        mapped = true;
      } else {
        out += Buffer.from(code, "hex").toString("latin1");
      }
    }
    return mapped ? out : null;
  };

  const runs = [];
  const showRe = /<([0-9A-Fa-f]+)>\s*Tj/g;
  let showMatch;
  while ((showMatch = showRe.exec(joined))) {
    const remapped = remapOperand(showMatch[1]);
    if (remapped !== null) runs.push(remapped);
  }
  const tightJoin = runs.join("");
  const spacedJoin = runs.join(" ");
  const inlineRemap = joined.replace(/<([0-9A-Fa-f]+)>/g, (all, hex) => remapOperand(hex) ?? all);
  return { raw: joined, inlineRemap, tightJoin, spacedJoin, hasShowOperators: showRe.test(joined) || /<[0-9A-Fa-f]+>\s*Tj/.test(joined) };
}

/**
 * The gate-7 refusal. Throws GATE7_PDF_UNREADABLE when the PDF draws text (real `Tj`
 * operators exist) but not one of them decoded to a real character -- the StandardFonts/
 * no-ToUnicode-CMap signature described above. A PDF with genuinely no text content at all
 * (no `Tj` operators anywhere -- an image-only page, say) is a DIFFERENT, honestly-absent
 * case and is returned as empty text rather than refused: this function's job is to tell
 * "no text" and "undecodable text" apart, never to collapse them.
 */
export function assertPdfTextReadable(pdfBytes) {
  const decoded = decodeAllContentStreams(pdfBytes);
  const tight = decoded.tightJoin.trim();
  const spaced = decoded.spacedJoin.trim();
  if (decoded.hasShowOperators && tight === "" && spaced === "") {
    throw refusal(
      CODES.PDF_UNREADABLE,
      "the PDF draws text (Tj operators present) but zero characters decoded -- consistent with pdf-lib StandardFonts carrying no ToUnicode CMap (fontkit embedding required); never treated as agreement or as an honest absence",
      { byteCount: pdfBytes.length ?? pdfBytes.byteLength },
    );
  }
  return decoded;
}

/**
 * PDF: see the header. Takes either an ALREADY-STRUCTURED field object (a fixture, or a
 * future richer decode step's JSON) OR raw PDF bytes (Uint8Array/Buffer) -- the real HTTP
 * leg (`fetchPdfSurface`) downloads bytes and passes them straight through here. Bytes are
 * run through `assertPdfTextReadable` FIRST (throws GATE7_PDF_UNREADABLE on the StandardFonts
 * failure mode); readable text is then scanned with a small set of best-effort, clearly
 * approximate field regexes -- a feasibility PDF is a narrative report, not structured JSON,
 * so this is deliberately narrower and less certain than the other three extractors, and
 * each regex is one field, not a claim to have solved PDF field extraction in general.
 */
export function extractPdfFields(structured) {
  if (structured instanceof Uint8Array || Buffer.isBuffer(structured)) {
    const decoded = assertPdfTextReadable(structured);
    const text = decoded.spacedJoin || decoded.tightJoin || decoded.inlineRemap;
    return extractPdfFieldsFromText(text);
  }
  if (!structured || typeof structured !== "object") return {};
  const fields = {};
  for (const check of WDLL_CHECKS) {
    if (check.id in structured) fields[check.id] = structured[check.id];
  }
  return fields;
}

/**
 * Best-effort, narrow, clearly-labeled regex extraction from DECODED, READABLE PDF text
 * (never called on text `assertPdfTextReadable` already refused). Each regex targets one
 * WDLL check's plain-English rendering in hauska-engine's feasibility report narrative
 * (`feasibility.ts`'s section labels, read 2026-10-07); a regex that finds nothing leaves
 * that check `undefined` (not represented) rather than guessing, which the comparator
 * already treats as a real, named gap when another surface does carry the field.
 */
export function extractPdfFieldsFromText(text) {
  const fields = {};
  if (typeof text !== "string" || text.trim() === "") return fields;

  const addr = /(?:Address|Site Address)\s*:?\s*([^\n]+)/i.exec(text);
  if (addr) fields.address = { state: "present", value: addr[1].trim() };

  const county = /County\s*:?\s*([A-Za-z .'-]+?)(?:,|\n|County\b)/i.exec(text);
  if (county) fields.county = { state: "present", value: county[1].trim() };

  const zoning = /Zoning District\s*:?\s*([A-Za-z0-9/.\- ]+)/i.exec(text);
  if (zoning) fields.zoning = { state: "present", value: { district: zoning[1].trim() } };

  const front = /Front(?: Setback)?\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)?/i.exec(text);
  const side = /Side(?: Setback)?\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)?/i.exec(text);
  const rear = /Rear(?: Setback)?\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)?/i.exec(text);
  const corner = /Corner(?: Setback)?\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)?/i.exec(text);
  if (front || side || rear || corner) {
    fields.setbacks = {
      state: "present",
      value: {
        setbackFrontFt: front ? Number(front[1]) : null,
        setbackSideFt: side ? Number(side[1]) : null,
        setbackRearFt: rear ? Number(rear[1]) : null,
        setbackCornerFt: corner ? Number(corner[1]) : null,
      },
    };
  }

  const floodZone = /Flood Zone\s*:?\s*([A-Za-z0-9]+)/i.exec(text);
  const sfha = /\b(?:SFHA|Special Flood Hazard Area)\b\s*:?\s*(Yes|No|True|False)/i.exec(text);
  if (floodZone || sfha) {
    fields.flood = {
      state: "present",
      value: {
        zone: floodZone ? floodZone[1].trim() : null,
        sfha: sfha ? /^(yes|true)$/i.test(sfha[1]) : null,
      },
    };
  }

  return fields;
}

/* ================================================================ fixtures / selftest */

function freshBastropGoldFixture() {
  const address = { state: "present", value: "908 PINE , BASTROP, TX 78602" };
  const city = { state: "present", value: { jurisdiction: "Bastrop", vintage: "2025-08" } };
  const county = { state: "present", value: "48021" };
  const values = { state: "present", value: { marketValue: { v: 226733, vintage: "2025" }, assessedValue: null, landValue: { v: 54572, vintage: "2025" }, improvementValue: { v: 172161, vintage: "2025" } } };
  const structural = { state: "present", value: { yearBuilt: 2002, livingAreaSqft: null } };
  const zoning = { state: "present", value: { district: "SF-1", jurisdictionKey: "bastrop-development-code" } };
  const setbacks = { state: "present", value: { setbackFrontFt: 25, setbackSideFt: 10, setbackRearFt: 20, setbackCornerFt: 15 } };
  const envelope = { state: "present", value: { buildableAreaSqFt: 6200, buildableAreaPct: 62.3 } };
  const flood = { state: "present", value: { zone: "X", sfha: false } };
  const schoolSpecialDistrict = { state: "present", value: { schoolDistrict: "Bastrop ISD", specialDistrict: null } };
  const common = { address, city, county, values, structural, zoning, setbacks, envelope, flood, schoolSpecialDistrict };
  return { card: { ...common }, mcp: { ...common }, map: { ...common }, pdf: { ...common } };
}

function assertThrowsCode(fn, code, label) {
  try {
    fn();
  } catch (err) {
    if (err.code === code) return;
    throw new Error(`${label}: expected code ${code}, got ${err.code ?? err.message}`);
  }
  throw new Error(`${label}: expected to throw ${code}, nothing thrown`);
}

function assertOk(cond, label) {
  if (!cond) throw new Error(`SELFTEST FAILED: ${label}`);
}

/**
 * Every code driven on a violating fixture AND a clean one, both directions, before this
 * file is trusted (the `ss-w16`/`check-cross-repo-literal-drift.mjs` convention). This is
 * also, literally, the WDLL 4.1 break test for gate 7: "make the PDF disagree with the
 * card... the check must refuse. Show that the test fails when the comparison is removed" --
 * see the paired mutation test in `scripts/__tests__/check-surface-agreement.selftest.test.mjs`,
 * which imports `compareSurfaces` directly and asserts it fails to catch the SAME fixture
 * when the disagreement branch is deleted.
 */
export function selftest() {
  let failures = 0;
  const check = (label, fn) => {
    try {
      fn();
      console.log(`ok - ${label}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL - ${label}: ${err.message}`);
    }
  };

  // base URL requiredness
  check("base URL required when absent", () => assertThrowsCode(() => assertNotProductionBaseUrl("card", undefined), CODES.BASE_URL_REQUIRED, "absent base url"));
  check("base URL required when empty string", () => assertThrowsCode(() => assertNotProductionBaseUrl("card", "   "), CODES.BASE_URL_REQUIRED, "blank base url"));
  check("a real-looking base URL is accepted", () => {
    const out = assertNotProductionBaseUrl("card", "https://cortex-staging.example.internal/");
    assertOk(out === "https://cortex-staging.example.internal", "trailing slash stripped");
  });
  check("a known production host is refused", () =>
    assertThrowsCode(() => assertNotProductionBaseUrl("map", "https://cortex-api-tds7av26va-uc.a.run.app"), CODES.PRODUCTION_BASE_URL_REFUSED, "known prod host"),
  );

  // internal words (WDLL check 13) -- clean and violating, every kind
  check("clean text produces no hits", () => assertOk(scanForInternalWords("The setback is 25 feet, per the 2026 ordinance.").length === 0, "clean text"));
  check("'unmeasured' is caught", () => assertOk(scanForInternalWords("upstreamStatus: unmeasured").length === 1, "unmeasured"));
  check("'unaccounted' is caught", () => assertOk(scanForInternalWords("kind: unaccounted").length === 1, "unaccounted"));
  check("'[object Object]' is caught", () => assertOk(scanForInternalWords("Owner: [object Object]").length === 1, "object Object"));
  check("a raw rail/factory decline code is caught", () => assertOk(scanForInternalWords("refused: RAIL_ZERO_EARNED_UNACCOUNTED").length === 1, "decline code"));
  check("an engine stack frame is caught", () => assertOk(scanForInternalWords("TypeError: x is not a function\n  at loadFloodHazardFactForServe (floodHazardFactRead.ts:42:11)").length >= 1, "engine diagnostic"));
  check("the MCP's own declared vocabulary is NOT flagged", () =>
    assertOk(scanForInternalWords('{"status":"refused","reason":"upgrade_required","tier":"studio-gated"}').length === 0, "declared vocabulary excluded"),
  );

  // PDF readability (GATE7_PDF_UNREADABLE) — minimal, dependency-free, hand-built PDF syntax
  // fragments so this selftest needs no pdf-lib/fontkit dependency, driven in BOTH directions.
  // Proven separately, against two REAL PDFs built by two real composers (a pdf-lib
  // StandardFonts page and hauska-engine's own emitPdfFloodDrainage output) -- see this PR's
  // body; not repeated here to keep --selftest fast and dependency-free.
  check("GATE 7: a PDF with real Tj operators but no ToUnicode CMap is refused GATE7_PDF_UNREADABLE", () => {
    const body = "<0041>Tj";
    const pdf = `/Length ${body.length} >>\nstream\n${body}\nendstream`;
    assertThrowsCode(() => assertPdfTextReadable(Buffer.from(pdf, "latin1")), CODES.PDF_UNREADABLE, "StandardFonts-shaped PDF");
  });
  check("a PDF whose font DOES carry a ToUnicode CMap decodes for real, not refused", () => {
    const cmapBody = "beginbfchar\n<0041> <0058>\nendbfchar";
    const cmapStream = `/Length ${cmapBody.length} >>\nstream\n${cmapBody}\nendstream`;
    const showBody = "<0041>Tj";
    const showStream = `/Length ${showBody.length} >>\nstream\n${showBody}\nendstream`;
    const decoded = assertPdfTextReadable(Buffer.from(`${cmapStream}\n${showStream}`, "latin1"));
    assertOk(decoded.tightJoin === "X", `expected the glyph to decode to X, got ${JSON.stringify(decoded.tightJoin)}`);
  });
  check("extractPdfFields on readable bytes runs the real text-field regexes", () => {
    const body = "Setback Front: 25 ft";
    // One operand, one glyph-per-char run via the WinAnsi-identity byte trick: map each byte
    // to itself through a synthetic bfchar block so this stays dependency-free.
    const hex = Buffer.from(body, "latin1").toString("hex").toUpperCase();
    const pairs = [...body].map((ch, i) => `<${i.toString(16).padStart(4, "0").toUpperCase()}> <${ch.codePointAt(0).toString(16).padStart(4, "0").toUpperCase()}>`).join("\n");
    const codes = [...body].map((_, i) => i.toString(16).padStart(4, "0").toUpperCase()).join("");
    const cmapBody = `beginbfchar\n${pairs}\nendbfchar`;
    const cmapStream = `/Length ${cmapBody.length} >>\nstream\n${cmapBody}\nendstream`;
    const showBody = `<${codes}>Tj`;
    const showStream = `/Length ${showBody.length} >>\nstream\n${showBody}\nendstream`;
    const fields = extractPdfFields(Buffer.from(`${cmapStream}\n${showStream}`, "latin1"));
    assertOk(fields.setbacks?.value?.setbackFrontFt === 25, `expected setbackFrontFt 25, got ${JSON.stringify(fields.setbacks)}`);
  });

  // compareSurfaces: agreement, disagreement, hidden — the actual break test
  const fresh = freshBastropGoldFixture();
  check("four agreeing surfaces produce zero refusals", () => {
    const { ok, refusals } = compareSurfaces("48021:34137", fresh);
    assertOk(ok && refusals.length === 0, `expected ok, got ${JSON.stringify(refusals)}`);
  });

  check("GATE 7 BREAK TEST: a PDF that disagrees with the card on one field is refused", () => {
    const broken = structuredClone(fresh);
    broken.pdf.setbacks = { state: "present", value: { setbackFrontFt: 15, setbackSideFt: 10, setbackRearFt: 20, setbackCornerFt: 15 } };
    const { ok, refusals } = compareSurfaces("48021:34137", broken);
    assertOk(!ok, "expected the comparator to refuse");
    const hit = refusals.find((r) => r.code === CODES.FIELD_DISAGREEMENT && r.checkId === "setbacks");
    assertOk(Boolean(hit), `expected a setbacks FIELD_DISAGREEMENT, got ${JSON.stringify(refusals)}`);
  });

  check("a field one surface shows and another's payload never carries at all is FIELD_HIDDEN, not silently skipped", () => {
    const partial = structuredClone(fresh);
    delete partial.map.flood;
    const { ok, refusals } = compareSurfaces("48021:34137", partial);
    assertOk(!ok, "expected the comparator to refuse");
    const hit = refusals.find((r) => r.code === CODES.FIELD_HIDDEN && r.checkId === "flood");
    assertOk(Boolean(hit) && hit.hiddenBy.includes("map"), `expected flood FIELD_HIDDEN naming map, got ${JSON.stringify(refusals)}`);
  });

  check("a surface honestly declaring absence while another shows a value is a real disagreement, not a pass", () => {
    const partial = structuredClone(fresh);
    partial.map.zoning = { state: "absent", value: null, basis: "no-zoning-stamp" };
    const { ok, refusals } = compareSurfaces("48021:34137", partial);
    assertOk(!ok, "expected the comparator to refuse");
    assertOk(Boolean(refusals.find((r) => r.code === CODES.FIELD_DISAGREEMENT && r.checkId === "zoning")), "expected a zoning FIELD_DISAGREEMENT");
  });

  check("a check only one surface represents is not compared at all (nothing to disagree with)", () => {
    const partial = { card: { address: fresh.card.address } };
    const { ok, refusals } = compareSurfaces("x", partial);
    assertOk(ok && refusals.length === 0, "a single-surface field is not a cross-surface claim");
  });

  // extractors against real-shaped fixtures
  check("extractCardFields reads the real assembleNodeBriefBody shape", () => {
    const f = extractCardFields({
      baseFacts: { situsAddress: "1 MAIN ST, BASTROP, TX" },
      countyFips: "48021",
      cityLimitsFact: { state: "present", jurisdiction: "Bastrop", vintage: "2025-08" },
      floodHazardFact: { state: "present", zone: "AE", sfha: true },
    });
    assertOk(f.address.value === "1 MAIN ST, BASTROP, TX", "address read from baseFacts");
    assertOk(f.city.value.jurisdiction === "Bastrop", "city read from cityLimitsFact, not postal city");
    assertOk(f.flood.value.zone === "AE" && f.flood.value.sfha === true, "flood read from floodHazardFact");
  });

  check("extractCardFields is tolerant of the plain tier-1 BAKE shape (no brief.sections)", () => {
    // Real baked rows (place_layer_snapshots, read live 2026-10-07) carry situsAddress on
    // BOTH facets.base and baseFacts identically; baseFacts is read first when both exist.
    const f = extractCardFields({
      facets: { base: { situsAddress: "2 OAK LN, BASTROP, TX" } },
      countyFips: "48021",
      zoning: null,
      baseFacts: { situsAddress: "2 OAK LN, BASTROP, TX", landUse: { code: "A1" } },
    });
    assertOk(f.address.value === "2 OAK LN, BASTROP, TX", "address read from the bare bake shape");
    assertOk(f.zoning.state === "absent", "a declined zoning stamp reads as a declared absence, not present-null");
    assertOk(f.city === undefined, "city limits are a live read the bake alone does not carry -- undefined, not guessed");
  });

  check("extractMapFields only reads a rail whose serve is 'record'", () => {
    const f = extractMapFields({ countyFips: "48021", rails: { flood: { serve: "record", cell: { zone: "X", sfha: false } }, cityLimits: { serve: "legacy-transitional" } } });
    assertOk(f.flood.value.zone === "X", "a record-served rail is read");
    assertOk(f.city === undefined, "a non-record-served rail is not represented, never guessed from the atom-chain path this response does not carry");
  });

  check("extractPdfFields passes a structured fixture through by WDLL check id only", () => {
    const f = extractPdfFields({ setbacks: { state: "present", value: { setbackFrontFt: 25 } }, notAWdllCheck: "ignored" });
    assertOk(f.setbacks.value.setbackFrontFt === 25, "setbacks carried through");
    assertOk(!("notAWdllCheck" in f), "an unknown key is dropped, not carried through as a false field");
  });

  if (failures > 0) {
    console.error(`${failures} selftest check(s) failed`);
    return EXIT.FAIL;
  }
  console.log("all selftest checks passed");
  return EXIT.PASS;
}

/* ================================================================ HTTP fetchers (live mode) */

export async function fetchJson(url, { headers = {} } = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null; caller sees the raw text for the internal-words scan either way
  }
  return { ok: res.ok, status: res.status, text, json };
}

export async function fetchCardSurface(baseUrl, parcelNodeId) {
  const base = assertNotProductionBaseUrl("card", baseUrl);
  const { text, json } = await fetchJson(`${base}/api/brokerage/v1/research/brief/${encodeURIComponent(parcelNodeId)}`);
  return { rawText: text, fields: extractCardFields(json) };
}

export async function fetchMapSurface(baseUrl, parcelNodeId) {
  const base = assertNotProductionBaseUrl("map", baseUrl);
  const { text, json } = await fetchJson(`${base}/api/pe-property-atoms?parcelNodeId=${encodeURIComponent(parcelNodeId)}`);
  return { rawText: text, fields: extractMapFields(json) };
}

/**
 * The MCP leg calls the real MCP tool over the Streamable HTTP transport
 * (`@modelcontextprotocol/sdk`, the same transport `artifacts/smartsite-mcp/src/app.ts`
 * mounts at POST /mcp) -- a genuine client call, not a re-implementation of the protocol.
 */
export async function fetchMcpSurface(baseUrl, parcelNodeId) {
  const base = assertNotProductionBaseUrl("mcp", baseUrl);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "gate7-surface-agreement", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "get_smart_site", arguments: { parcelNodeId, depth: "node" } });
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave null */
    }
    return { rawText: text, fields: extractMcpFields(json) };
  } finally {
    await client.close();
  }
}

/**
 * `--pdf-fields-fixture` still wins when given (a fixture is a deliberate stand-in, e.g. for
 * the break test). Otherwise the downloaded bytes are decoded for real:
 * `assertPdfTextReadable` throws GATE7_PDF_UNREADABLE on the StandardFonts/no-CMap failure
 * mode (see the decoder's own header) instead of this function silently reporting an empty
 * PDF as agreement.
 */
export async function fetchPdfSurface(baseUrl, parcelNodeId, { fieldsFixturePath } = {}) {
  const base = assertNotProductionBaseUrl("pdf", baseUrl);
  const downloadRes = await fetch(`${base}/v1/property-nodes/${encodeURIComponent(parcelNodeId)}/feasibility-export/download`);
  const bytes = Buffer.from(await downloadRes.arrayBuffer());
  if (fieldsFixturePath) {
    const structured = JSON.parse(readFileSync(fieldsFixturePath, "utf8"));
    return { rawText: JSON.stringify(structured), fields: extractPdfFields(structured) };
  }
  const decoded = assertPdfTextReadable(bytes);
  const text = decoded.spacedJoin || decoded.tightJoin || decoded.inlineRemap;
  return { rawText: text, fields: extractPdfFieldsFromText(text) };
}

/* ================================================================ CLI */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

async function runLive(args) {
  const parcelId = args.parcel;
  if (!parcelId) {
    console.error(JSON.stringify({ error: "--parcel <id> is required" }));
    process.exitCode = EXIT.USAGE;
    return;
  }

  const bySurface = {};
  const rawTextBySurface = {};

  const card = await fetchCardSurface(args["card-base-url"], parcelId);
  bySurface.card = card.fields;
  rawTextBySurface.card = card.rawText;

  const map = await fetchMapSurface(args["map-base-url"], parcelId);
  bySurface.map = map.fields;
  rawTextBySurface.map = map.rawText;

  const mcp = await fetchMcpSurface(args["mcp-base-url"], parcelId);
  bySurface.mcp = mcp.fields;
  rawTextBySurface.mcp = mcp.rawText;

  const pdf = await fetchPdfSurface(args["pdf-base-url"], parcelId, { fieldsFixturePath: args["pdf-fields-fixture"] });
  bySurface.pdf = pdf.fields;
  rawTextBySurface.pdf = pdf.rawText;

  const { ok, refusals } = compareSurfaces(parcelId, bySurface);
  const wordRefusals = checkInternalWordsAcrossSurfaces(parcelId, rawTextBySurface);
  const allRefusals = [...refusals, ...wordRefusals.map((e) => ({ code: e.code, message: e.message, ...e }))];

  console.log(JSON.stringify({ parcelId, ok: ok && wordRefusals.length === 0, refusals: allRefusals }, null, 2));
  process.exitCode = allRefusals.length > 0 ? EXIT.FAIL : EXIT.PASS;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    process.exitCode = selftest();
    return;
  }
  const args = parseArgs(argv);
  try {
    await runLive(args);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, code: err.code ?? null, ...err }, null, 2));
    process.exitCode = EXIT.REFUSE;
  }
}

if (process.argv[1] && process.argv[1].endsWith("check-surface-agreement.mjs")) {
  main();
}
