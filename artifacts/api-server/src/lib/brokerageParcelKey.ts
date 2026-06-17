/**
 * Universal parcel-key capture — canonical Cotality CLIP as join key (75i task 7).
 *
 * Supports address geocode, explicit CLIP paste, and lat/lon select-to-analyze.
 * Adapters are optional enrichment; the key primitive is reusable (Mox).
 */

import {
  resolveCotalityClip,
  type CotalityClipContext,
} from "@workspace/adapters/national/cotalityClient";
import { geocodeAddress } from "@workspace/site-context/server";

export type ParcelKeySource =
  | "address-geocode"
  | "clip-paste"
  | "coordinates"
  | "auto-detect";

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
  clip: string;
  source: ParcelKeySource;
  latitude: number;
  longitude: number;
  address: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  censusTractFips: string | null;
}

const CLIP_RE = /^\d{10,}$/;

function censusTractFromClipContext(ctx: CotalityClipContext): string | null {
  const raw = (ctx.raw as Record<string, unknown> | undefined)?.censusTractFips;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export async function captureParcelKey(
  input: ParcelKeyCaptureInput,
): Promise<ParcelKeyCaptureResult> {
  const pastedClip = input.clip?.trim() ?? "";
  if (pastedClip && CLIP_RE.test(pastedClip)) {
    const lat = input.latitude ?? 0;
    const lon = input.longitude ?? 0;
    return {
      clip: pastedClip,
      source: "clip-paste",
      latitude: Number.isFinite(lat) ? lat! : 0,
      longitude: Number.isFinite(lon) ? lon! : 0,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      county: null,
      censusTractFips: null,
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

  const clipCtx = await resolveCotalityClip({
    latitude: lat!,
    longitude: lon!,
    address,
    city,
    state,
    adapterKeyForLog: "brokerage:parcel-key-capture",
  });

  const source: ParcelKeySource =
    input.source ??
    (address ? "address-geocode" : "coordinates");

  return {
    clip: clipCtx.clip,
    source,
    latitude: lat!,
    longitude: lon!,
    address,
    city,
    state,
    county: clipCtx.county ?? null,
    censusTractFips: censusTractFromClipContext(clipCtx),
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
