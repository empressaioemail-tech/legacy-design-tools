/**
 * `cad:*` Property Brief adapters — owner / value / tax / occupancy slots
 * served from the `cad_property` store (county appraisal-district public
 * roll data, feat/cad-property-store PR #245). Provider-neutral
 * replacement for the dark Cotality property adapters on the brief path.
 *
 * Three adapters, one shared resolution:
 *
 *   cad:property         (cad-property)         owner, situs, legal,
 *                                               improvements, CAD values
 *   cad:tax              (cad-tax)              assessed value + decoded
 *                                               exemption codes
 *   cad:owner-occupancy  (cad-owner-occupancy)  derived absentee-owner
 *                                               signal (disclosed method)
 *
 * HONESTY REQUIREMENTS (load-bearing, tested):
 *   - Every value is the county's ASSESSED/appraised figure. Summaries
 *     label them "CAD … value (assessed)" and never present them as a
 *     market estimate, AVM, or opinion of value.
 *   - The owner-occupancy signal is DERIVED, and the summary names the
 *     method: "derived from CAD homestead exemption + mailing/situs
 *     comparison". When an input side is missing the sub-signal is
 *     `unknown` — never guessed.
 *
 * Coverage: geocoded point inside one of the five supported Central TX
 * counties (48453 Travis / 48491 Williamson / 48029 Bexar / 48021
 * Bastrop / 48055 Caldwell — the `txCountyApn` routing table shared with
 * the #243 parcel-key path). Everywhere else is an honest no-coverage.
 *
 * Plumbing: the adapters are gated on `ctx.cadLookup` (see
 * {@link CadPropertyLookup} in ../types) — the api-server injects a
 * drizzle-backed accessor on the brief site-context path; paths without
 * the accessor never match `appliesTo`. Point→(countyFips, propId)
 * resolution reuses the shared county ArcGIS lookup
 * (`resolveCountyApnByPoint`), so a live run costs one county GIS point
 * query + one local Postgres read per adapter; the brief path's
 * permanent place-layer snapshots make live runs once-per-place.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type CadPropertyLookupRow,
} from "../types";
import {
  resolveCountyApnSource,
  resolveCountyApnByPoint,
  type CountyApnSource,
} from "../txCountyApn";
import { isRecord } from "../_payloadSummaryHelpers";

/** Static provider label (archived-snapshot fallback). Live results carry the specific CAD name. */
const CAD_STATIC_PROVIDER = "County Appraisal District (Central TX public roll)";

/**
 * Disclosed derivation method for the owner-occupancy signal — verbatim
 * in the payload and the summary chip.
 */
export const CAD_OWNER_OCCUPANCY_METHOD =
  "derived from CAD homestead exemption + mailing/situs comparison";

/**
 * Human labels for the common Texas exemption short codes carried by
 * `cad_property.exemption_codes`. Codes outside the table pass through
 * raw — no guessing at labels.
 */
const EXEMPTION_LABELS: Record<string, string> = {
  HS: "Homestead",
  OV65: "Over-65",
  OV65S: "Over-65 surviving spouse",
  DP: "Disabled person",
  DPS: "Disabled person surviving spouse",
  DV1: "Disabled veteran (10-29%)",
  DV2: "Disabled veteran (30-49%)",
  DV3: "Disabled veteran (50-69%)",
  DV4: "Disabled veteran (70-100%)",
  DVHS: "Disabled veteran homestead (100%)",
  EX: "Exempt (total)",
  EX366: "Exempt (under $500)",
};

export function decodeExemptionCode(code: string): string {
  const c = code.trim().toUpperCase();
  if (EXEMPTION_LABELS[c]) return EXEMPTION_LABELS[c];
  // Surviving-spouse / suffixed disabled-veteran variants (DV1S..DV4S,
  // DVHSS) share the family label.
  if (/^DV\d?S?$/.test(c) || c.startsWith("DVHS")) return "Disabled veteran";
  return c;
}

/**
 * Homestead determination. `null` exemption data (export carried no
 * exemption fields for the row) is unknown; an array is a positive
 * statement of the roll's exemptions, so a missing HS is a real "no
 * homestead" signal. DVHS is a homestead-class exemption (100% disabled
 * veteran residence homestead) and counts as homestead.
 */
