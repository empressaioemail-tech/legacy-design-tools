/**
 * ViewCube region geometry + camera directions (BIM viewport: Z-up, −Y front, +X right).
 * 26 regions: 6 faces, 12 edges, 8 corners — isometric SVG projection.
 */

export type ViewCubeRegionId =
  | "iso"
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "right"
  | "left"
  | "top-front"
  | "top-back"
  | "top-right"
  | "top-left"
  | "front-right"
  | "front-left"
  | "front-bottom"
  | "right-back"
  | "right-bottom"
  | "back-bottom"
  | "left-bottom"
  | "left-back"
  | "top-front-right"
  | "top-front-left"
  | "top-back-right"
  | "top-back-left"
  | "front-right-bottom"
  | "front-left-bottom"
  | "right-back-bottom"
  | "left-back-bottom";

export type ViewCubeRegionKind = "face" | "edge" | "corner";

export interface ViewCubeRegionDef {
  id: ViewCubeRegionId;
  kind: ViewCubeRegionKind;
  points: string;
  label?: string;
  title: string;
  direction: [number, number, number];
  z: number;
}

const S = 23;
const CX = 72;
const CY = 76;

export function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function proj(x: number, y: number, z: number): [number, number] {
  const px = (x - y) * S * 0.8660254;
  const py = (x + y) * S * 0.5 - z * S;
  return [CX + px, CY + py];
}

function poly(...corners: [number, number, number][]): string {
  return corners.map((c) => proj(c[0], c[1], c[2]).join(",")).join(" ");
}

function face(
  axis: "x" | "y" | "z",
  sign: 1 | -1,
  id: ViewCubeRegionId,
  label: string,
  z: number,
): ViewCubeRegionDef {
  const v = sign;
  let corners: [number, number, number][];
  let dir: [number, number, number];
  if (axis === "z") {
    corners =
      sign === 1
        ? [
            [-1, -1, v],
            [1, -1, v],
            [1, 1, v],
            [-1, 1, v],
          ]
        : [
            [-1, -1, v],
            [-1, 1, v],
            [1, 1, v],
            [1, -1, v],
          ];
    dir = [0, 0, v];
  } else if (axis === "y") {
    corners =
      sign === -1
        ? [
            [-1, v, 1],
            [1, v, 1],
            [1, v, -1],
            [-1, v, -1],
          ]
        : [
            [-1, v, 1],
            [-1, v, -1],
            [1, v, -1],
            [1, v, 1],
          ];
    dir = [0, v, 0];
  } else {
    corners =
      sign === 1
        ? [
            [v, -1, 1],
            [v, 1, 1],
            [v, 1, -1],
            [v, -1, -1],
          ]
        : [
            [v, -1, 1],
            [v, -1, -1],
            [v, 1, -1],
            [v, 1, 1],
          ];
    dir = [v, 0, 0];
  }
  return {
    id,
    kind: "face",
    points: poly(...corners),
    label,
    title: `${label} view`,
    direction: norm(dir),
    z,
  };
}

/** Thin quad along a cube edge; offsets pull slightly into the two incident faces. */
function edge(
  id: ViewCubeRegionId,
  title: string,
  a: [number, number, number],
  b: [number, number, number],
  o1: [number, number, number],
  o2: [number, number, number],
  z: number,
): ViewCubeRegionDef {
  const t = 0.34;
  const lerp = (
    p: [number, number, number],
    q: [number, number, number],
    u: number,
  ): [number, number, number] => [
    p[0] + (q[0] - p[0]) * u,
    p[1] + (q[1] - p[1]) * u,
    p[2] + (q[2] - p[2]) * u,
  ];
  const p0 = lerp(a, b, t);
  const p1 = lerp(a, b, 1 - t);
  const q0: [number, number, number] = [
    p0[0] + o1[0],
    p0[1] + o1[1],
    p0[2] + o1[2],
  ];
  const q1: [number, number, number] = [
    p1[0] + o1[0],
    p1[1] + o1[1],
    p1[2] + o1[2],
  ];
  const r1: [number, number, number] = [
    p1[0] + o2[0],
    p1[1] + o2[1],
    p1[2] + o2[2],
  ];
  const r0: [number, number, number] = [
    p0[0] + o2[0],
    p0[1] + o2[1],
    p0[2] + o2[2],
  ];
  return {
    id,
    kind: "edge",
    points: poly(p0, p1, r1, r0),
    title,
    direction: norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]),
    z,
  };
}

