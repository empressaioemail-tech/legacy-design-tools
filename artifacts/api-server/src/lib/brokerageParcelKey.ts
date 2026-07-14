/**
 * Universal parcel-key capture — provider-neutral join key (was 75i task 7,
 * Cotality-CLIP-canonical; widened when the Cotality OAuth rail went dark).
 *
 * Key precedence:
 *   1. Explicit CLIP paste — stays a bare CLIP key (legacy key space).
 *   2. Cotality CLIP resolution — attempted ONLY when property credentials
 *      are configured, bounded by a short timeout; failure falls through
 *      instead of failing capture (a dark vendor never breaks capture).
 *   3. County APN — `apn:<countyFips>:<apn>` from the public county
 *      appraisal-district point lookup (`brokerageParcelApn.ts`): live
 *      county ArcGIS for the #242 counties, the self-hosted TxGIO
 *      parcel geometry store for Hays/Comal (provider "txgio").
 *   4. Geo key — `geo:<lat-5dp>,<lng-5dp>`, always available once the
 *      input geocodes or carries coordinates.
 *
 * Existing stored bare-CLIP keys remain valid; `parcelKeyKind` classifies
 * any stored key. Component fields (clip / apn / countyFips / lat / lng /
 * address) ride alongside the key so a later re-key or merge is possible.
 * County-GIS-derived keys carry provenance (provider, sourceUrl,
 * retrievedAt). Adapters are optional enrichment; the key primitive is
 * reusable (Mox).
 */

import {
  resolveCotalityClip,
  readCotalityAppCredentials,
  type CotalityClipContext,
} from "@workspace/adapters/national/cotalityClient";
import { geocodeAddress } from "@workspace/site-context/server";
import { resolveCountyApnByPoint } from "./brokerageParcelApn";
import { makeTxgioParcelPointLookup } from "./txgioParcelStore";

export type ParcelKeySource =
  | "address-geocode"
  | "clip-paste"
  | "coordinates"
  | "auto-detect";

export type ParcelKeyKind = "clip" | "apn" | "geo";

export interface ParcelKeyProvenance {
  provider: "cotality" | "county-gis" | "txgio" | "user-paste" | "geocode";
  sourceUrl: string | null;
  retrievedAt: string;
}

export interface ParcelKeyCaptureInput {
  address?: string | null;
  clip?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  source?: ParcelKeySource;
}

export interface ParcelKeyCaptureResult {
  /** Canonical join key: bare CLIP, `apn:<fips>:<apn>`, or `geo:<lat>,<lng>`. */
  parcelKey: string;
  keyKind: ParcelKeyKind;
  /** Cotality CLIP when resolved (or pasted); null when the vendor is dark. */
  clip: string | null;
  /** County appraisal-district parcel id when resolved via county GIS. */
  apn: string | null;
  /** Five-digit county FIPS accompanying `apn`. */
  countyFips: string | null;
  source: ParcelKeySource;
  latitude: number;
  longitude: number;
  address: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  censusTractFips: string | null;
  provenance: ParcelKeyProvenance;
}

const CLIP_RE = /^\d{10,}$/;

/**
 * Upper bound on the CLIP resolution attempt. A dark or slow vendor must
 * not stall capture; on timeout the capture falls through to APN/geo.
 */
const CLIP_RESOLVE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PARCEL_KEY_CLIP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
})();

export function formatApnParcelKey(countyFips: string, apn: string): string {
  return `apn:${countyFips}:${apn}`;
}

