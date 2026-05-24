import { useMemo, useState } from "react";
import {
  VIEW_CUBE_REGIONS,
  VIEW_CUBE_SIZE,
  type ViewCubeRegionDef,
  type ViewCubeRegionId,
} from "./viewCubeModel";

export type { ViewCubeRegionId } from "./viewCubeModel";
/** @deprecated Use ViewCubeRegionId — kept for viewport callback typing. */
export type ViewCubeFace = ViewCubeRegionId;

export interface BimViewCubeProps {
  onSelectFace: (face: ViewCubeRegionId) => void;
  className?: string;
}

function regionTestId(id: ViewCubeRegionId): string {
  if (id === "right") return "bim-view-cube-right";
  return `bim-view-cube-${id}`;
}

function labelAnchor(region: ViewCubeRegionDef): [number, number] | null {
  if (!region.label) return null;
  const pts = region.points.split(" ").map((p) => p.split(",").map(Number));
  if (pts.length === 0) return null;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [cx, cy];
}

function regionFill(
  region: ViewCubeRegionDef,
  active: boolean,
  isVisibleFace: boolean,
): string {
  if (active) return "var(--view-cube-hover, rgba(0, 180, 216, 0.62))";
  if (region.kind === "face" && isVisibleFace) {
    return "var(--view-cube-face, rgba(88, 98, 118, 0.98))";
  }
  if (region.kind === "face") {
    return "var(--view-cube-face-back, rgba(62, 70, 86, 0.94))";
  }
  if (region.kind === "edge") {
    return "var(--view-cube-edge, rgba(72, 80, 96, 0.96))";
  }
  return "var(--view-cube-corner, rgba(58, 66, 80, 0.98))";
}

/**
 * Revit-style ViewCube — 6 faces, 12 edges, 8 corners (26 regions) as SVG
 * hit targets with reliable pointer events.
 */
export function BimViewCube({ onSelectFace, className }: BimViewCubeProps) {
  const [hovered, setHovered] = useState<ViewCubeRegionId | null>(null);

  const sorted = useMemo(
    () => [...VIEW_CUBE_REGIONS].sort((a, b) => a.z - b.z),
    [],
  );

  return (
    <div
      className={["bim-view-cube", className].filter(Boolean).join(" ")}
      data-testid="bim-view-cube"
      role="navigation"
      aria-label="View orientation"
    >
      <div className="bim-view-cube-body">
        <button
          type="button"
          className="bim-view-cube-iso"
          data-testid="bim-view-cube-iso"
          onClick={() => onSelectFace("iso")}
          title="Isometric view (home)"
        >
          ISO
        </button>
        <svg
          className="bim-view-cube-svg"
          viewBox={`0 0 ${VIEW_CUBE_SIZE.width} ${VIEW_CUBE_SIZE.height}`}
          width={VIEW_CUBE_SIZE.width}
          height={VIEW_CUBE_SIZE.height}
          aria-hidden={false}
          role="group"
          aria-label="View cube faces, edges, and corners"
        >
          <defs>
            <filter
              id="bim-view-cube-shadow"
              x="-25%"
              y="-25%"
              width="150%"
              height="150%"
            >
              <feDropShadow
                dx="0"
                dy="3"
                stdDeviation="3"
                floodColor="#000"
                floodOpacity="0.5"
              />
            </filter>
            <linearGradient id="bim-view-cube-top-shade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0.08)" />
            </linearGradient>
          </defs>
          <g filter="url(#bim-view-cube-shadow)">
            {sorted.map((region) => {
              const active = hovered === region.id;
              const isVisibleFace =
                region.id === "top" ||
                region.id === "front" ||
                region.id === "right";
              return (
                <polygon
                  key={region.id}
                  points={region.points}
                  className={[
                    "bim-view-cube-region",
                    `bim-view-cube-region--${region.kind}`,
                    isVisibleFace ? "bim-view-cube-region--visible-face" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid={regionTestId(region.id)}
                  data-region={region.id}
                  data-kind={region.kind}
                  tabIndex={0}
                  role="button"
                  aria-label={region.title}
                  onClick={() => onSelectFace(region.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectFace(region.id);
                    }
                  }}
                  onMouseEnter={() => setHovered(region.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(region.id)}
                  onBlur={() => setHovered(null)}
                  style={{
                    fill: regionFill(region, active, isVisibleFace),
                    stroke: active
                      ? "var(--cyan, #00b4d8)"
                      : "rgba(255, 255, 255, 0.38)",
                    strokeWidth: active ? 1.4 : 0.85,
                    strokeLinejoin: "round",
                    cursor: "pointer",
                  }}
                />
              );
            })}
          </g>
          {sorted
            .filter((r) => r.label)
            .map((region) => {
              const anchor = labelAnchor(region);
              if (!anchor) return null;
              return (
                <text
                  key={`label-${region.id}`}
                  x={anchor[0]}
                  y={anchor[1]}
                  className="bim-view-cube-label"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  pointerEvents="none"
                >
                  {region.label}
                </text>
              );
            })}
        </svg>
      </div>
      <div className="bim-view-cube-compass" aria-hidden="true">
        <span className="bim-view-cube-compass-n">N</span>
        <span className="bim-view-cube-compass-e">E</span>
        <span className="bim-view-cube-compass-s">S</span>
        <span className="bim-view-cube-compass-w">W</span>
      </div>
    </div>
  );
}
