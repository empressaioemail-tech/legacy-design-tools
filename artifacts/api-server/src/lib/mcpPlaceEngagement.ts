/**
 * Resolve or create an engagement for MCP place-scoped hydrology routes.
 *
 * External MCP callers may only have an address or placeKey — not an
 * architect engagement. This helper materializes a deterministic
 * service engagement keyed by placeKey and reuses the engagement-scoped
 * site-topography / site-drainage ingest workers internally.
 */

import { eq } from "drizzle-orm";
import { db, engagements as engagementsTable } from "@workspace/db";
import {
  parseCoordPlaceKey,
  resolvePlace,
  type PlaceResolveInput,
} from "./placeResolve";
import {
  computeEngagementCoverage,
  coverageFieldsFromResolved,
} from "./engagementCoverage";
import { SERVICE_PLACE_OWNER_USER_ID } from "./anonymousOwnerCookie";

export const MCP_PLACE_ENGAGEMENT_PREFIX = "mcp-place:";

export type EnsureMcpPlaceEngagementInput =
  | { placeKey: string; address?: string }
  | { address: string }
  | { lat: number; lng: number; address?: string };

export type EnsureMcpPlaceEngagementResult =
  | {
      ok: true;
      engagementId: string;
      placeKey: string;
      address: string | null;
      created: boolean;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

function engagementNameForPlaceKey(placeKey: string): string {
  return `${MCP_PLACE_ENGAGEMENT_PREFIX}${placeKey}`;
}

async function geocodeFromPlaceKey(
  placeKey: string,
  addressHint?: string,
): Promise<
  | {
      placeKey: string;
      lat: number;
      lng: number;
      city: string | null;
      state: string | null;
      address: string | null;
    }
  | EnsureMcpPlaceEngagementResult
> {
  const coord = parseCoordPlaceKey(placeKey);
  if (coord) {
    let city: string | null = null;
    let state: string | null = null;
    if (addressHint) {
      const resolved = await resolvePlace({ address: addressHint });
      if (!("errorClass" in resolved)) {
        city = resolved.geocode.city;
        state = resolved.geocode.state;
      }
    }
    return {
      placeKey,
      lat: coord.lat,
      lng: coord.lng,
      city,
      state,
      address: addressHint ?? null,
    };
  }

  if (addressHint) {
    const resolved = await resolvePlace({ address: addressHint });
    if ("errorClass" in resolved) {
      return {
        ok: false,
        status: resolved.errorClass === "geocode_miss" ? 422 : 400,
        body: resolved,
      };
    }
    return {
      placeKey: resolved.placeKey,
      lat: resolved.geocode.lat,
      lng: resolved.geocode.lng,
      city: resolved.geocode.city,
      state: resolved.geocode.state,
      address: addressHint,
    };
  }

  return {
    ok: false,
    status: 404,
    body: {
      error: "not_found",
      message: "Unknown placeKey — resolve an address first",
    },
  };
}

export async function ensureMcpPlaceEngagement(
  input: EnsureMcpPlaceEngagementInput & { jurisdictionTenant?: string | null },
): Promise<EnsureMcpPlaceEngagementResult> {
  let placeKey: string;
  let lat: number;
  let lng: number;
  let city: string | null = null;
  let state: string | null = null;
  let address: string | null = null;

  if ("placeKey" in input && input.placeKey.trim()) {
    const geo = await geocodeFromPlaceKey(
      input.placeKey.trim(),
      input.address?.trim(),
    );
    if ("ok" in geo) return geo;
    placeKey = geo.placeKey;
    lat = geo.lat;
    lng = geo.lng;
    city = geo.city;
    state = geo.state;
    address = geo.address;
  } else if ("address" in input && input.address?.trim()) {
    const addressText = input.address.trim();
    const resolved = await resolvePlace({ address: addressText });
    if ("errorClass" in resolved) {
      return {
        ok: false,
        status: resolved.errorClass === "geocode_miss" ? 422 : 400,
        body: resolved,
      };
    }
    placeKey = resolved.placeKey;
    lat = resolved.geocode.lat;
    lng = resolved.geocode.lng;
    city = resolved.geocode.city;
    state = resolved.geocode.state;
    address = addressText;
  } else if ("lat" in input && "lng" in input) {
    const resolved = await resolvePlace({
      lat: input.lat,
      lng: input.lng,
      address: input.address,
    });
    if ("errorClass" in resolved) {
      return {
        ok: false,
        status: resolved.errorClass === "geocode_miss" ? 422 : 400,
        body: resolved,
      };
    }
    placeKey = resolved.placeKey;
    lat = resolved.geocode.lat;
    lng = resolved.geocode.lng;
    city = resolved.geocode.city;
    state = resolved.geocode.state;
    address = input.address?.trim() ?? null;
  } else {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_request",
        message: "address or placeKey required",
      },
    };
  }

  const name = engagementNameForPlaceKey(placeKey);
  const nameLower = name.toLowerCase();

  const [existing] = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(eq(engagementsTable.nameLower, nameLower))
    .limit(1);

  const tenantKey = (input.jurisdictionTenant ?? "").trim() || null;

  if (existing) {
    await db
      .update(engagementsTable)
      .set({
        address: address ?? undefined,
        latitude: String(lat),
        longitude: String(lng),
        jurisdictionCity: city,
        jurisdictionState: state,
        geocodedAt: new Date(),
        geocodeSource: "mcp-place",
        ...(tenantKey ? { cortexJurisdictionKey: tenantKey } : {}),
        updatedAt: new Date(),
      })
      .where(eq(engagementsTable.id, existing.id));

    return {
      ok: true,
      engagementId: existing.id,
      placeKey,
      address,
      created: false,
    };
  }

  const coverage = await computeEngagementCoverage({
    jurisdictionCity: city,
    jurisdictionState: state,
    address: address ?? placeKey,
  });

  const [created] = await db
    .insert(engagementsTable)
    .values({
      name,
      nameLower,
      address,
      latitude: String(lat),
      longitude: String(lng),
      jurisdictionCity: city,
      jurisdictionState: state,
      geocodedAt: new Date(),
      geocodeSource: "mcp-place",
      status: "active",
      // MCP/place callers have no authenticated user, but migration 0038 made
      // engagements.owner_user_id NOT NULL (with no DB-level default — 0038/0039
      // only backfill + SET NOT NULL). Omitting it throws Postgres 23502 and
      // 503s the place/terrain routes. Supply a documented service principal so
      // the ownership invariant holds; owner_user_id is plain text with no users
      // FK, and isolation for these rows is via tenant_id / cortexJurisdictionKey.
      ownerUserId: SERVICE_PLACE_OWNER_USER_ID,
      ...(tenantKey ? { cortexJurisdictionKey: tenantKey } : {}),
      ...coverageFieldsFromResolved(coverage),
    })
    .returning({ id: engagementsTable.id });

  if (!created) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "internal_error",
        message: "Failed to create MCP place engagement",
      },
    };
  }

  return {
    ok: true,
    engagementId: created.id,
    placeKey,
    address,
    created: true,
  };
}

export function placeResolveInputFromBody(
  body: Record<string, unknown>,
): PlaceResolveInput | null {
  const address =
    typeof body.address === "string" ? body.address.trim() : "";
  const lat =
    typeof body.lat === "number" && Number.isFinite(body.lat)
      ? body.lat
      : null;
  const lng =
    typeof body.lng === "number" && Number.isFinite(body.lng)
      ? body.lng
      : null;

  if (address) return { address };
  if (lat != null && lng != null) {
    return { lat, lng, address: address || undefined };
  }
  return null;
}