export function homesteadExemptionPresent(
  exemptionCodes: string[] | null,
): boolean | null {
  if (exemptionCodes === null) return null;
  return exemptionCodes.some((c) => {
    const u = c.trim().toUpperCase();
    return u === "HS" || u === "DVHS";
  });
}

const STREET_TOKEN_NORMALIZATIONS: Record<string, string> = {
  STREET: "ST",
  DRIVE: "DR",
  ROAD: "RD",
  LANE: "LN",
  AVENUE: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  COURT: "CT",
  CIRCLE: "CIR",
  HIGHWAY: "HWY",
  PARKWAY: "PKWY",
  TRAIL: "TRL",
  PLACE: "PL",
  TERRACE: "TER",
  COVE: "CV",
  LOOP: "LOOP",
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  NORTHEAST: "NE",
  NORTHWEST: "NW",
  SOUTHEAST: "SE",
  SOUTHWEST: "SW",
};

/** Uppercase, strip punctuation, collapse whitespace, normalize suffix/directional tokens. */
export function normalizeAddressLine(line: string): string {
  return line
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((t) => STREET_TOKEN_NORMALIZATIONS[t] ?? t)
    .join(" ")
    .trim();
}

export type MailingSitusComparison = "same" | "different" | "unknown";

/** First comma-separated mailing segment that starts with a house number. */
function firstStreetSegment(normalizedSegments: string[]): string | null {
  for (const seg of normalizedSegments) {
    if (/^\d+\s+\S/.test(seg)) return seg;
  }
  return null;
}

/**
 * Conservative normalized mailing-vs-situs comparison.
 *
 *   - either side missing/blank → "unknown" (never guess);
 *   - PO Box mailing → "unknown" (a box says nothing material about
 *     where the owner lives);
 *   - normalized situs street line contained in the normalized mailing
 *     (mailing lines often prepend a care-of name and append city/zip)
 *     → "same";
 *   - both sides have an extractable house-number street segment and
 *     they differ → "different";
 *   - anything else → "unknown".
 */
export function compareMailingToSitus(
  ownerMailingAddress: string | null,
  situsAddress: string | null,
): MailingSitusComparison {
  const situs = situsAddress ? normalizeAddressLine(situsAddress) : "";
  const mailingRaw = ownerMailingAddress ?? "";
  if (!situs || !mailingRaw.trim()) return "unknown";

  const mailingSegments = mailingRaw
    .split(",")
    .map((s) => normalizeAddressLine(s))
    .filter(Boolean);
  const mailing = mailingSegments.join(", ");
  if (!mailing) return "unknown";

  if (/\bP\s*O\s+BOX\b|\bPO\s+BOX\b|\bBOX\s+\d/.test(mailing)) return "unknown";
  if (mailing.includes(situs)) return "same";

  const mailingStreet = firstStreetSegment(mailingSegments);
  const situsHasNumber = /^\d+\s+\S/.test(situs);
  if (mailingStreet && situsHasNumber && mailingStreet !== situs) {
    return "different";
  }
  return "unknown";
}

export type OwnerOccupancySignal =
  | "likely-owner-occupied"
  | "likely-absentee"
  | "unknown";

export interface OwnerOccupancyDerivation {
  signal: OwnerOccupancySignal;
  /** Which sub-signals produced the verdict, for the disclosed-method payload. */
  basis: string[];
  homesteadExemption: boolean | null;
  mailingMatchesSitus: MailingSitusComparison;
}

/**
 * Combine the two disclosed sub-signals. The homestead exemption is the
 * county-adjudicated primary-residence claim, so a present HS wins even
 * when the mailing address differs (mail routed to a manager/relative
 * is common). With HS known-absent, a differing mailing corroborates
 * absentee; a matching mailing contradicts (owner may simply not have
 * filed) and the verdict stays unknown. Missing inputs never convert
 * into a guess.
 */
