/**
 * ViewCube camera directions — BIM viewport convention (matches BimModelViewport):
 *   Z-up world, −Y is "front" / north, +X is "right" / east, +Z is "top".
 *
 * Revit label → camera snap direction (unit vector from orbit target toward camera):
 *   TOP    [0, 0, 1]     BOTTOM [0, 0, -1]
 *   FRONT  [0, -1, 0]    BACK   [0, 1, 0]
 *   RIGHT  [1, 0, 0]     LEFT   [-1, 0, 0]
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

export type ViewCubeFaceId =
  | "top"
  | "bottom"
  | "front"
  | "back"
  | "right"
  | "left";

export function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Six orthographic face snap directions. */
export const VIEW_CUBE_FACE_DIRECTIONS: Record<
  ViewCubeFaceId,
  [number, number, number]
> = {
  top: norm([0, 0, 1]),
  bottom: norm([0, 0, -1]),
  front: norm([0, -1, 0]),
  back: norm([0, 1, 0]),
  right: norm([1, 0, 0]),
  left: norm([-1, 0, 0]),
};

/** Edge / corner bisector directions (Phase 2 raycast targets). */
const EDGE_CORNER_DIRECTIONS: Partial<
  Record<ViewCubeRegionId, [number, number, number]>
> = {
  iso: norm([-1, -1, 1]),
  "top-front": norm([0, -1, 1]),
  "top-back": norm([0, 1, 1]),
  "top-right": norm([1, 0, 1]),
  "top-left": norm([-1, 0, 1]),
  "front-right": norm([1, -1, 0]),
  "front-left": norm([-1, -1, 0]),
  "front-bottom": norm([0, -1, -1]),
  "right-back": norm([1, 1, 0]),
  "right-bottom": norm([1, 0, -1]),
  "back-bottom": norm([0, 1, -1]),
  "left-bottom": norm([-1, 0, -1]),
  "left-back": norm([-1, 1, 0]),
  "top-front-right": norm([1, -1, 1]),
  "top-front-left": norm([-1, -1, 1]),
  "top-back-right": norm([1, 1, 1]),
  "top-back-left": norm([-1, 1, 1]),
  "front-right-bottom": norm([1, -1, -1]),
  "front-left-bottom": norm([-1, -1, -1]),
  "right-back-bottom": norm([1, 1, -1]),
  "left-back-bottom": norm([-1, 1, -1]),
};

export const VIEW_CUBE_DIRECTIONS: Record<ViewCubeRegionId, [number, number, number]> =
  {
    ...VIEW_CUBE_FACE_DIRECTIONS,
    ...EDGE_CORNER_DIRECTIONS,
  } as Record<ViewCubeRegionId, [number, number, number]>;

/** Default mini-canvas footprint (px). */
export const VIEW_CUBE_CANVAS_SIZE = { width: 96, height: 120 };

const WORLD_FACE_AXES: Array<{
  id: ViewCubeFaceId;
  axis: [number, number, number];
}> = [
  { id: "right", axis: [1, 0, 0] },
  { id: "left", axis: [-1, 0, 0] },
  { id: "top", axis: [0, 0, 1] },
  { id: "bottom", axis: [0, 0, -1] },
  { id: "front", axis: [0, -1, 0] },
  { id: "back", axis: [0, 1, 0] },
];

/** Map a world-space outward face normal to the nearest labeled face. */
export function faceIdFromWorldNormal(
  nx: number,
  ny: number,
  nz: number,
): ViewCubeFaceId {
  let best: ViewCubeFaceId = "front";
  let bestDot = -Infinity;
  for (const { id, axis } of WORLD_FACE_AXES) {
    const dot = nx * axis[0] + ny * axis[1] + nz * axis[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = id;
    }
  }
  return best;
}

/** Camera snap direction for a clicked face (target → camera unit vector). */
export function snapDirectionForFace(faceId: ViewCubeFaceId): [number, number, number] {
  return VIEW_CUBE_FACE_DIRECTIONS[faceId];
}
