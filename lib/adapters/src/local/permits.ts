/**
 * `permits:record` Property Brief adapter — the "rehab reality" slot
 * served from the OWNED municipal issued-permit corpus in the
 * `permit_record` store (feat/permits-brief-slot). Provider-neutral
 * replacement for the dormant `cotality:permits` adapter on the brief
 * path.
 *
 * Corpus ground truth (public-record acquisition, calibrated-spine
 * Wave 3, acquired 2026-06-21; raw CSVs land in
 * `gs://hauska-calibration-raw/backtest/{metro}/permit/open_data/`):
 *
 *   austin_tx        ~2.36M issued construction permits, 1921 → present
 *                    (City of Austin open data, resource 3syk-w9eu).
 *   san_antonio_tx   ~487K building permits, 2020-07 → present (City of
 *                    San Antonio open data). Permits before 2020-07 live
 *                    in the city's Hansen legacy portal and were NOT
 *                    bulk-acquirable — that history gap is real and the
 *                    summary/no-coverage copy must never imply pre-2020
 *                    SA coverage.
 *
 * HONESTY REQUIREMENTS (load-bearing, tested):
 *   - MATCH STRATEGY IS FUZZY AND SAYS SO. Matching is an exact-equality
 *     join on a normalized street line (first comma-segment, uppercased,
 *     punctuation stripped, suffix/directional tokens normalized, one
 *     trailing ZIP token dropped). Unit-level permits, address rewrites,
 *     range addresses, and permits filed under a different address form
 *     for the same parcel WILL miss, and multi-unit street addresses can
 *     over-match. The payload carries the match method + caveat verbatim
 *     and the summary discloses "matched by street address".
 *     Austin rows carry a TCAD ID, but it is the export's geo-format id
 *     while the county GIS point query returns PROP_ID; the
 *     correspondence is unverified, so v1 does NOT match on it (stored
 *     for a future verified id-join).
 *   - Valuations are the applicant's DECLARED figures, never an
 *     appraisal or cost estimate.
 *   - Coverage is Austin + San Antonio issuance records only. Everywhere
 *     else — including the rest of Central TX — is an honest
 *     no-coverage, not a websearch guess.
 *
 * Plumbing mirrors the `cad:*` adapters (#245/#246): gated on an
 * injected `ctx.permitLookup` accessor (this package must not import
 * `@workspace/db`); the api-server injects a drizzle-backed
 * implementation on the brief site-context path. A live run costs one
 * local Postgres read — no network.
 */

import {
  AdapterRunError,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type PermitHistoryMatch,
  type PermitMetroKey,
} from "../types";
import { normalizeAddressLine } from "./cad";
import { isRecord } from "../_payloadSummaryHelpers";

/** Static provider label (archived-snapshot fallback). */
const PERMITS_STATIC_PROVIDER =
  "City issued-permit records (public record)";

/** Most-recent-N permits returned per parcel/address. */
export const PERMIT_HISTORY_LIMIT = 10;

/**
 * Disclosed match caveat — verbatim in the payload so downstream
 * consumers (reasoning layers, UI chips) can surface it without
 * re-deriving the honesty language.
 */
export const PERMIT_MATCH_CAVEAT =
  "Exact match on a normalized street line. Unit-level permits, address rewrites, and range addresses can miss; multi-unit street addresses can over-match. Not a parcel-id join.";

export interface PermitMetroSource {
  /** Corpus jurisdiction slug — matches `permit_record.metro`. */
  metro: PermitMetroKey;
  /** Issuing-jurisdiction label for provider strings and summaries. */
  label: string;
  /** Public open-data portal the corpus was acquired from (provenance). */
  sourcePortal: string;
  /** Public-record acquisition date (GCS `acquired=` partition). */
  acquiredDate: string;
  /** Honest coverage window of the acquired corpus. */
  coverageNote: string;
  /**
   * Generous WGS84 routing bbox (issuing jurisdiction + ETJ). Routing
   * only — the address match at run time is the real coverage gate, and
   * a zero-match inside the bbox is an honest no-coverage.
   */
  bbox: { westLng: number; southLat: number; eastLng: number; northLat: number };
  centroid: { latitude: number; longitude: number };
}

/**
 * Covered metros. Bboxes are generous hulls of the issuing
 * jurisdiction + ETJ (Austin spans Travis plus slivers of
 * Williamson/Hays; San Antonio sits inside Bexar), mirroring the
 * routing-bbox convention in `txCountyApn.ts`.
 */
