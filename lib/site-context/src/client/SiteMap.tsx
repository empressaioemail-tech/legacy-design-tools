import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";

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
}

export function SiteMap({
  latitude,
  longitude,
  addressLabel,
  height = 280,
  zoom = 17,
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
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[latitude, longitude]}>
          {addressLabel && <Popup>{addressLabel}</Popup>}
        </Marker>
      </MapContainer>
    </div>
  );
}
