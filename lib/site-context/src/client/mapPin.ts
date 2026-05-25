import type { BriefingSourceForOverlays } from "./overlays";
import { extractBriefingSourceOverlays } from "./overlays";

function centroidOfRing(ring: Array<[number, number]>): [number, number] | null {
  if (ring.length < 3) return null;
  let latSum = 0;
  let lngSum = 0;
  for (const [lat, lng] of ring) {
    latSum += lat;
    lngSum += lng;
  }
  return [latSum / ring.length, lngSum / ring.length];
}

function rooftopFromSource(source: BriefingSourceForOverlays): [number, number] | null {
  const payload = source.payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const location = record.location;
  if (location && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    const lat = loc.y ?? loc.lat ?? loc.latitude;
    const lng = loc.x ?? loc.lng ?? loc.longitude;
    if (
      typeof lat === "number" &&
      typeof lng === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    ) {
      return [lat, lng];
    }
  }
  const parcel = record.parcel;
  if (parcel && typeof parcel === "object") {
    const props = (parcel as Record<string, unknown>).properties;
    if (props && typeof props === "object") {
      const fields =
        (props as Record<string, unknown>).fields ??
        (props as Record<string, unknown>);
      if (fields && typeof fields === "object") {
        const f = fields as Record<string, unknown>;
        const lat = f.lat ?? f.latitude ?? f.ll_lat;
        const lng = f.lon ?? f.lng ?? f.longitude ?? f.ll_lon;
        if (
          typeof lat === "number" &&
          typeof lng === "number" &&
          Number.isFinite(lat) &&
          Number.isFinite(lng)
        ) {
          return [lat, lng];
        }
      }
    }
  }
  return null;
}

/**
 * Prefer parcel polygon centroid or adapter rooftop coordinates over
 * coarse geocode when briefing layers are available.
 */
export function resolveMapPinPosition(
  geocode: { latitude: number; longitude: number },
  sources: ReadonlyArray<BriefingSourceForOverlays>,
): { latitude: number; longitude: number } {
  for (const source of sources) {
    if (source.supersededAt) continue;
    const rooftop = rooftopFromSource(source);
    if (rooftop) {
      return { latitude: rooftop[0], longitude: rooftop[1] };
    }
  }

  const overlays = extractBriefingSourceOverlays(sources);
  for (const overlay of overlays) {
    if (overlay.kind !== "polygon") continue;
    if (!overlay.layerKind.includes("parcel")) continue;
    const ring = overlay.positions[0];
    if (!ring) continue;
    const centroid = centroidOfRing(ring);
    if (centroid) {
      return { latitude: centroid[0], longitude: centroid[1] };
    }
  }

  return geocode;
}
