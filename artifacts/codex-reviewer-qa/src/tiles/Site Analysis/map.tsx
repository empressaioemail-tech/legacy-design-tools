import { useEffect, useRef } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { useSpatial } from "../../tile-shell/providers/SpatialProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";

function resolveHauskaMapUrl(): string {
  const raw = import.meta.env.VITE_HAUSKA_MAP_URL;
  if (typeof raw === "string" && raw.trim().startsWith("http")) {
    return raw.trim();
  }
  return "https://map.hauska.io/command-center";
}

const HAUSKA_MAP_URL = resolveHauskaMapUrl();
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

export default function MapTile() {
  const { engagement } = useEngagement();
  const { overlays } = useSpatial();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const apn = engagement?.apn ?? "";
  const jurisdiction = engagement?.jurisdiction ?? "";
  const lat = engagement?.latitude ?? null;
  const lng = engagement?.longitude ?? null;

  const params = new URLSearchParams();
  if (apn) params.set("apn", apn);
  if (jurisdiction) params.set("jurisdiction", jurisdiction);
  if (lat != null) params.set("lat", String(lat));
  if (lng != null) params.set("lng", String(lng));
  params.set("mode", "embed");
  const iframeSrc =
    apn || jurisdiction || (lat != null && lng != null)
      ? `${HAUSKA_MAP_URL}?${params.toString()}`
      : `${HAUSKA_MAP_URL}?mode=embed`;

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
        flex: 1,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <iframe
        ref={iframeRef}
        title="Hauska map command center"
        src={iframeSrc}
        allow="*"
        style={{
          flex: 1,
          width: "100%",
          height: "100%",
          border: "none",
          minHeight: 0,
        }}
      />
      {!engagement ? (
        <p
          style={{
            fontSize: 11,
            padding: "4px 8px",
            color: "var(--text-muted)",
            margin: 0,
            flexShrink: 0,
          }}
        >
          Select an engagement to center the map on parcel context.
        </p>
      ) : lat != null && lng != null ? (
        <p
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            margin: 0,
            padding: 4,
            flexShrink: 0,
          }}
        >
          Center: {lat.toFixed(5)}, {lng.toFixed(5)}
        </p>
      ) : null}
    </div>
  );
}