export function deriveOwnerOccupancy(
  row: Pick<
    CadPropertyLookupRow,
    "exemptionCodes" | "ownerMailingAddress" | "situsAddress"
  >,
): OwnerOccupancyDerivation {
  const hs = homesteadExemptionPresent(row.exemptionCodes);
  const cmp = compareMailingToSitus(row.ownerMailingAddress, row.situsAddress);

  if (hs === true) {
    const basis = ["homestead-exemption"];
    if (cmp === "different") basis.push("mailing-differs-from-situs");
    return {
      signal: "likely-owner-occupied",
      basis,
      homesteadExemption: hs,
      mailingMatchesSitus: cmp,
    };
  }
  if (hs === false) {
    if (cmp === "different") {
      return {
        signal: "likely-absentee",
        basis: ["no-homestead-exemption", "mailing-differs-from-situs"],
        homesteadExemption: hs,
        mailingMatchesSitus: cmp,
      };
    }
    if (cmp === "same") {
      // Conflicting sub-signals — no homestead filed but mail goes to
      // the property. Do not guess.
      return {
        signal: "unknown",
        basis: ["no-homestead-exemption", "mailing-matches-situs"],
        homesteadExemption: hs,
        mailingMatchesSitus: cmp,
      };
    }
    return {
      signal: "likely-absentee",
      basis: ["no-homestead-exemption"],
      homesteadExemption: hs,
      mailingMatchesSitus: cmp,
    };
  }
  // Homestead unknown — the mailing comparison alone decides, weakly.
  if (cmp === "different") {
    return {
      signal: "likely-absentee",
      basis: ["mailing-differs-from-situs"],
      homesteadExemption: hs,
      mailingMatchesSitus: cmp,
    };
  }
  if (cmp === "same") {
    return {
      signal: "likely-owner-occupied",
      basis: ["mailing-matches-situs"],
      homesteadExemption: hs,
      mailingMatchesSitus: cmp,
    };
  }
  return {
    signal: "unknown",
    basis: [],
    homesteadExemption: hs,
    mailingMatchesSitus: cmp,
  };
}

/**
 * Gate: geocoded point inside one of the five supported counties AND the
 * CAD store accessor is injected AND the resolved jurisdiction does not
 * contradict Texas. The bbox routing is the authoritative geometry gate;
 * the state check only rejects contexts whose resolver already landed on
 * a different state.
 */
function cadApplies(ctx: AdapterContext): boolean {
  if (!ctx.cadLookup) return false;
  const { latitude, longitude, state } = ctx.parcel;
  if (ctx.jurisdiction.stateKey && ctx.jurisdiction.stateKey !== "texas") {
    return false;
  }
  if (
    typeof state === "string" &&
    state.trim() &&
    !/^(tx|texas)$/i.test(state.trim())
  ) {
    return false;
  }
  return resolveCountyApnSource(latitude, longitude) !== null;
}

interface ResolvedCadRow {
  county: CountyApnSource;
  propId: string;
  gisSourceUrl: string;
  row: CadPropertyLookupRow;
}

/**
 * Shared resolution: point → county → GIS propId → latest `cad_property`
 * row via the injected accessor. Every miss is a deterministic
 * no-coverage, never a fabricated row.
 */
async function resolveCadRow(ctx: AdapterContext): Promise<ResolvedCadRow> {
  const { latitude, longitude } = ctx.parcel;
  const county = resolveCountyApnSource(latitude, longitude);
  if (!county) {
    throw new AdapterRunError(
      "no-coverage",
      "Point is outside the supported Central TX counties (Travis, Williamson, Bexar, Bastrop, Caldwell).",
    );
  }
  if (!ctx.cadLookup) {
    throw new AdapterRunError(
      "no-coverage",
      "CAD property store accessor not available on this path.",
    );
  }
  const resolution = await resolveCountyApnByPoint({
    latitude,
    longitude,
    fetchImpl: ctx.fetchImpl,
    signal: ctx.signal,
  });
  if (!resolution) {
    throw new AdapterRunError(
      "no-coverage",
      `No parcel at this point in the ${county.name} County GIS.`,
    );
  }
  const row = await ctx.cadLookup(county.fips, resolution.apn);
  if (!row) {
    throw new AdapterRunError(
      "no-coverage",
      `No ${county.cadName} roll row ingested for parcel ${resolution.apn}.`,
    );
  }
  return {
    county,
    propId: resolution.apn,
    gisSourceUrl: resolution.sourceUrl,
    row,
  };
}

/** Provenance fields common to all three payloads. */
function provenanceFields(resolved: ResolvedCadRow): Record<string, unknown> {
  const { county, row } = resolved;
  return {
    cadName: county.cadName,
    countyFips: county.fips,
    countyName: county.name,
    propId: row.propId,
    taxYear: row.taxYear,
    /**
     * The roll export drop this row came from — the honest data vintage
     * (`brokerageSiteContext` reads `sourceVintage` into the layer's
     * engineHonesty.dataVintage).
     */
    sourceVintage: row.sourceVintage,
    parcelResolution: {
      provider: "county-gis",
      sourceUrl: resolved.gisSourceUrl,
    },
    retrievedAt: new Date().toISOString(),
  };
}