export const PERMIT_METRO_SOURCES: readonly PermitMetroSource[] = [
  {
    metro: "austin_tx",
    label: "City of Austin",
    sourcePortal:
      "https://data.austintexas.gov/Resource-Explorer/3syk-w9eu/",
    acquiredDate: "2026-06-21",
    coverageNote:
      "Issued construction permits, City of Austin + ETJ issuance, 1921 to acquisition date.",
    bbox: { westLng: -98.05, southLat: 30.02, eastLng: -97.42, northLat: 30.61 },
    centroid: { latitude: 30.28, longitude: -97.74 },
  },
  {
    metro: "san_antonio_tx",
    label: "City of San Antonio",
    sourcePortal: "https://data.sanantonio.gov/dataset/building-permits",
    acquiredDate: "2026-06-21",
    coverageNote:
      "Building permits, City of San Antonio issuance, 2020-07 to acquisition date (pre-2020 Hansen-era permits not acquired).",
    bbox: { westLng: -98.82, southLat: 29.18, eastLng: -98.2, northLat: 29.73 },
    centroid: { latitude: 29.46, longitude: -98.5 },
  },
];

/**
 * Route a point to a covered metro: bbox containment, nearest centroid
 * on overlap (none today, but keeps the convention). Null = no covered
 * metro — the honest majority case.
 */
export function resolvePermitMetro(
  latitude: number,
  longitude: number,
): PermitMetroSource | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  let best: PermitMetroSource | null = null;
  let bestDist = Infinity;
  for (const metro of PERMIT_METRO_SOURCES) {
    const inBbox =
      longitude >= metro.bbox.westLng &&
      longitude <= metro.bbox.eastLng &&
      latitude >= metro.bbox.southLat &&
      latitude <= metro.bbox.northLat;
    if (!inBbox) continue;
    const dLat = latitude - metro.centroid.latitude;
    const dLng = longitude - metro.centroid.longitude;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < bestDist) {
      best = metro;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Canonical street-line match key — THE one normalization both sides of
 * the join use (`@workspace/cad-ingest`'s permits-ingest imports this
 * for `permit_record.address_normalized`; the adapter applies it to the
 * subject address at query time; drift here silently zeroes the match
 * rate).
 *
 * First comma-segment → `normalizeAddressLine` (uppercase, strip
 * punctuation, normalize suffix/directional tokens) → drop one trailing
 * standalone 5-digit token (dirty SA rows embed the ZIP in the street
 * line). Null when no leading house number remains — a key without a
 * house number would over-match an entire street.
 */
export function permitStreetKey(
  address: string | null | undefined,
): string | null {
  if (!address) return null;
  const firstSegment = address.split(",")[0] ?? "";
  let key = normalizeAddressLine(firstSegment);
  key = key.replace(/\s+\d{5}$/, "");
  if (!/^\d+\s+\S/.test(key)) return null;
  return key;
}

function permitsApplies(ctx: AdapterContext): boolean {
  if (!ctx.permitLookup) return false;
  if (ctx.jurisdiction.stateKey && ctx.jurisdiction.stateKey !== "texas") {
    return false;
  }
  const { latitude, longitude, state, address } = ctx.parcel;
  if (
    typeof state === "string" &&
    state.trim() &&
    !/^(tx|texas)$/i.test(state.trim())
  ) {
    return false;
  }
  if (!resolvePermitMetro(latitude, longitude)) return false;
  // Matching is address-based; without a usable street key the run is a
  // guaranteed miss, so gate off instead of burning a query.
  if (!permitStreetKey(address)) return false;
  return true;
}

const USD = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function yearOf(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const y = Number(isoDate.slice(0, 4));
  return Number.isFinite(y) && y > 1800 ? y : null;
}

export const permitsRecordAdapter: Adapter = {
  adapterKey: "permits:record",
  tier: "local",
  sourceKind: "local-adapter",
  layerKind: "permits-history",
  provider: PERMITS_STATIC_PROVIDER,
  jurisdictionGate: { state: "texas" },
  appliesTo: permitsApplies,
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const { latitude, longitude, address } = ctx.parcel;
    const metro = resolvePermitMetro(latitude, longitude);
    if (!metro) {
      throw new AdapterRunError(
        "no-coverage",
        "Point is outside the covered permit metros (City of Austin, City of San Antonio). No permit corpus exists for this jurisdiction.",
      );
    }
    if (!ctx.permitLookup) {
      throw new AdapterRunError(
        "no-coverage",
        "Permit records store accessor not available on this path.",
      );
    }
    const streetKey = permitStreetKey(address);
    if (!streetKey) {
      throw new AdapterRunError(
        "no-coverage",
        "No street-address match key could be derived from the subject address (matching requires a house number + street line).",
      );
    }

    const match: PermitHistoryMatch = await ctx.permitLookup(
      metro.metro,
      streetKey,
      PERMIT_HISTORY_LIMIT,
    );

    if (match.totalMatched === 0) {
      throw new AdapterRunError(
        "no-coverage",
        `No permit records matched "${streetKey}" in the ${metro.label} issued-permit corpus (${metro.coverageNote} Street-address match — unit-level and rewritten addresses can miss).`,
      );
    }

    return {
      adapterKey: this.adapterKey,
      tier: this.tier,
      layerKind: this.layerKind,
      sourceKind: this.sourceKind,
      provider: `${metro.label} issued-permit records (public record)`,
      snapshotDate: new Date().toISOString(),
      payload: {
        kind: "permits-history",
        metro: metro.metro,
        metroLabel: metro.label,
        /** HONESTY: disclosed match strategy, verbatim. */
        match: {
          method: "normalized-street-address",
          key: streetKey,
          caveat: PERMIT_MATCH_CAVEAT,
        },
        totalMatched: match.totalMatched,
        returnedCount: match.rows.length,
        /** Most-recent-N by issued date (nulls last). */
        permits: match.rows.map((r) => ({
          permitNumber: r.permitNumber,
          permitType: r.permitType,
          workClass: r.workClass,
          permitClass: r.permitClass,
          status: r.status,
          description: r.description,
          appliedDate: r.appliedDate,
          issuedDate: r.issuedDate,
          /** Applicant-declared valuation, dollars — not an appraisal. */
          declaredValuation: r.valuation,
          addressRaw: r.addressRaw,
        })),
        earliestIssued: match.earliestIssued,
        latestIssued: match.latestIssued,
        coverageNote: metro.coverageNote,
        sourcePortal: metro.sourcePortal,
        acquiredDate: metro.acquiredDate,
        /**
         * The acquisition date is the honest data vintage —
         * `brokerageSiteContext` reads `sourceVintage` into the layer's
         * engineHonesty.dataVintage.
         */
        sourceVintage: metro.acquiredDate,
        retrievedAt: new Date().toISOString(),
      },
    };
  },
};

