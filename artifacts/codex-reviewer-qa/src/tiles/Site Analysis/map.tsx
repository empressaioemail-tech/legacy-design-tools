import { useEffect, useRef } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { useSpatial } from "../../tile-shell/providers/SpatialProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";

const HAUSKA_MAP_URL =
  import.meta.env.VITE_HAUSKA_MAP_URL ?? "https://map.hauska.io/command-center";
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

export default function MapTile() {
  const { engagement } = useEngagement();
  const { overlays } = useSpatial();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const apn = engagement?.apn ?? "";
  const jurisdiction = engagement?.jurisdiction ?? "";
  const lat = (engagement as { latitude?: number } | null)?.latitude;
  const lng = (engagement as { longitude?: number } | null)?.longitude;

  const iframeSrc =
    apn || jurisdiction
      ? `${HAUSKA_MAP_URL}?apn=${encodeURIComponent(apn)}&jurisdiction=${encodeURIComponent(jurisdiction)}&mode=overlay`
      : HAUSKA_MAP_URL;

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    for (const overlay of overlays) {
      frame.contentWindow.postMessage(
        { type: "ADD_OVERLAY", overlay },
        "*",
      );
    }
  }, [overlays]);

  if (!MAPBOX_TOKEN && !HAUSKA_MAP_URL) {
    return (
      <div style={{ padding: 12 }}>
        <TileStatusBanner status="live" label="Map" />
        <p style={{ fontSize: 12 }}>Map embed URL not configured.</p>
      </div>
    );
  }

  return (
    <div
      data-testid="map-tile"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 240,
      }}
    >
      <TileStatusBanner status="live" label="Map" />
      <iframe
        ref={iframeRef}
        title="Hauska map command center"
        src={iframeSrc}
        style={{
          flex: 1,
          width: "100%",
          border: "none",
          borderRadius: 6,
          minHeight: 200,
        }}
      />
      {!engagement ? (
        <p
          style={{
            fontSize: 11,
            padding: "4px 8px",
            color: "var(--text-muted)",
            margin: 0,
          }}
        >
          Select an engagement to center the map on parcel context.
        </p>
      ) : lat != null && lng != null ? (
        <p style={{ fontSize: 10, color: "var(--text-muted)", margin: 0, padding: 4 }}>
          Center: {lat.toFixed(5)}, {lng.toFixed(5)}
        </p>
      ) : null}
    </div>
  );
}