function situsLine(row: CadPropertyLookupRow): string | null {
  const parts = [row.situsAddress, row.situsCity, row.situsZip]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function landAcresNumber(row: CadPropertyLookupRow): number | null {
  if (row.landAcres === null) return null;
  const n = Number(row.landAcres);
  return Number.isFinite(n) ? n : null;
}

function makeResult(
  adapter: Adapter,
  resolved: ResolvedCadRow,
  payload: Record<string, unknown>,
): AdapterResult {
  return {
    adapterKey: adapter.adapterKey,
    tier: adapter.tier,
    layerKind: adapter.layerKind,
    sourceKind: adapter.sourceKind,
    // Name the specific CAD, e.g. "Travis Central Appraisal District".
    provider: resolved.county.cadName,
    snapshotDate: new Date().toISOString(),
    payload,
  };
}

export const cadPropertyAdapter: Adapter = {
  adapterKey: "cad:property",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "cad-property",
  provider: CAD_STATIC_PROVIDER,
  jurisdictionGate: { state: "texas" },
  appliesTo: cadApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const resolved = await resolveCadRow(ctx);
    const { row } = resolved;
    return makeResult(this, resolved, {
      kind: "cad-property",
      ...provenanceFields(resolved),
      ownerName: row.ownerName,
      situsAddress: row.situsAddress,
      situsCity: row.situsCity,
      situsZip: row.situsZip,
      legalDescription: row.legalDescription,
      yearBuilt: row.yearBuilt,
      livingAreaSqft: row.livingAreaSqft,
      landAcres: landAcresNumber(row),
      propertyUseCode: row.propertyUseCode,
      landValue: row.landValue,
      improvementValue: row.improvementValue,
      marketValue: row.marketValue,
      /**
       * HONESTY: these are the county appraisal district's assessed /
       * appraised figures, not a market estimate, AVM, or opinion of
       * value. Summary rendering must keep the "(assessed)" label.
       */
      valueBasis: "county-assessed",
    });
  },
};

export const cadTaxAdapter: Adapter = {
  adapterKey: "cad:tax",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "cad-tax",
  provider: CAD_STATIC_PROVIDER,
  jurisdictionGate: { state: "texas" },
  appliesTo: cadApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const resolved = await resolveCadRow(ctx);
    const { row } = resolved;
    return makeResult(this, resolved, {
      kind: "cad-tax",
      ...provenanceFields(resolved),
      assessedValue: row.assessedValue,
      exemptionCodes: row.exemptionCodes,
      exemptions:
        row.exemptionCodes?.map((code) => ({
          code,
          label: decodeExemptionCode(code),
        })) ?? null,
      valueBasis: "county-assessed",
    });
  },
};

export const cadOwnerOccupancyAdapter: Adapter = {
  adapterKey: "cad:owner-occupancy",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "cad-owner-occupancy",
  provider: CAD_STATIC_PROVIDER,
  jurisdictionGate: { state: "texas" },
  appliesTo: cadApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const resolved = await resolveCadRow(ctx);
    const { row } = resolved;
    const derivation = deriveOwnerOccupancy(row);
    return makeResult(this, resolved, {
      kind: "cad-owner-occupancy",
      ...provenanceFields(resolved),
      signal: derivation.signal,
      basis: derivation.basis,
      homesteadExemption: derivation.homesteadExemption,
      mailingMatchesSitus: derivation.mailingMatchesSitus,
      ownerMailingAddress: row.ownerMailingAddress,
      situsAddress: row.situsAddress,
      /** HONESTY: disclosed derivation method, verbatim in the summary. */
      method: CAD_OWNER_OCCUPANCY_METHOD,
    });
  },
};

export const CAD_ADAPTERS: ReadonlyArray<Adapter> = [
  cadPropertyAdapter,
  cadTaxAdapter,
  cadOwnerOccupancyAdapter,
];

// ---------------------------------------------------------------------------
// Summary chips (brief path) — mirrors the ../state/summaries.ts pattern.
// ---------------------------------------------------------------------------

