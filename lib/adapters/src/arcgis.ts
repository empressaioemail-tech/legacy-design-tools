/**
 * Thin helper around ArcGIS REST `query` endpoints. Most of the
 * adapters in this sprint hit ArcGIS Feature/Map services because that
 * is what UGRC, INSIDE Idaho, Grand County GIS, Lemhi County GIS, and
 * TCEQ all expose. The shape is consistent enough that one helper
 * covers the common case ("hit a layer with a point and get the
 * intersecting feature attributes back").
 *
 * The helper deliberately:
 *   - takes an injected `fetch` so unit tests can stub the network;
 *   - validates the JSON envelope and surfaces ArcGIS's in-band error
 *     object as a typed throw rather than letting it round-trip as a
 *     "successful" empty response;
 *   - normalizes the resulting feature list to a small subset
 *     (`attributes` + `geometry`) so adapters don't depend on the full
 *     ArcGIS schema.
 *
 * It does NOT handle paginated responses (the `exceededTransferLimit`
 * flag) — every adapter in this sprint queries by point intersection,
 * which returns at most a handful of rows.
 */

import { AdapterRunError } from "./types";

export interface ArcGisPointQueryInput {
  serviceUrl: string;
  latitude: number;
  longitude: number;
  /** Comma-separated attribute list ("*" for everything). */
  outFields?: string;
  /** When true, include feature geometries in the response. */
  returnGeometry?: boolean;
  /** Spatial reference of the input point. Defaults to WGS84 (4326). */
  inSpatialReference?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface ArcGisFeature {
  attributes: Record<string, unknown>;
  geometry?: Record<string, unknown> | null;
}

export interface ArcGisQueryResult {
  features: ArcGisFeature[];
  /** Effective field types as ArcGIS reports them; useful for debugging. */
  fields?: ReadonlyArray<{ name: string; type: string }>;
  /** Raw envelope for debugging — adapters should not depend on this. */
  raw: unknown;
}

/**
 * Query an ArcGIS service layer for features intersecting the given
 * point. Throws an {@link AdapterRunError} on any deterministic upstream
 * failure (HTTP non-2xx, ArcGIS error envelope, malformed JSON).
 */
export async function arcgisPointQuery(
  input: ArcGisPointQueryInput,
): Promise<ArcGisQueryResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const sr = input.inSpatialReference ?? 4326;
  const url = new URL(`${input.serviceUrl.replace(/\/$/, "")}/query`);
  url.searchParams.set("f", "json");
  url.searchParams.set(
    "geometry",
    JSON.stringify({
      x: input.longitude,
      y: input.latitude,
      spatialReference: { wkid: sr },
    }),
  );
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", String(sr));
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", input.outFields ?? "*");
  url.searchParams.set(
    "returnGeometry",
    input.returnGeometry ? "true" : "false",
  );

  let res: Response;
  try {
    res = await fetchFn(url.toString(), { signal: input.signal });
  } catch (err) {
    // Surface as `network-error` so the runner translates uniformly.
    throw new AdapterRunError(
      "network-error",
      `ArcGIS request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new AdapterRunError(
      "upstream-error",
      `ArcGIS responded with HTTP ${res.status}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AdapterRunError(
      "parse-error",
      `ArcGIS response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!json || typeof json !== "object") {
    throw new AdapterRunError(
      "parse-error",
      "ArcGIS response was not a JSON object",
    );
  }
  // ArcGIS surfaces in-band errors as `{ error: { code, message } }`
  // with HTTP 200. Translate to an upstream-error so the adapter
  // fails deterministically.
  const errorEnv = (json as { error?: { code?: number; message?: string } })
    .error;
  if (errorEnv) {
    throw new AdapterRunError(
      "upstream-error",
      `ArcGIS error ${errorEnv.code ?? "?"}: ${errorEnv.message ?? "unknown"}`,
    );
  }

  const featuresRaw = (json as { features?: unknown }).features;
  if (!Array.isArray(featuresRaw)) {
    throw new AdapterRunError(
      "parse-error",
      "ArcGIS response missing `features` array",
    );
  }
  const features: ArcGisFeature[] = featuresRaw.map((f) => {
    const feat = f as { attributes?: unknown; geometry?: unknown };
    return {
      attributes:
        feat.attributes && typeof feat.attributes === "object"
          ? (feat.attributes as Record<string, unknown>)
          : {},
      geometry:
        feat.geometry && typeof feat.geometry === "object"
          ? (feat.geometry as Record<string, unknown>)
          : null,
    };
  });
  const fieldsRaw = (json as { fields?: unknown }).fields;
  const fields = Array.isArray(fieldsRaw)
    ? (fieldsRaw as ReadonlyArray<{ name: string; type: string }>)
    : undefined;
  return { features, fields, raw: json };
}
