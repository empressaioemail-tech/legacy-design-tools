import { useEffect, useMemo, useRef } from "react";
import { useEngagement } from "../../tile-shell/providers/EngagementProvider";
import { useSpatial } from "../../tile-shell/providers/SpatialProvider";
import { TileStatusBanner } from "../../tile-shell/components/TileStatusBanner";

const baseUrl =
  import.meta.env.VITE_HAUSKA_MAP_URL ?? "https://map.hauska.io/command-center";

export default function MapTile() {
  const { engagement } = useEngagement();
  const { overlays } = useSpatial();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const apn = engagement?.apn ?? "";
  const jurisdiction = engagement?.jurisdiction ?? "";
  const lat = engagement?.latitude ?? null;
  const lng = engagement?.longitude ?? null;

  const iframeSrc = useMemo(() => {
    const params = new URLSearchParams();
    if (apn) params.set("apn", apn);
    if (jurisdiction) params.set("jurisdiction", jurisdiction);
    if (lat != null) params.set("lat", String(lat));
    if (lng != null) params.set("lng", String(lng));
    params.set("mode", "embed");
    const qs = params.toString();
    return qs ? `${baseUrl}?${qs}` : `${baseUrl}?mode=embed`;
  }, [apn, jurisdiction, lat, lng]);

  function postMapContext() {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    for (const overlay of overlays) {
      frame.contentWindow.postMessage({ type: "ADD_OVERLAY", overlay }, "*");
    }
    if (apn) {
      frame.contentWindow.postMessage({ type: "SET_PARCEL", apn }, "*");
    }
  }

  useEffect(() => {
    postMapContext();
  }, [overlays, apn, iframeSrc]);

  return (
    <div
      data-testid="map-tile"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <TileStatusBanner status="live" label="Map" />
      {!import.meta.env.VITE_HAUSKA_MAP_URL ? (
        <div
          style={{
            padding: "8px",
            fontSize: "12px",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
        >
          Set VITE_HAUSKA_MAP_URL in .env.local to use the local hauska-map.
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        onLoad={postMapContext}
        style={{ flex: 1, border: "none", width: "100%", minHeight: 0 }}
        title="Hauska Map"
        allow="*"
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
          {apn ? ` · APN ${apn}` : ""}
        </p>
      ) : null}
    </div>
  );
}