function corner(
  id: ViewCubeRegionId,
  title: string,
  x: -1 | 1,
  y: -1 | 1,
  z: -1 | 1,
  zOrder: number,
): ViewCubeRegionDef {
  const w = 0.36;
  const ix = x === 1 ? -w : w;
  const iy = y === 1 ? -w : w;
  const iz = z === 1 ? -w : w;
  return {
    id,
    kind: "corner",
    points: poly(
      [x, y, z],
      [x + ix, y, z],
      [x, y + iy, z],
      [x, y, z + iz],
    ),
    title,
    direction: norm([x, y, z]),
    z: zOrder,
  };
}

const E = 0.16;

export const VIEW_CUBE_REGIONS: ViewCubeRegionDef[] = [
  face("z", -1, "bottom", "BOTTOM", 1),
  face("y", 1, "back", "BACK", 2),
  face("x", -1, "left", "LEFT", 3),

  edge(
    "back-bottom",
    "Back bottom view",
    [-1, 1, -1],
    [1, 1, -1],
    [0, -E, 0],
    [0, 0, E],
    4,
  ),
  edge(
    "left-back",
    "Left back view",
    [-1, 1, 1],
    [-1, 1, -1],
    [E, 0, 0],
    [0, -E, 0],
    4,
  ),
  edge(
    "left-bottom",
    "Left bottom view",
    [-1, -1, -1],
    [-1, 1, -1],
    [E, 0, 0],
    [0, 0, E],
    4,
  ),
  edge(
    "right-back",
    "Right back view",
    [1, 1, 1],
    [1, 1, -1],
    [-E, 0, 0],
    [0, -E, 0],
    5,
  ),
  edge(
    "right-bottom",
    "Right bottom view",
    [1, -1, -1],
    [1, 1, -1],
    [-E, 0, 0],
    [0, 0, E],
    5,
  ),
  edge(
    "top-back",
    "Top back view",
    [-1, 1, 1],
    [1, 1, 1],
    [0, -E, 0],
    [0, 0, -E],
    5,
  ),
  edge(
    "top-left",
    "Top left view",
    [-1, -1, 1],
    [-1, 1, 1],
    [E, 0, 0],
    [0, 0, -E],
    6,
  ),
  edge(
    "front-bottom",
    "Front bottom view",
    [-1, -1, -1],
    [1, -1, -1],
    [0, E, 0],
    [0, 0, E],
    6,
  ),
  edge(
    "front-left",
    "Front left view",
    [-1, -1, 1],
    [-1, -1, -1],
    [E, 0, 0],
    [0, E, 0],
    6,
  ),

  face("z", 1, "top", "TOP", 10),
  face("y", -1, "front", "FRONT", 11),
  face("x", 1, "right", "RIGHT", 12),

  edge(
    "top-front",
    "Top front view",
    [-1, -1, 1],
    [1, -1, 1],
    [0, E, 0],
    [0, 0, -E],
    13,
  ),
  edge(
    "top-right",
    "Top right view",
    [1, -1, 1],
    [1, 1, 1],
    [-E, 0, 0],
    [0, 0, -E],
    13,
  ),
  edge(
    "front-right",
    "Front right view",
    [1, -1, 1],
    [1, -1, -1],
    [-E, 0, 0],
    [0, E, 0],
    14,
  ),

  corner("top-front-right", "Top front right view", 1, -1, 1, 20),
  corner("top-front-left", "Top front left view", -1, -1, 1, 20),
  corner("top-back-right", "Top back right view", 1, 1, 1, 19),
  corner("top-back-left", "Top back left view", -1, 1, 1, 19),
  corner("front-right-bottom", "Front right bottom view", 1, -1, -1, 18),
  corner("front-left-bottom", "Front left bottom view", -1, -1, -1, 18),
  corner("right-back-bottom", "Right back bottom view", 1, 1, -1, 17),
  corner("left-back-bottom", "Left back bottom view", -1, 1, -1, 17),
];

export const VIEW_CUBE_DIRECTIONS: Record<ViewCubeRegionId, [number, number, number]> =
  {
    iso: norm([-1, -1, 1]),
    ...Object.fromEntries(
      VIEW_CUBE_REGIONS.map((r) => [r.id, r.direction]),
    ),
  } as Record<ViewCubeRegionId, [number, number, number]>;

export const VIEW_CUBE_SIZE = { width: 144, height: 148 };