export const PERMIT_ADAPTERS: ReadonlyArray<Adapter> = [permitsRecordAdapter];

// ---------------------------------------------------------------------------
// Summary chip (brief path) — mirrors ../local/cad.ts's pattern.
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function summarizePermitsHistory(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const total = num(payload.totalMatched) ?? 0;
  const returned = num(payload.returnedCount) ?? 0;
  const earliestYear = yearOf(str(payload.earliestIssued));
  const noun = total === 1 ? "permit" : "permits";
  let headline = `${total} ${noun} on record`;
  if (earliestYear !== null) headline += ` since ${earliestYear}`;
  if (total > returned && returned > 0) headline += ` (showing ${returned})`;
  parts.push(headline);

  const permits = Array.isArray(payload.permits)
    ? payload.permits.filter(isRecord)
    : [];
  const latest = permits[0];
  if (latest) {
    const bits: string[] = [];
    const issued = str(latest.issuedDate);
    const type = str(latest.permitType) ?? str(latest.permitNumber) ?? "permit";
    const workClass = str(latest.workClass);
    const status = str(latest.status);
    const valuation = num(latest.declaredValuation);
    let line = `latest ${issued ?? "undated"}: ${type}`;
    if (workClass) line += ` (${workClass})`;
    if (status) line += ` — ${status}`;
    bits.push(line);
    // HONESTY: declared figure, labeled as such.
    if (valuation !== null) bits.push(`declared valuation $${USD.format(valuation)}`);
    parts.push(bits.join(", "));
  }

  // HONESTY: the match method is part of the chip, not fine print.
  parts.push("matched by street address (unit-level/rewritten addresses can miss)");

  const label = str(payload.metroLabel) ?? "city";
  const acquired = str(payload.acquiredDate);
  parts.push(
    `${label} issued-permit records${acquired ? `, acquired ${acquired}` : ""}`,
  );
  return parts.join(" · ");
}

/**
 * Single-entry-point dispatcher for the `permits-history` layer kind.
 * Returns `null` for any other layer kind so
 * `brokerageSiteContext.layerSummary` can chain it after the
 * federal/state/cad summarizers.
 */
export function summarizePermitsPayload(
  layerKind: string,
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (layerKind !== "permits-history") return null;
  return payload.kind === "permits-history"
    ? summarizePermitsHistory(payload)
    : null;
}
