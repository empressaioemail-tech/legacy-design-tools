import { geocodeAddress } from "@workspace/site-context/server";
import { keyFromEngagement } from "@workspace/codes";
import {
  buildPropertyWorkspaceDid,
  extractLlUuidFromSiteContext,
} from "./brokerageBriefAtoms";
import { listingKeyFromAddress } from "./brokerageWorkspace";
import { fetchBrokerageSiteContext } from "./brokerageSiteContext";
import {
  placeKeyFromCoords,
  formatPlaceCoord,
  roundPlaceCoord,
} from "./placeLayerUtils";
import type { GtmErrorClass } from "./gtmErrorClass";

export type PlaceResolveInput =
  | { address: string; lat?: never; lng?: never }
  | { address?: string; lat: number; lng: number };

export type PlaceResolveSuccess = {
  placeKey: string;
  jurisdiction_key: string | null;
  ll_uuid: string | null;
  workspaceDid: string | null;
  geocode: {
    lat: number;
    lng: number;
    city: string | null;
    state: string | null;
    confidence: "high" | "coordinates" | "low";
    /**
     * Which geocode ladder rung produced the point (F4d). Only "street"
     * is rooftop-grade; "locality"/"zip" are centroids and must NOT be
     * treated as a precise point. Absent when the point came from
     * explicit caller coordinates (see `confidence: "coordinates"`).
     */
    matchRung?: "street" | "locality" | "zip";
  };
};

export type PlaceResolveFailure = {
  errorClass: GtmErrorClass;
  error: string;
  message: string;
};

export function parseCoordPlaceKey(
  placeKey: string,
): { lat: number; lng: number } | null {
  const m = /^coord:([^:]+):([^:]+)$/.exec(placeKey.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export async function resolvePlace(
  input: PlaceResolveInput,
): Promise<PlaceResolveSuccess | PlaceResolveFailure> {
  let lat: number;
  let lng: number;
  let city: string | null = null;
  let state: string | null = null;
  let confidence: PlaceResolveSuccess["geocode"]["confidence"] = "high";
  let matchRung: PlaceResolveSuccess["geocode"]["matchRung"];
  const address = "address" in input ? input.address : undefined;

  if ("lat" in input && input.lat != null && input.lng != null) {
    lat = roundPlaceCoord(input.lat);
    lng = roundPlaceCoord(input.lng);
    confidence = "coordinates";
    if (address) {
      try {
        const geo = await geocodeAddress(address);
        if (geo) {
          city = geo.jurisdictionCity ?? null;
          state = geo.jurisdictionState ?? null;
        }
      } catch {
        confidence = "low";
      }
    }
  } else if (address) {
    let geo: Awaited<ReturnType<typeof geocodeAddress>> | null = null;
    try {
      geo = await geocodeAddress(address);
    } catch {
      geo = null;
    }
    if (!geo) {
      return {
        errorClass: "geocode_miss",
        error: "geocode_miss",
        message: "Could not geocode the provided address",
      };
    }
    lat = roundPlaceCoord(geo.latitude);
    lng = roundPlaceCoord(geo.longitude);
    city = geo.jurisdictionCity ?? null;
    state = geo.jurisdictionState ?? null;
    matchRung = geo.matchRung;
    // A coarse (non-street) rung is a locality/ZIP centroid, not a
    // rooftop — reflect that honestly instead of the "high" default.
    if (geo.matchRung && geo.matchRung !== "street") confidence = "low";
  } else {
    return {
      errorClass: "validation_error",
      error: "invalid_request",
      message: "Provide address or lat/lng",
    };
  }

  const placeKey = placeKeyFromCoords(lat, lng);
  const jurisdiction_key = keyFromEngagement({
    jurisdictionCity: city,
    jurisdictionState: state,
    address: address ?? `${formatPlaceCoord(lat)},${formatPlaceCoord(lng)}`,
  });

  let ll_uuid: string | null = null;
  try {
    const siteContext = await fetchBrokerageSiteContext({
      latitude: lat,
      longitude: lng,
      address,
      jurisdictionCity: city,
      jurisdictionState: state,
    });
    ll_uuid = extractLlUuidFromSiteContext(siteContext);
  } catch {
    /* parcel layers optional for resolve */
  }

  const listingKey = address
    ? listingKeyFromAddress(address)
    : placeKey;
  const workspaceDid = buildPropertyWorkspaceDid(listingKey);

  return {
    placeKey,
    jurisdiction_key,
    ll_uuid,
    workspaceDid,
    geocode: { lat, lng, city, state, confidence, matchRung },
  };
}
