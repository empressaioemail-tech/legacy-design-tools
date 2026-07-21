/**
 * Owner-match join-integrity gate — the automated version of the check that
 * caught the Hays/Williamson land-use fabrication.
 *
 * THE FAILURE THIS PREVENTS. The land-use join keys a TxGIO parcel's
 * `prop_id` to its `cad_property` row on
 * `(county_fips, normalizeForJoin(prop_id))`. The original `normalizeForJoin`
 * stripped a leading "R" (the WCAD appraisal "R-account" form) THEN stripped
 * leading zeros, manufacturing a bare-numeric key. For Williamson (48491) the
 * TxGIO layer stored prop_ids as `R062578` while the cad_property roll stored
 * a DIFFERENT parcel as bare `62578`; after the R-strip, `R062578 -> 62578`
 * collided numerically with that unrelated cad row. The join therefore stamped
 * ~167k parcels with the WRONG land-use (owner PURVIS's parcel got owner BREM's
 * use code), and every existing ingest step reported success because nothing
 * proved the two rows were the SAME property. (PR #313 removed the R-strip at
 * the root, so `normalizeForJoin` is now a plain leading-zero strip and this
 * gate samples that same key; the gate is the GENERAL, per-county guarantee
 * that no future numeric-collision join fabricates, whatever the id format.)
 *
 * THE ORACLE. Two parcel systems that both use short integer ids WILL
 * false-positive on a numeric join. The independent field that proves a join
 * is the same property is the OWNER NAME: `txgio_parcel.owner_name` and
 * `cad_property.owner_name` both describe the real-world owner, and they are
 * populated from independent source pipelines. If a county's joined pairs
 * agree on owner name at a high rate the join is real; if they disagree the
 * join is fabricated. Williamson/Hays came out at ~0% agreement; a correct
 * county (Bexar, Bastrop) comes out at ~100%. A 0.5 threshold cleanly
 * separates the two populations (see MODULE THRESHOLD below).
 *
 * STRUCTURE. Modeled on `lib/adapters/src/local/setbacks/gate.ts`
 * (`runSetbackGate`): a PURE, dependency-free core (no DB, no network) that
 * returns a verdict with per-check provenance, unit-testable against
 * fixtures and runnable in CI. The DB sample helper (`sampleJoinPairs`) is
 * separated out so the pure evaluation never touches a connection.
 *
 * COMMITMENT #1 (honest-absence over a false match). The gate's verdict is
 * consumed by the land-use join: a `block` verdict means the county's
 * land-use is stored as ABSENT (null), never promoted as the fabricated
 * codes. A false match is always worse than an honest gap.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { normalizeForJoin } from "./joinNormalize";

// ---------------------------------------------------------------------------
// Owner-name normalization.
// ---------------------------------------------------------------------------

/**
 * A short set of business/entity and personal-name suffix tokens that carry
 * no identifying weight. Stripped from the token stream before the leading
 * token is compared so "SMITH JOHN JR" and "SMITH JOHN" agree, and
 * "ACME LLC" and "ACME INC" compare on "ACME".
 */
const NOISE_TOKENS = new Set([
  // personal-name generational suffixes
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "V",
  // entity-type suffixes
  "LLC",
  "LP",
  "LLP",
  "LTD",
  "INC",
  "CORP",
  "CO",
  "COMPANY",
  "TRUST",
  "TR",
  "ESTATE",
  "EST",
  "ET",
  "AL",
  "ETAL",
  "ETUX",
  "ETVIR",
  "THE",
]);

/**
 * Normalize an owner name to an uppercase, punctuation-free token list.
 *
 * Handles the two dominant CAD/GIS formats:
 *   - "LAST, FIRST"  (comma-delimited) -> the surname is the token BEFORE the
 *     comma, so we reorder to put it first.
 *   - "LAST FIRST"   (space-delimited) -> already leading-surname.
 * Punctuation (commas, periods, ampersands, hyphens) becomes whitespace;
 * runs of whitespace collapse; noise tokens (JR/LLC/TRUST/…) drop.
 *
 * Returns an empty array for an empty/whitespace/blank name.
 */