const USD = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function usd(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? `$${USD.format(v)}` : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sourceSuffix(payload: Record<string, unknown>): string {
  const cadName = str(payload.cadName) ?? "county appraisal district";
  const taxYear = num(payload.taxYear);
  return taxYear !== null ? `${cadName} ${taxYear} roll` : cadName;
}

function summarizeCadProperty(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const situs = [str(payload.situsAddress), str(payload.situsCity)]
    .filter(Boolean)
    .join(", ");
  if (situs) parts.push(situs);
  const owner = str(payload.ownerName);
  if (owner) parts.push(`Owner ${owner}`);

  const improvement: string[] = [];
  const yearBuilt = num(payload.yearBuilt);
  if (yearBuilt !== null) improvement.push(`built ${yearBuilt}`);
  const sqft = num(payload.livingAreaSqft);
  if (sqft !== null) improvement.push(`${USD.format(sqft)} sqft`);
  const acres = num(payload.landAcres);
  if (acres !== null) improvement.push(`${acres.toFixed(2)} ac`);
  const useCode = str(payload.propertyUseCode);
  if (useCode) improvement.push(`use ${useCode}`);
  if (improvement.length) parts.push(improvement.join(", "));

  // HONESTY: county assessed figure, labeled as such — never "market
  // estimate" / AVM phrasing.
  const market = usd(payload.marketValue);
  if (market) {
    const land = usd(payload.landValue);
    const impr = usd(payload.improvementValue);
    const split =
      land && impr ? ` (land ${land} + improvements ${impr})` : "";
    parts.push(`CAD market value (assessed): ${market}${split}`);
  }
  parts.push(sourceSuffix(payload));
  return parts.join(" · ");
}

function summarizeCadTax(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const assessed = usd(payload.assessedValue);
  const taxYear = num(payload.taxYear);
  if (assessed) {
    parts.push(
      `CAD assessed value ${assessed}${taxYear !== null ? ` (tax year ${taxYear})` : ""}`,
    );
  } else {
    parts.push("No assessed value on the CAD roll row");
  }
  const exemptions = Array.isArray(payload.exemptions)
    ? payload.exemptions
        .filter(isRecord)
        .map((e) => {
          const code = str(e.code);
          const label = str(e.label);
          if (code && label && label !== code) return `${label} (${code})`;
          return code ?? label;
        })
        .filter(Boolean)
    : [];
  parts.push(
    exemptions.length ? `Exemptions: ${exemptions.join(", ")}` : "No exemptions on roll",
  );
  parts.push(
    `County assessed figure, not a market estimate or tax bill — ${sourceSuffix(payload)}`,
  );
  return parts.join(" · ");
}

function summarizeCadOwnerOccupancy(payload: Record<string, unknown>): string {
  const signal = str(payload.signal) ?? "unknown";
  const headline =
    signal === "likely-absentee"
      ? "Likely absentee owner"
      : signal === "likely-owner-occupied"
        ? "Likely owner-occupied"
        : "Owner-occupancy unknown";
  const detail: string[] = [];
  const hs = payload.homesteadExemption;
  if (hs === true) detail.push("homestead exemption on roll");
  if (hs === false) detail.push("no homestead exemption");
  if (hs === null) detail.push("exemption data unavailable");
  const cmp = str(payload.mailingMatchesSitus);
  if (cmp === "same") detail.push("mailing matches situs");
  if (cmp === "different") detail.push("mailing differs from situs");
  if (cmp === "unknown") detail.push("mailing/situs comparison inconclusive");
  return `${headline} — ${CAD_OWNER_OCCUPANCY_METHOD} (${detail.join("; ")}) · ${sourceSuffix(payload)}`;
}

/**
 * Single-entry-point dispatcher for the `cad:*` layer kinds. Returns
 * `null` for any other layer kind so `brokerageSiteContext.layerSummary`
 * can chain it after the federal/state/cotality summarizers.
 */
export function summarizeCadPayload(
  layerKind: string,
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  switch (layerKind) {
    case "cad-property":
      return payload.kind === "cad-property" ? summarizeCadProperty(payload) : null;
    case "cad-tax":
      return payload.kind === "cad-tax" ? summarizeCadTax(payload) : null;
    case "cad-owner-occupancy":
      return payload.kind === "cad-owner-occupancy"
        ? summarizeCadOwnerOccupancy(payload)
        : null;
    default:
      return null;
  }
}
