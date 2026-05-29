import { createHash } from "node:crypto";
import { CACHE_COORDINATE_PRECISION } from "@workspace/adapters";

export function roundPlaceCoord(value: number): number {
  const factor = 10 ** CACHE_COORDINATE_PRECISION;
  return Math.round(value * factor) / factor;
}

export function formatPlaceCoord(value: number): string {
  return value.toFixed(CACHE_COORDINATE_PRECISION);
}

export function placeKeyFromCoords(lat: number, lng: number): string {
  return `coord:${formatPlaceCoord(roundPlaceCoord(lat))}:${formatPlaceCoord(roundPlaceCoord(lng))}`;
}

export function contentHashForPayload(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function extractLlUuidFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const parcel = payload.parcel as
    | { properties?: { fields?: Record<string, unknown> } }
    | undefined;
  const fields = parcel?.properties?.fields;
  if (!fields) return null;
  const raw = fields.ll_uuid ?? fields.llUuid;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return null;
}