export function normalizeOwnerTokens(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  let s = String(raw).toUpperCase().trim();
  if (!s) return [];

  // "LAST, FIRST MIDDLE" — the surname sits before the first comma. Reorder so
  // the surname leads regardless of source format. Only the FIRST comma is
  // treated as the last/first delimiter (mailing suffixes rarely apply here).
  const commaIdx = s.indexOf(",");
  if (commaIdx > 0) {
    const before = s.slice(0, commaIdx);
    const after = s.slice(commaIdx + 1);
    s = `${before} ${after}`;
  }

  // Replace any non-alphanumeric run with a single space, then split.
  const tokens = s
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));

  return tokens;
}

/**
 * The single comparison key for an owner name: its leading (surname / entity)
 * token after normalization. Empty string when the name has no usable token.
 *
 * The leading token is the most stable agreement signal across the two
 * systems: middle names, generational suffixes, spouse names ("& RAMIREZ
 * GILBERTA"), and entity-type words all vary between a CAD roll and a GIS
 * layer, but the surname/entity lead is written the same way in both.
 */
export function ownerLeadToken(raw: string | null | undefined): string {
  const tokens = normalizeOwnerTokens(raw);
  return tokens.length > 0 ? tokens[0] : "";
}

/**
 * Do two owner names AGREE that they name the same owner?
 *
 * Agreement rule (deliberately conservative — a false agree would let a
 * fabrication through, which is the exact failure we are stopping): the two
 * normalized leading tokens must be non-empty and equal, OR one leading token
 * is a prefix of the other of length >= 4 (handles a truncated/abbreviated
 * surname like "PURVIS" vs "PURVISON" — still the same lead) — but NEVER when
 * either side is empty. "PURVIS" vs "BREM" -> disagree. "SMITH" vs "SMITH" ->
 * agree. Two empty (blank owner on one side) -> NOT an agreement (it is not
 * evidence the join is correct; the pair is simply uninformative).
 */
