import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polygon,
  CircleMarker,
} from "react-leaflet";
import L from "leaflet";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import type { SiteMapOverlay, SiteMapOverlayTier } from "./overlays";

// Fix the well-known Leaflet+Vite marker-icon issue
L.Icon.Default.mergeOptions({
  iconRetinaUrl,
  iconUrl,
  shadowUrl,
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
};

const TIER_LABELS: Record<SiteMapOverlayTier, string> = {
  federal: "Federal",
  state: "State",
  local: "Local",
  manual: "Manual",
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
        <Marker position={[latitude, longitude]}>
          {addressLabel && <Popup>{addressLabel}</Popup>}
        </Marker>
      </MapContainer>
    </div>
  );
}