export function formatGeoParcelKey(latitude: number, longitude: number): string {
  return `geo:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
}

/**
 * Classify a stored parcel key. Existing rows hold bare Cotality CLIPs
 * (10+ digits); those keys stay valid as-is. Unknown shapes classify as
 * null so callers can treat legacy oddities conservatively.
 */
export function parcelKeyKind(key: string): ParcelKeyKind | null {
  const k = key.trim();
  if (!k) return null;
  if (k.startsWith("apn:")) return "apn";
  if (k.startsWith("geo:")) return "geo";
  if (CLIP_RE.test(k)) return "clip";
  return null;
}

function censusTractFromClipContext(ctx: CotalityClipContext): string | null {
  const raw = (ctx.raw as Record<string, unknown> | undefined)?.censusTractFips;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Attempt CLIP resolution without ever throwing. Returns null when the
 * vendor credentials are absent, the resolver fails, or it exceeds the
 * timeout — capture then falls through to the neutral key forms.
 */
async function tryResolveClip(args: {
  latitude: number;
  longitude: number;
  address: string | null;
  city: string | null;
  state: string | null;
}): Promise<CotalityClipContext | null> {
  if (!readCotalityAppCredentials("property")) return null;
  try {
    return await resolveCotalityClip({
      latitude: args.latitude,
      longitude: args.longitude,
      address: args.address,
      city: args.city,
      state: args.state,
      signal: AbortSignal.timeout(CLIP_RESOLVE_TIMEOUT_MS),
      adapterKeyForLog: "brokerage:parcel-key-capture",
    });
  } catch {
    return null;
  }
}

export async function captureParcelKey(
  input: ParcelKeyCaptureInput,
): Promise<ParcelKeyCaptureResult> {
  const pastedClip = input.clip?.trim() ?? "";
  if (pastedClip && CLIP_RE.test(pastedClip)) {
    const lat = input.latitude ?? 0;
    const lon = input.longitude ?? 0;
    return {
      parcelKey: pastedClip,
      keyKind: "clip",
      clip: pastedClip,
      apn: null,
      countyFips: null,
      source: "clip-paste",
      latitude: Number.isFinite(lat) ? lat! : 0,
      longitude: Number.isFinite(lon) ? lon! : 0,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      county: null,
      censusTractFips: null,
      provenance: {
        provider: "user-paste",
        sourceUrl: null,
        retrievedAt: new Date().toISOString(),
      },
    };
  }

  let lat = input.latitude ?? null;
  let lon = input.longitude ?? null;
  let address = input.address?.trim() ?? null;
  let city = input.city ?? null;
  let state = input.state ?? null;

  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && address) {
    const geo = await geocodeAddress(address);
    if (geo) {
      lat = geo.latitude;
      lon = geo.longitude;
      city = geo.jurisdictionCity ?? city;
      state = geo.jurisdictionState ?? state;
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("parcel_key_capture_requires_address_or_coordinates");
  }

  const source: ParcelKeySource =
    input.source ?? (address ? "address-geocode" : "coordinates");

  const base = {
    source,
    latitude: lat!,
    longitude: lon!,
    address,
    city,
    state,
  };

  // 1. Cotality CLIP — only when configured; never fails capture.
  const clipCtx = await tryResolveClip({
    latitude: lat!,
    longitude: lon!,
    address,
    city,
    state,
  });
  if (clipCtx) {
    return {
      ...base,
      parcelKey: clipCtx.clip,
      keyKind: "clip",
      clip: clipCtx.clip,
      apn: null,
      countyFips: null,
      county: clipCtx.county ?? null,
      censusTractFips: censusTractFromClipContext(clipCtx),
      provenance: {
        provider: "cotality",
        sourceUrl: null,
        retrievedAt: new Date().toISOString(),
      },
    };
  }

  // 2. County-GIS APN — public-record neutral key.
  try {
    const apnHit = await resolveCountyApnByPoint({
      latitude: lat!,
      longitude: lon!,
      // Store-backed counties (Hays/Comal): resolve against the
      // self-hosted TxGIO parcel geometry.
      parcelPointLookup: makeTxgioParcelPointLookup(),
    });
    if (apnHit) {
      return {
        ...base,
        parcelKey: formatApnParcelKey(apnHit.countyFips, apnHit.apn),
        keyKind: "apn",
        clip: null,
        apn: apnHit.apn,
        countyFips: apnHit.countyFips,
        county: apnHit.countyName,
        censusTractFips: null,
        provenance: {
          provider: apnHit.provider,
          sourceUrl: apnHit.sourceUrl,
          retrievedAt: apnHit.retrievedAt,
        },
      };
    }
  } catch {
    // County upstream failure — fall through to the geo key.
  }

  // 3. Geo key — always available once coordinates exist.
  return {
    ...base,
    parcelKey: formatGeoParcelKey(lat!, lon!),
    keyKind: "geo",
    clip: null,
    apn: null,
    countyFips: null,
    county: null,
    censusTractFips: null,
    provenance: {
      provider: "geocode",
      sourceUrl: null,
      retrievedAt: new Date().toISOString(),
    },
  };
}

export function extractClipFromSiteContext(
  layers: Array<{ layerKind: string; status: string; payload?: Record<string, unknown> }>,
): string | null {
  for (const layer of layers) {
    if (layer.status !== "ok" || !layer.payload) continue;
    const clip = layer.payload.clip;
    if (typeof clip === "string" && clip.trim()) return clip.trim();
    const parcel = layer.payload.parcel as
      | { properties?: Record<string, unknown> }
      | undefined;
    const fromProps = parcel?.properties?.clip;
    if (typeof fromProps === "string" && fromProps.trim()) return fromProps.trim();
  }
  return null;
}