export function ownersAgree(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const la = ownerLeadToken(a);
  const lb = ownerLeadToken(b);
  if (!la || !lb) return false;
  if (la === lb) return true;
  // Prefix agreement, min length 4, to absorb minor truncation without
  // letting short unrelated tokens ("BR" vs "BREM") slip through.
  const shorter = la.length <= lb.length ? la : lb;
  const longer = la.length <= lb.length ? lb : la;
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-match owner gate for the SITUS-ADDRESS recovery join.
//
// When a county's prop_id land-use join is gate-blocked (a numeric collision),
// the land-use is recovered via the parcel's situs ADDRESS instead. But an
// address match is not, by itself, proof the two rows are the same property —
// the SAME oracle that gates the prop_id join (owner-name agreement) must gate
// EACH address match too. This is the per-match analogue of the aggregate
// `ownerMatchRate` gate: instead of scoring a whole county pass/block, it
// decides ONE matched pair — promote the code only when the TxGIO owner and the
// CAD owner agree; otherwise honest null. No un-gated join promotes
// (commitment #1).
// ---------------------------------------------------------------------------

/**
 * A CAD roll entry keyed by normalized situs address, carrying BOTH the
 * land-use code to (conditionally) promote AND the CAD owner name that the
 * per-match gate checks against the TxGIO owner. `owner` may be null/blank (an
 * unnamed CAD row): the gate then declines to promote (an address match with no
 * owner evidence is uninformative — it can neither confirm nor deny the join —
 * so it is honest-absence, never a blind promote).
 */
export interface AddressLandUseEntry {
  code: string;
  vintage: string;
  owner: string | null;
}

/**
 * Resolve a situs-address-matched land-use through the per-match owner gate.
 *
 * Returns the CAD entry ONLY when an address match exists AND the TxGIO owner
 * and the matched CAD owner AGREE (same `ownersAgree` rule the aggregate gate
 * uses — leading surname/entity token). In every other case returns null:
 *   - no address key / no address match          -> null (honest absence)
 *   - address match but owners DISAGREE           -> null (never the wrong code)
 *   - address match but an owner is blank/missing -> null (uninformative; not
 *                                                    evidence the join is real)
 *
 * This is the whole integrity guarantee of the recovery path: an address join
 * self-gates per parcel, so only owner-verified matches promote. PURE — no DB.
 */
export function resolveAddressLandUse(
  addressKey: string | null | undefined,
  txgioOwner: string | null | undefined,
  lookup: ReadonlyMap<string, AddressLandUseEntry>,
): AddressLandUseEntry | null {
  if (!addressKey) return null;
  const hit = lookup.get(addressKey);
  if (!hit) return null;
  // Per-match owner gate — identical rule to the aggregate integrity gate.
  if (!ownersAgree(txgioOwner, hit.owner)) return null;
  return hit;
}

// ---------------------------------------------------------------------------
// Owner-match rate over a sample.
// ---------------------------------------------------------------------------

export interface OwnerPair {
  txgioOwner: string | null | undefined;
  cadOwner: string | null | undefined;
}

export interface OwnerMatchRate {
  /**
   * Pairs where BOTH sides carried a usable owner token — the denominator the
   * rate is computed over. A pair with a blank owner on either side is
   * uninformative (it can neither confirm nor deny the join) and is excluded
   * from the denominator, so a county with many blank owners does not dilute
   * the signal toward a false block. `sampled` is that informative count.
   */
  sampled: number;
  /** Informative pairs whose owners agree. */
  agreed: number;
  /** agreed / sampled, or 0 when sampled === 0. */
  rate: number;
  /** Total pairs supplied (informative + uninformative), for reporting. */
  total: number;
}

/**
 * Pure owner-match rate over supplied joined pairs. No DB. The denominator is
 * the INFORMATIVE pairs (both owners present); the rate is the agreement
 * fraction over those. An empty or all-uninformative sample yields
 * rate 0 / sampled 0 — the caller (the gate) decides what a zero-sample
 * verdict is.
 */
export function ownerMatchRate(pairs: OwnerPair[]): OwnerMatchRate {
  let sampled = 0;
  let agreed = 0;
  for (const p of pairs) {
    const la = ownerLeadToken(p.txgioOwner);
    const lb = ownerLeadToken(p.cadOwner);
    // Uninformative (blank on a side) — excluded from the denominator.
    if (!la || !lb) continue;
    sampled += 1;
    if (ownersAgree(p.txgioOwner, p.cadOwner)) agreed += 1;
  }
  const rate = sampled > 0 ? agreed / sampled : 0;
  return { sampled, agreed, rate, total: pairs.length };
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

/**
 * MODULE THRESHOLD — the owner-match rate below which a join is treated as
 * fabricated and BLOCKED.
 *
 * Chosen at 0.5. The two observed populations are far apart: a fabricated
 * numeric-collision join (Williamson/Hays) agrees at ~0%, a real join
 * (Bexar/Bastrop) agrees at ~100%. Any threshold in the wide (0, 1) gap
 * separates them; 0.5 is the midpoint, maximally robust to the real-county
 * rate dipping (blank owners, format skew, a minority of genuinely-unmatched
 * parcels) without ever admitting a fabrication. A real county would have to
 * fall below half its parcels agreeing — which never happens for a true join —
 * before it blocks, and a fabricated county would have to reach half agreeing
 * by pure chance — which a numeric collision never does — before it passes.
 */
export const DEFAULT_MIN_OWNER_MATCH_RATE = 0.5;

/**
 * The minimum informative sample below which the gate declines to assert a
 * verdict from too little evidence. A county with fewer than this many
 * informative pairs (e.g. a roll with almost no owner names) yields an
 * `insufficient-sample` verdict rather than a false block or a false pass.
 * The consuming bake treats `insufficient-sample` the same as no gate result:
 * it does NOT promote fabricated data, but it also does not claim a proven
 * block — the ledger records the honest "not enough evidence" state.
 */
export const MIN_INFORMATIVE_SAMPLE = 30;

export type JoinIntegrityVerdict = "pass" | "block" | "insufficient-sample";

export interface JoinIntegrityInput {
  /** 5-digit county FIPS, e.g. `48491` (Williamson). */
  county: string;
  /** Facet the join feeds, e.g. `land-use`. */
  facet: string;
  /** The joined owner pairs drawn from the same key the bake joins on. */
  sample: OwnerPair[];
  /** Override the block threshold; defaults to DEFAULT_MIN_OWNER_MATCH_RATE. */
  minRate?: number;
  /** Override the insufficient-sample floor; defaults to MIN_INFORMATIVE_SAMPLE. */
  minInformative?: number;
}

export interface JoinIntegrityReport {
  county: string;
  facet: string;
  verdict: JoinIntegrityVerdict;
  ownerMatchRate: number;
  /** Informative pairs the rate was computed over. */
  sampled: number;
  /** Pairs that agreed. */
  agreed: number;
  /** Total pairs supplied. */
  total: number;
  /** The threshold applied. */
  minRate: number;
  /** Human-readable reason, provenance for the ledger + logs. */
  reason: string;
  /** Wall-clock stamp (quality-gate rule: every output carries a timestamp). */
  checkedAt: string;
}

/**
 * Evaluate join integrity for one county+facet from a drawn sample. PURE —
 * no DB, no network, no mutation of inputs.
 *
 *   verdict 'block'                when informative sample >= minInformative
 *                                  AND ownerMatchRate < minRate — the join is
 *                                  fabricated; land-use must be stored absent.
 *   verdict 'insufficient-sample'  when informative sample < minInformative —
 *                                  not enough owner evidence to assert either
 *                                  way; do not promote fabricated data, but do
 *                                  not claim a proven block.
 *   verdict 'pass'                 otherwise — the join is corroborated by
 *                                  owner agreement at or above the threshold.
 */
export function evaluateJoinIntegrity(
  input: JoinIntegrityInput,
): JoinIntegrityReport {
  const minRate = input.minRate ?? DEFAULT_MIN_OWNER_MATCH_RATE;
  const minInformative = input.minInformative ?? MIN_INFORMATIVE_SAMPLE;
  const { sampled, agreed, rate, total } = ownerMatchRate(input.sample);
  const checkedAt = new Date().toISOString();

  let verdict: JoinIntegrityVerdict;
  let reason: string;

  if (sampled < minInformative) {
    verdict = "insufficient-sample";
    reason =
      `only ${sampled} informative owner pairs (< ${minInformative}); ` +
      `cannot assert integrity — not enough owner evidence. Land-use is NOT ` +
      `promoted as proven, and NOT proven-fabricated.`;
  } else if (rate < minRate) {
    verdict = "block";
    reason =
      `owner-match rate ${(rate * 100).toFixed(1)}% (${agreed}/${sampled}) ` +
      `< threshold ${(minRate * 100).toFixed(0)}% — the ${input.facet} join ` +
      `is FABRICATED (numeric key collision across two systems). Store ` +
      `honest-absence; do NOT promote the joined codes.`;
  } else {
    verdict = "pass";
    reason =
      `owner-match rate ${(rate * 100).toFixed(1)}% (${agreed}/${sampled}) ` +
      `>= threshold ${(minRate * 100).toFixed(0)}% — the ${input.facet} join ` +
      `is corroborated by independent owner agreement.`;
  }

  return {
    county: input.county,
    facet: input.facet,
    verdict,
    ownerMatchRate: rate,
    sampled,
    agreed,
    total,
    minRate,
    reason,
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// DB sample helper — draws the joined owner pairs on the SAME key the bake
// uses. Kept out of the pure core (which never touches a connection).
// ---------------------------------------------------------------------------

/**
 * A minimal pg-pool shape (query only). Typed structurally so this module does
 * NOT import `pg` (and does not force a DB dependency into module load) — the
 * caller passes its already-open pool.
 */
export interface QueryablePool {
  query<R extends Record<string, any> = Record<string, any>>(
    text: string,
    params?: any[],
  ): Promise<{ rows: R[] }>;
}

/**
 * Whether a physical table is present (mirrors the bake CLIs' `to_regclass`
 * probe), so a missing cad_property / txgio_parcel yields an empty sample
 * rather than a query error.
 */
async function tableExists(
  pool: QueryablePool,
  table: string,
): Promise<boolean> {
  const r = await pool.query<{ r: string | null }>(
    "SELECT to_regclass($1) AS r",
    [table],
  );
  return r.rows[0]?.r != null;
}

/**
 * Draw up to `limit` joined `(txgioOwner, cadOwner)` pairs for a county on the
 * EXACT key the land-use bake joins on.
 *
 * The join key must match `fetchCountyLandUse` + `normalizeForJoin` in the
 * bake: TxGIO `prop_id` is normalized (leading-zero strip on an all-digits id;
 * post-#313 there is no R-strip) to the bare-numeric form the cad_property roll
 * stores its `prop_id` in, and the two are matched within the SAME
 * `county_fips`. Because the bake reads
 * `DISTINCT ON (feature_index)` from the parcel table and
 * `DISTINCT ON (prop_id)` (latest coded tax year) from cad_property, we sample
 * the same shape: distinct TxGIO parcels (by feature_index) joined to the
 * latest-year cad_property row on the normalized key.
 *
 * The normalization is applied IN SQL so the sampled join is byte-for-byte the
 * bake's join, not an approximation:
 *   regexp_replace(regexp_replace(prop_id, '^[Rr](?=\\d)', ''), '^0+(?=\\d)', '')
 * which is exactly `normalizeForJoin` for the numeric case. Non-numeric junk
 * values ("PRIVATE ROAD") normalize to themselves and simply do not match a
 * numeric cad key — same as the bake.
 *
 * Reads BOTH `txgio_parcel` and `txgio_parcel_staging` (prod winning on a
 * county collision) the way the bake does. Returns the pairs; the caller runs
 * `evaluateJoinIntegrity`.
 *
 * READ-ONLY. Selects owner_name from both sides FOR THE GATE ONLY — the owner
 * pairing never leaves this evaluation (it is not persisted to the public
 * PMTiles archive or the ledger; only the aggregate rate is stored).
 */
export async function sampleJoinPairs(
  pool: QueryablePool,
  countyFips: string,
  limit = 2000,
): Promise<OwnerPair[]> {
  if (!(await tableExists(pool, "cad_property"))) return [];

  // The `normalizeForJoin` normalizer, expressed in SQL, so the sampled join
  // is byte-for-byte the bake's join. Since PR #313 removed the R-strip (the
  // R-strip was the SOURCE of the Williamson fabrication — it manufactured a
  // bare-numeric key that collided with an unrelated CAD account), the
  // normalizer is now a plain trim + leading-zero strip. A non-numeric value
  // (an un-stripped R-account id like "R062578", or "PRIVATE ROAD") is left
  // as-is and simply does not match a bare-numeric cad key — the honest,
  // non-fabricating outcome. The leading-zero strip keeps the final digit via
  // '^0+([0-9])' -> '\1' (POSIX regex has no lookahead), and is applied only to
  // an all-digits value so junk survives untouched.
  const NORMALIZE_SQL = `
    CASE
      WHEN trim(prop_id) ~ '^[0-9]+$'
        THEN regexp_replace(trim(prop_id), '^0+([0-9])', '\\1')
      ELSE trim(prop_id)
    END`;

  const parcelTables = ["txgio_parcel", "txgio_parcel_staging"] as const;
  const seenSource = new Set<string>();
  const pairs: OwnerPair[] = [];

  for (const table of parcelTables) {
    if (pairs.length >= limit) break;
    if (!(await tableExists(pool, table))) continue;
    // Skip staging for a county already sampled from a higher-precedence
    // table (prod wins), mirroring the bake's precedence.
    if (seenSource.has(countyFips) && table === "txgio_parcel_staging") {
      continue;
    }

    const remaining = limit - pairs.length;
    const r = await pool.query<{
      txgio_owner: string | null;
      cad_owner: string | null;
    }>(
      `WITH parcels AS (
         SELECT DISTINCT ON (feature_index)
                feature_index,
                owner_name AS txgio_owner,
                ${NORMALIZE_SQL} AS join_key
           FROM ${table}
          WHERE county_fips = $1
            AND prop_id IS NOT NULL
          ORDER BY feature_index
       ),
       cad AS (
         SELECT DISTINCT ON (prop_id)
                prop_id AS join_key,
                owner_name AS cad_owner
           FROM cad_property
          WHERE county_fips = $1
            AND property_use_code IS NOT NULL
          ORDER BY prop_id, tax_year DESC
       )
       SELECT p.txgio_owner, c.cad_owner
         FROM parcels p
         JOIN cad c ON c.join_key = p.join_key
        LIMIT $2`,
      [countyFips, remaining],
    );

    if (r.rows.length > 0) seenSource.add(countyFips);
    for (const row of r.rows) {
      pairs.push({ txgioOwner: row.txgio_owner, cadOwner: row.cad_owner });
    }
  }

  return pairs;
}

/**
 * Draw up to `limit` joined `(txgioOwner, cadOwner)` pairs for a county on the
 * SITUS-ADDRESS recovery key — the exact key the address-join land-use bake
 * uses when a county's prop_id join is gate-blocked. This is the address
 * analogue of `sampleJoinPairs`, so the coverage scorer can measure the REAL
 * recovered owner-match rate for a blocked county (Williamson/Hays) rather than
 * scoring the dead prop_id join and recording 0.
 *
 * The address key is `normalizeSitusAddress` expressed in SQL on BOTH sides:
 * `upper(regexp_replace(situs_address, '[^A-Za-z0-9]', '', 'g'))`, so the
 * sampled join is byte-for-byte the bake's address join. The CAD side is
 * DISTINCT ON (normalized address), latest coded tax year — the same lookup the
 * bake builds. A blank situs on either side simply does not match (empty key is
 * excluded), never a false pair.
 *
 * READ-ONLY. Owner names are used FOR THE GATE ONLY and never persisted.
 */
export async function sampleAddressJoinPairs(
  pool: QueryablePool,
  countyFips: string,
  limit = 2000,
): Promise<OwnerPair[]> {
  if (!(await tableExists(pool, "cad_property"))) return [];

  // `normalizeSitusAddress` in SQL: upper + strip every non-alphanumeric char.
  const ADDR_NORM = (col: string): string =>
    `upper(regexp_replace(${col}, '[^A-Za-z0-9]', '', 'g'))`;

  const parcelTables = ["txgio_parcel", "txgio_parcel_staging"] as const;
  const seenSource = new Set<string>();
  const pairs: OwnerPair[] = [];

  for (const table of parcelTables) {
    if (pairs.length >= limit) break;
    if (!(await tableExists(pool, table))) continue;
    if (seenSource.has(countyFips) && table === "txgio_parcel_staging") {
      continue;
    }

    const remaining = limit - pairs.length;
    const r = await pool.query<{
      txgio_owner: string | null;
      cad_owner: string | null;
    }>(
      `WITH parcels AS (
         SELECT DISTINCT ON (feature_index)
                feature_index,
                owner_name AS txgio_owner,
                ${ADDR_NORM("situs_address")} AS addr_key
           FROM ${table}
          WHERE county_fips = $1
            AND situs_address IS NOT NULL
            AND situs_address <> ''
          ORDER BY feature_index
       ),
       cad AS (
         SELECT DISTINCT ON (${ADDR_NORM("situs_address")})
                ${ADDR_NORM("situs_address")} AS addr_key,
                owner_name AS cad_owner
           FROM cad_property
          WHERE county_fips = $1
            AND property_use_code IS NOT NULL
            AND situs_address IS NOT NULL
            AND situs_address <> ''
          ORDER BY ${ADDR_NORM("situs_address")}, tax_year DESC
       )
       SELECT p.txgio_owner, c.cad_owner
         FROM parcels p
         JOIN cad c ON c.addr_key = p.addr_key
        WHERE p.addr_key <> ''
        LIMIT $2`,
      [countyFips, remaining],
    );

    if (r.rows.length > 0) seenSource.add(countyFips);
    for (const row of r.rows) {
      pairs.push({ txgioOwner: row.txgio_owner, cadOwner: row.cad_owner });
    }
  }

  return pairs;
}

/**
 * Convenience: draw the sample and evaluate in one call. The DB touch is
 * confined to `sampleJoinPairs`; the verdict is the pure `evaluateJoinIntegrity`.
 */
export async function gateCountyLandUseJoin(
  pool: QueryablePool,
  countyFips: string,
  opts: {
    facet?: string;
    sampleLimit?: number;
    minRate?: number;
    minInformative?: number;
  } = {},
): Promise<JoinIntegrityReport> {
  const facet = opts.facet ?? "land-use";
  const sample = await sampleJoinPairs(
    pool,
    countyFips,
    opts.sampleLimit ?? 2000,
  );
  return evaluateJoinIntegrity({
    county: countyFips,
    facet,
    sample,
    minRate: opts.minRate,
    minInformative: opts.minInformative,
  });
}

/**
 * Load the set of county FIPS the LEDGER records as land-use `block` — the
 * gate's computed fabrication verdicts, the authoritative (not hand-edited)
 * block set the bakes gate on.
 *
 * Returns an empty set when the ledger table is absent or unscored; the caller
 * (the bake) then falls back to `LANDUSE_JOIN_DISABLED_FIPS_SEED` via
 * `landUseJoinKey`'s default so a fresh DB is never left un-gated. Reading the
 * ledger (rather than re-running the gate per bake) keeps the bake fast and
 * makes the ledger the single source of truth: score once, every bake honors
 * it.
 *
 * READ-ONLY.
 */
export async function loadLedgerBlockedFips(
  pool: QueryablePool,
  facet = "land-use",
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!(await tableExists(pool, "county_facet_coverage"))) return out;
  const r = await pool.query<{ county_fips: string }>(
    `SELECT county_fips
       FROM county_facet_coverage
      WHERE facet = $1 AND integrity_verdict = 'block'`,
    [facet],
  );
  for (const row of r.rows) out.add(row.county_fips);
  return out;
}

/**
 * The normalizer the SQL sample mirrors, re-exported so a test can assert the
 * TS join key and the SQL join key agree on the collision case.
 */
export { normalizeForJoin };

/** Human-readable one-line formatter for CLI / logs. */
export function formatIntegrityReport(r: JoinIntegrityReport): string {
  const v = r.verdict.toUpperCase();
  return (
    `Join-integrity ${r.county}/${r.facet}: ${v} | ` +
    `owner-match ${(r.ownerMatchRate * 100).toFixed(1)}% ` +
    `(${r.agreed}/${r.sampled}, ${r.total} sampled) | ${r.reason}`
  );
}
