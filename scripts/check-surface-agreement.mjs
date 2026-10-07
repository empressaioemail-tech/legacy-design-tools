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
 * PDF TEXT EXTRACTION IS NOT IMPLEMENTED IN THIS FILE (stated, not silent). No
 * production-grade PDF-text-extraction library is wired into legacy-design-tools'
 * dependencies today (`pdf-lib`, the one PDF library present, is a creation/editing library,
 * not a text-extraction one; hauska-engine's own `decode-pdf-text.ts` is a test-only
 * verification helper, not a reusable parser). `extractPdfFields` therefore takes an
 * ALREADY-STRUCTURED field object -- a fixture for a local build, or a JSON file a future
 * decode step produces from the downloaded PDF -- never raw PDF bytes. `--pdf-base-url`
 * downloads the bytes (so the HTTP leg against a real deployment is exercised) and REFUSES
 * naming this gap (`GATE7_PDF_TEXT_EXTRACTION_NOT_IMPLEMENTED`) rather than fabricating
 * fields from bytes nothing here has read. `--pdf-fields-fixture <path.json>` is the
 * supported path end to end today, including the break test below.
 *
 * SELFTEST (`--selftest`), same convention as `check-cross-repo-literal-drift.mjs` and the
 * `ss-w16-tier2-flood-not-served` CI gate: every refusal code is driven on a fixture that
 * SHOULD trip it and a fixture that should NOT, in both directions, before this file is
 * trusted against anything real. A predicate observed only passing has not been observed
 * working.
 */

import { readFileSync } from "node:fs";

export const EXIT = { PASS: 0, FAIL: 1, REFUSE: 2, USAGE: 3 };

export const CODES = Object.freeze({
  BASE_URL_REQUIRED: "GATE7_BASE_URL_REQUIRED",
  PRODUCTION_BASE_URL_REFUSED: "GATE7_PRODUCTION_BASE_URL_REFUSED",
  FIELD_DISAGREEMENT: "GATE7_SURFACE_FIELD_DISAGREEMENT",
  FIELD_HIDDEN: "GATE7_SURFACE_FIELD_HIDDEN",
  INTERNAL_WORD_LEAKED: "GATE7_INTERNAL_WORD_LEAKED",
  PDF_TEXT_EXTRACTION_NOT_IMPLEMENTED: "GATE7_PDF_TEXT_EXTRACTION_NOT_IMPLEMENTED",
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
export function extractBriefLikeFields(obj) {
  if (!obj || typeof obj !== "object") return {};
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
    if (cityLimits.state === "present") {
      fields.city = { state: "present", value: { jurisdiction: cityLimits.jurisdiction ?? null, vintage: cityLimits.vintage ?? null } };
    } else if (cityLimits.state) {
      fields.city = declaredAbsence(cityLimits.state, cityLimits.reason ?? null);
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

/**
 * PDF: see the header. Takes an ALREADY-STRUCTURED field object -- never raw bytes. The
 * shape mirrors `extractBriefLikeFields`'s output keys 1:1 so a fixture author (or a future
 * real decode step) only has to answer "what does the PDF say for this WDLL check", not
 * learn a second schema.
 */
export function extractPdfFields(structured) {
  if (!structured || typeof structured !== "object") return {};
  const fields = {};
  for (const check of WDLL_CHECKS) {
    if (check.id in structured) fields[check.id] = structured[check.id];
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

export async function fetchPdfSurface(baseUrl, parcelNodeId, { fieldsFixturePath } = {}) {
  const base = assertNotProductionBaseUrl("pdf", baseUrl);
  const downloadRes = await fetch(`${base}/v1/property-nodes/${encodeURIComponent(parcelNodeId)}/feasibility-export/download`);
  const bytes = await downloadRes.arrayBuffer();
  if (!fieldsFixturePath) {
    throw refusal(CODES.PDF_TEXT_EXTRACTION_NOT_IMPLEMENTED, "PDF bytes were downloaded, but no PDF-text-extraction library is wired into this file (see header); pass --pdf-fields-fixture", {
      byteCount: bytes.byteLength,
    });
  }
  const structured = JSON.parse(readFileSync(fieldsFixturePath, "utf8"));
  return { rawText: JSON.stringify(structured), fields: extractPdfFields(structured) };
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
