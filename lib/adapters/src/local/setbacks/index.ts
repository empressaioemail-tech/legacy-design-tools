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
import austinTx from "./austin-tx.json" with { type: "json" };
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
import bastropDevelopmentCode from "./bastrop-development-code.json" with { type: "json" };
import elginDevelopmentCode from "./elgin-development-code.json" with { type: "json" };
import beltonTx from "./belton-tx.json" with { type: "json" };
import seguinTx from "./seguin-tx.json" with { type: "json" };
import ciboloTx from "./cibolo-tx.json" with { type: "json" };
import killeenTx from "./killeen-tx.json" with { type: "json" };
import sanAntonioTx from "./san-antonio-tx.json" with { type: "json" };
import utahUnincorporated from "./utah-unincorporated.json" with { type: "json" };
import idahoUnincorporated from "./idaho-unincorporated.json" with { type: "json" };
import wacoTx from "./waco-tx.json" with { type: "json" };

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
  effectiveDate?: string;
  /** Optional context note for fallback / statewide-default tables. */
  note?: string;
  districts: SetbackDistrict[];
}

const SETBACK_TABLES: Readonly<Record<string, SetbackTable>> = {
  "grand-county-ut": grandCountyUt as SetbackTable,
  "lemhi-county-id": lemhiCountyId as SetbackTable,
  "bastrop-tx": bastropTx as SetbackTable,
  // Austin: 37 scalar rows (austin-tx.json) — the original SF-1/2/3 + MF-1..MF-6
  // rows, plus P-258 lane-a's 28 rows (2026-09-16) read from LDC §25-2-492(D)
  // (Municode; codified through Ord. No. 20260122-059, eff. 2026-02-02, the
  // CBD 350 ft height coming from Ord. No. 20251023-063, eff. 2025-11-03).
  // Wired to Publish_Zoning_AGOL BASE_ZONE stamp 2026-07-24. GIS codes the
  // Euclidean table does not govern deliberately have NO row — TOD, NBG, ERC
  // and TND are Subchapter E form-based districts, UNZ is unzoned, and the MH
  // column is em dashes throughout; see the table note for those non-rows.
  "austin-tx": austinTx as SetbackTable,
  // Tables contain only code-backed scalar rules. A conditional rule that the
  // envelope cannot evaluate is explicitly omitted in the table note.
  // P-258 lane-c (2026-09-16, OPS-24 setback acquisition): 61 district-miss
  // rows added across nine existing tables in ONE pass, largest-parcel-count
  // first, one commit per city — san-marcos +19, round-rock +14,
  // dripping-springs +9, kyle +7, georgetown +4, buda +4, pflugerville +3,
  // cedar-park +1, bastrop +0 (note only; see the Bastrop entries below for
  // why its five lane-c codes are not rowed). Every added value was read off a
  // live primary source and is `primary-source-verified` with NO atom_did
  // (the belton precedent — this corpus has a fabricated-atom_did history, so
  // no atom id is asserted that was not round-tripped). Each file's note
  // carries a dated P-258 LANE-C ADDENDUM with the instrument, the effective
  // date actually read, the sources tried, and every conditional alternative
  // that was quoted instead of codified.
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
  // 7.02.020 (Supp. 15, Ord. 2025-54). The UDC REWRITE HAS LANDED since that
  // comment was written: adopted 2026-08-11, effective 2026-11-01, and P-258
  // lane-c added its AG/MH/PF/MU-DT rows on 2026-09-16 (so those four are
  // adopted-but-not-yet-in-force on that date, and the file says so). RL is a
  // SUPERSEDED pre-rewrite single-family code whose land the rewrite's
  // Section 4.02 Equivalency Table maps onto RT; there is still no RL row —
  // land stamped RL is covered only through RT's row. Round Rock from
  // Pt. III Ch. 2 §2-26 (Supp. 25); Leander from Ch. 14 Exhibit A Art. VI §6
  // (Supp. 4 U1); Hutto from UDC §10.403.4.2 (city PDF, Mar 2024 — NOT on
  // Municode); New Braunfels from Ch. 144 §144-3.4 (Supp. 36 U3). Synthesized
  // keys `georgetown_tx`/`round_rock_tx`/`leander_tx`/`hutto_tx`/
  // `new_braunfels_tx`, normalized to hyphen form here.
  "georgetown-tx": georgetownTx as SetbackTable,
  "round-rock-tx": roundRockTx as SetbackTable,
  "leander-tx": leanderTx as SetbackTable,
  "hutto-tx": huttoTx as SetbackTable,
  "new-braunfels-tx": newBraunfelsTx as SetbackTable,
  // WDLL item 5, Wave 1 batch 1. Both tables ARE populated and cited (this
  // comment's earlier "register explicit empty tables" claim went stale as the
  // tables filled); each file's note names its source and the codes that
  // remain honest gaps. P-258 lane-c added cedar-park UR (conservative
  // envelope) and pflugerville CL3/CL4/CL5 on 2026-09-16 and re-confirmed the
  // gaps: cedar-park TC is form-based (four TC development areas, per-lot-type
  // standards, no required setbacks in Area 1), and pflugerville's
  // conventional districts R/MF-10/O/CI/NS/PF/GI/SF-E are still unrowed.
  "cedar-park-tx": cedarParkTx as SetbackTable,
  "pflugerville-tx": pflugervilleTx as SetbackTable,
  // WDLL 5, Wave 1 batch 3. These jurisdictions must resolve to an explicit,
  // cited honest gap rather than 404 or an invented envelope. Their notes
  // identify the official source, live GIS codes, and unmodeled conditions.
  "liberty-hill-tx": libertyHillTx as SetbackTable,
  "lockhart-tx": lockhartTx as SetbackTable,
  "taylor-tx": taylorTx as SetbackTable,
  // Historical B3 Place Type rows (REPEALED by Ord. 2026-06 / 2026-04-14).
  // Kept for C1 hash-lock + archival getSetbackTable("bastrop-city-tx") only.
  // getSetbackTableForZoning MUST NOT serve these as current law (WDLL STEP 3).
  "bastrop-city-tx": bastropCityTx as SetbackTable,
  // CURRENT City of Bastrop Euclidean setbacks (BDC Sec. 14.02.003 / Ord. 2026-06).
  // Rows ONLY for the scalar Euclidean districts (SF-1/SF-2/SF-3/RR); MU/GC/PI/
  // IND/P-OS/PDD are deliberately ABSENT (CORRECTION C honest-decline) and this
  // file is hash-locked against a mirror lock in hauska-engine — so do NOT add
  // rows here without moving both locks. P-258 lane-c (2026-09-16) read the
  // adopted ordinance's Dimensional Standards Charts and found BASE SCALARS for
  // all five of those codes (GC/MU/PI/IND/P-OS), which falsifies part of the
  // "no chart rows" rationale; it recorded the values as evidence in
  // bastrop-tx.json's note rather than writing unreachable rows. See that note.
  "bastrop-development-code": bastropDevelopmentCode as SetbackTable,
  // RATIFIED 2026-08-04 (doc_repo _decisions/2026-08-04_elgin_setback_table_ratified.md).
  // All 8 Euclidean districts per Elgin Code of Ordinances Ch. 46 Zoning.
  // Ported from hauska-engine's packages/adapters/src/local/setbacks/ copy,
  // where it was authored and ratified; ratification never depended on this
  // repo's own registration landing separately.
  "elgin-development-code": elginDevelopmentCode as SetbackTable,
  // Researched 2026-09-06/07 (SETBACK TABLE OWED gap fill): no code-section
  // atom corpus exists yet for any of these three (live-verified zero via
  // the atoms store), so every value is primary-source-verified rather than
  // asserted/human-verified. See each file's own note for the full source
  // trail and honest gaps (Belton's O-2 side-yard ambiguity at reduced
  // confidence; Cibolo's SF-5/SF-6 districts live on the ground with no
  // dimensional-standards subsection in the current code, omitted rather
  // than interpolated).
  "belton-tx": beltonTx as SetbackTable,
  "seguin-tx": seguinTx as SetbackTable,
  "cibolo-tx": ciboloTx as SetbackTable,
  // Killeen (researched 2026-09-06/07): unlike Belton/Seguin/Cibolo, a real
  // code-section atom corpus already exists for this jurisdiction
  // (killeen_tx/killeen-development-regulations-current-supplement/*).
  // Every citation here is human-verified against that real corpus, not
  // primary-source-verified -- round-tripping the real bodyText against the
  // original research surfaced and corrected two real transcription errors
  // (R-1 and SF-2 front_ft coded 25 ft where the real ordinance states 20
  // ft; R-1 side_ft coded 7 ft where the real ordinance states 5 ft). See
  // the file's own note for the full correction record.
  "killeen-tx": killeenTx as SetbackTable,
  "san-antonio-tx": sanAntonioTx as SetbackTable,
  "utah-unincorporated": utahUnincorporated as SetbackTable,
  "idaho-unincorporated": idahoUnincorporated as SetbackTable,
  // CTX-B, 2026-09-07: McLennan County (Waco) was wired for zoning (6,332
  // staged district polygons, 21 distinct codes) but had zero setback
  // coverage -- 48,431 parcels carrying a real zoning district and 0
  // setback-rule atoms as a direct consequence. Ported from hauska-engine's
  // packages/adapters/src/local/setbacks/ copy (identical to the corpus
  // package's waco-tx.json) rather than re-authored; see that file's own
  // note for the full source trail.
  // P-258 lane-b, 2026-09-16: that port covered 5 of the layer's 21 codes
  // (R-E, R-1A, R-1B, R-1C, R-2). This branch researched and appended the
  // other 16 district-miss codes -- R-3A/R-3B/R-3C/R-3D/R-3E, O-1/O-2/O-3,
  // C-1/C-2/C-3/C-4/C-5, M-1/M-2/M-3 -- from Chapter 28 Article IV
  // Divisions 7-22 (yard sections 28-401 through 28-776, height sections
  // 28-400 through 28-775), cross-checked against the City's own Chart 1 /
  // Chart 2 / Chart 3 and against the live zoning layer's distinct-code
  // query, so every Euclidean code the layer stamps now has a row. Four of
  // them state no height limit (R-3E, O-2, C-4, M-3) and carry the
  // canonical not_specified sentinel 999. See the file's note (EXTENDED
  // 2026-09-16) for the source trail, the reduced-confidence codings and
  // the one open thread (section 28-216's R-district impervious figure
  // versus the five pre-existing rows' 100 sentinel).
  "waco-tx": wacoTx as SetbackTable,
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

/** Repealed B3 Place Types — must not be served as current setback law. */
function isRepealedB3PlaceType(code: string): boolean {
  return (
    /^P-[1-5](?:$|[-_\s])/.test(code) ||
    /^P-(?:CS|EC)(?:$|[-_\s])/.test(code)
  );
}

/** BDC districts whose scalars live on layer 23 only (not ordinance chart). */
function isBdcPerParcelDistrictCode(code: string): boolean {
  return (
    /^(MU|GC|PDD|PI|IND|OS)(?:$|[-_\s])/.test(code) ||
    /^P\/OS(?:$|[-_\s])/.test(code) ||
    /^P-OS(?:$|[-_\s])/.test(code)
  );
}

/** BDC Euclidean districts with ordinance-text scalar rows in bastrop-development-code. */
function isBdcEuclideanCode(code: string): boolean {
  return /^(SF-[123]|RR)(?:$|[-_\s])/.test(code);
}

/**
 * Any known BDC Chapter 14 district stamp (Euclidean + conditional).
 * Conditional codes (MU/GC/…) route to the BDC table so callers
 * honest-decline on the missing row (CORRECTION C) instead of falling
 * through to the legacy bastrop-tx county table.
 */
function isKnownBdcDistrictCode(code: string): boolean {
  return isBdcEuclideanCode(code) || isBdcPerParcelDistrictCode(code);
}

function isBastropCityJurisdiction(normalizedKey: string): boolean {
  return (
    normalizedKey === "bastrop-tx" ||
    normalizedKey === "bastrop-city-tx" ||
    normalizedKey === "bastrop-development-code"
  );
}

/**
 * The Elgin GIS zoning layer's cityKey (elgin-tx, zoning-layers.ts) is a
 * separate key from the ratified table's own jurisdictionKey
 * (elgin-development-code) -- same two-key shape as Bastrop's GIS cityKey
 * vs. its BDC table key. Route the GIS key to the table.
 */
function isElginCityJurisdiction(normalizedKey: string): boolean {
  return normalizedKey === "elgin-tx" || normalizedKey === "elgin-development-code";
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
 * Resolve the table for a parcel's stamped zoning code.
 *
 * City of Bastrop (current law = BDC Sec. 14.02.003, WDLL STEP 3):
 *   - SF-1 / SF-2 / SF-3 / RR → bastrop-development-code (ordinance scalars).
 *   - MU / GC / PDD (layer 23 only): route to bastrop-development-code but
 *     chart has no rows → mapDistrict honest-decline.
 *   - Repealed B3 Place Types (P-1..P-5, P-CS, P-EC) → null
 *     (honest-decline). Do NOT silently serve bastrop-city-tx as current.
 *
 * County / other jurisdictions: fall through to the keyed table
 * (e.g. bastrop-tx legacy R-MD rows for non-city codes).
 */
export function getSetbackTableForZoning(
  jurisdictionKey: string,
  zoningCode: string | null | undefined,
): SetbackTable | null {
  const normalized = normalizeJurisdictionKey(jurisdictionKey);
  const code = (zoningCode ?? "").trim().toUpperCase();

  if (isBastropCityJurisdiction(normalized)) {
    if (code && isRepealedB3PlaceType(code)) {
      return null;
    }

    // County-only legacy codes (R-MD, etc.) on bastrop-tx key — not city BDC.
    if (
      normalized === "bastrop-tx" &&
      code &&
      !isKnownBdcDistrictCode(code)
    ) {
      return SETBACK_TABLES["bastrop-tx"] ?? null;
    }

    return SETBACK_TABLES["bastrop-development-code"] ?? null;
  }

  if (isElginCityJurisdiction(normalized)) {
    return SETBACK_TABLES["elgin-development-code"] ?? null;
  }

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
