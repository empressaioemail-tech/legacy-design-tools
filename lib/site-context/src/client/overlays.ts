/**
 * Briefing-source → SiteMap overlay extraction.
 *
 * Recognized payload shapes (catalogued from `lib/adapters/src/**`):
 *   - `payload.parcel.geometry`, `payload.zoning.geometry`,
 *     `payload.features[].geometry` — ArcGIS polygon rings (wkid
 *     4326 or 102100/3857; the latter is unprojected to WGS84).
 *   - `payload.location.{x, y}` — WGS84 point (e.g. USGS NED).
 *
 * Anything malformed, missing, or of an unknown shape is skipped so
 * the map falls back to the parcel pin instead of throwing.
 */

// Local structural type so site-context does not depend on
// api-client-react. The real `EngagementBriefingSource` assigns to
// this without a cast.
export interface BriefingSourceForOverlays {
  id: string;
  layerKind: string;
  sourceKind:
    | "federal-adapter"
    | "state-adapter"
    | "local-adapter"
    | "manual-upload"
    | (string & {});
  provider: string | null;
  payload: { [key: string]: unknown } | unknown;
  supersededAt: Date | string | null;
}

export type SiteMapOverlayTier = "federal" | "state" | "local" | "manual";

export type SiteMapOverlay =
  | {
      kind: "polygon";
      sourceId: string;
      layerKind: string;
      provider: string | null;
      tier: SiteMapOverlayTier;
      positions: Array<Array<[number, number]>>;
    }
  | {
      kind: "point";
      sourceId: string;
      layerKind: string;
      provider: string | null;
      tier: SiteMapOverlayTier;
      position: [number, number];
    };

function tierForSource(
  kind: BriefingSourceForOverlays["sourceKind"],
): SiteMapOverlayTier {
  if (kind === "federal-adapter") return "federal";
  if (kind === "state-adapter") return "state";
  if (kind === "local-adapter") return "local";
  return "manual";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function webMercatorToLatLng(x: number, y: number): [number, number] {
  const R = 6378137;
  const lng = (x / R) * (180 / Math.PI);
  const lat = (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90;
  return [lat, lng];
}

function projectRingPoint(
  pair: unknown,
  wkid: number,
): [number, number] | null {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const x = pair[0];
  const y = pair[1];
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (wkid === 102100 || wkid === 3857) {
    const [lat, lng] = webMercatorToLatLng(x, y);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  }
  // WGS84 (wkid 4326) — ArcGIS rings are `[lng, lat]`.
  if (y < -90 || y > 90 || x < -180 || x > 180) return null;
  return [y, x];
}

function extractRingsFromArcGisGeometry(
  geometry: unknown,
): Array<Array<[number, number]>> {
  if (!isRecord(geometry)) return [];
  const rings = geometry.rings;
  if (!Array.isArray(rings)) return [];
  let wkid = 4326;
  const sr = geometry.spatialReference;
  if (isRecord(sr) && isFiniteNumber(sr.wkid)) {
    wkid = sr.wkid;
  } else if (isRecord(sr) && isFiniteNumber(sr.latestWkid)) {
    wkid = sr.latestWkid;
  }
  const out: Array<Array<[number, number]>> = [];
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    const projected: Array<[number, number]> = [];
    for (const pair of ring) {
      const point = projectRingPoint(pair, wkid);
      if (point) projected.push(point);
    }
    if (projected.length >= 3) out.push(projected);
  }
  return out;
}

function overlaysFromSource(
  source: BriefingSourceForOverlays,
): SiteMapOverlay[] {
  const payload = source.payload as unknown;
  if (!isRecord(payload)) return [];
  const tier = tierForSource(source.sourceKind);
  const base = {
    sourceId: source.id,
    layerKind: source.layerKind,
    provider: source.provider,
    tier,
  } as const;
  const out: SiteMapOverlay[] = [];

  if (isRecord(payload.parcel)) {
    const rings = extractRingsFromArcGisGeometry(
      (payload.parcel as Record<string, unknown>).geometry,
    );
    if (rings.length > 0) {
      out.push({ kind: "polygon", ...base, positions: rings });
    }
  }

  if (isRecord(payload.zoning)) {
    const rings = extractRingsFromArcGisGeometry(
      (payload.zoning as Record<string, unknown>).geometry,
    );
    if (rings.length > 0) {
      out.push({ kind: "polygon", ...base, positions: rings });
    }
  }

  if (Array.isArray(payload.features)) {
    for (const feat of payload.features) {
      if (!isRecord(feat)) continue;
      const rings = extractRingsFromArcGisGeometry(feat.geometry);
      if (rings.length > 0) {
        out.push({ kind: "polygon", ...base, positions: rings });
      }
    }
  }

  if (isRecord(payload.location)) {
    const loc = payload.location as Record<string, unknown>;
    const x = loc.x;
    const y = loc.y;
    if (
      isFiniteNumber(x) &&
      isFiniteNumber(y) &&
      y >= -90 &&
      y <= 90 &&
      x >= -180 &&
      x <= 180
    ) {
      out.push({ kind: "point", ...base, position: [y, x] });
    }
  }

  return out;
}

export function extractBriefingSourceOverlays(
  sources: ReadonlyArray<BriefingSourceForOverlays>,
): SiteMapOverlay[] {
  const out: SiteMapOverlay[] = [];
  for (const source of sources) {
    if (source.supersededAt) continue;
    out.push(...overlaysFromSource(source));
  }
  return out;
}
