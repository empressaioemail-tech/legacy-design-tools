import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polygon,
  Polyline,
  CircleMarker,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { SiteMapOverlay, SiteMapOverlayTier } from "./overlays";

/** Site address pin — inline SVG so Vite/monorepo builds never 404 Leaflet PNG assets. */
const SITE_PIN_ICON = L.divIcon({
  className: "site-map-pin-leaflet",
  html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"><path fill="#00b4d8" stroke="#0891b2" stroke-width="1.25" d="M14 0C7.4 0 2 5.4 2 12c0 9 12 24 12 24s12-15 12-24C26 5.4 20.6 0 14 0zm0 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>`,
  iconSize: [28, 36],
  iconAnchor: [14, 36],
  popupAnchor: [0, -32],
});

export interface SiteMapProps {
  latitude: number;
  longitude: number;
  addressLabel?: string;
  height?: number;
  zoom?: number;
  // Override the default OSM raster tile URL (defaults to the public
  // OSM tile server). When set, also pass `tileAttribution` so the
  // new provider is credited.
  tileUrl?: string;
  tileAttribution?: string;
  // Polygons + points produced by `extractBriefingSourceOverlays`.
  overlays?: ReadonlyArray<SiteMapOverlay>;
}

const DEFAULT_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Tier → fill/stroke color (federal blue, state amber, local green,
// manual gray). Chosen for color-blind separability.
const TIER_STYLES: Record<
  SiteMapOverlayTier,
  { color: string; fillColor: string; fillOpacity: number; weight: number }
> = {
  federal: {
    color: "#2563eb",
    fillColor: "#2563eb",
    fillOpacity: 0.18,
    weight: 2,
  },
  state: {
    color: "#d97706",
    fillColor: "#d97706",
    fillOpacity: 0.18,
    weight: 2,
  },
  local: {
    color: "#16a34a",
    fillColor: "#16a34a",
    fillOpacity: 0.2,
    weight: 2,
  },
  manual: {
    color: "#6b7280",
    fillColor: "#6b7280",
    fillOpacity: 0.18,
    weight: 2,
  },
  topography: {
    color: "#a16207",
    fillColor: "#a16207",
    fillOpacity: 0,
    weight: 1.5,
  },
  hydrology: {
    color: "#0284c7",
    fillColor: "#0ea5e9",
    fillOpacity: 0.35,
    weight: 2,
  },
};

const TIER_LABELS: Record<SiteMapOverlayTier, string> = {
  federal: "Federal",
  state: "State",
  local: "Local",
  manual: "Manual",
  topography: "Topography",
  hydrology: "Hydrology",
};

export function SiteMap({
  latitude,
  longitude,
  addressLabel,
  height = 280,
  zoom = 17,
  tileUrl = DEFAULT_TILE_URL,
  tileAttribution = DEFAULT_TILE_ATTRIBUTION,
  overlays = [],
}: SiteMapProps) {
  return (
    <div
      style={{
        width: "100%",
        height,
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      <MapContainer
        center={[latitude, longitude]}
        zoom={zoom}
        scrollWheelZoom
        style={{ width: "100%", height: "100%" }}
      >
        <TileLayer attribution={tileAttribution} url={tileUrl} />
        {overlays.map((overlay, idx) => {
          const style = TIER_STYLES[overlay.tier];
          const popupBody = (
            <>
              <strong>{overlay.layerKind}</strong>
              {overlay.provider ? <> · {overlay.provider}</> : null}
              <div style={{ fontSize: 11, opacity: 0.75 }}>
                {TIER_LABELS[overlay.tier]} layer
              </div>
            </>
          );
          if (overlay.kind === "polygon") {
            return (
              <Polygon
                key={`${overlay.sourceId}-${idx}`}
                positions={overlay.positions}
                pathOptions={style}
              >
                <Popup>{popupBody}</Popup>
              </Polygon>
            );
          }
          if (overlay.kind === "polyline") {
            return (
              <Polyline
                key={`${overlay.sourceId}-${idx}`}
                positions={overlay.positions}
                pathOptions={{
                  color: style.color,
                  weight: overlay.tier === "topography" ? 1.5 : overlay.layerKind === "flow-line" ? 2.5 : 3,
                  opacity: overlay.tier === "topography" ? 0.85 : 0.9,
                }}
              >
                <Popup>{popupBody}</Popup>
              </Polyline>
            );
          }
          return (
            <CircleMarker
              key={`${overlay.sourceId}-${idx}`}
              center={overlay.position}
              radius={6}
              pathOptions={{ ...style, fillOpacity: 0.6 }}
            >
              <Popup>{popupBody}</Popup>
            </CircleMarker>
          );
        })}
        <Marker position={[latitude, longitude]} icon={SITE_PIN_ICON}>
          {addressLabel && <Popup>{addressLabel}</Popup>}
        </Marker>
      </MapContainer>
    </div>
  );
}
