import * as THREE from "three";

export interface BboxExtents {
  dx: number;
  dy: number;
  dz: number;
}

export function boundsExtentFromBox(box: THREE.Box3): BboxExtents {
  return {
    dx: box.max.x - box.min.x,
    dy: box.max.y - box.min.y,
    dz: box.max.z - box.min.z,
  };
}

/** True when the box has a finite, non-degenerate volume. */
export function isValidObjectBounds(box: THREE.Box3): boolean {
  if (typeof box.isEmpty === "function" && box.isEmpty()) return false;
  const vals = [
    box.min.x,
    box.min.y,
    box.min.z,
    box.max.x,
    box.max.y,
    box.max.z,
  ];
  if (!vals.every(Number.isFinite)) return false;
  const ext = boundsExtentFromBox(box);
  return ext.dx > 1e-6 || ext.dy > 1e-6 || ext.dz > 1e-6;
}

export interface Bounds3Like {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function bounds3FromObject3D(root: THREE.Object3D): Bounds3Like | null {
  const box = new THREE.Box3().setFromObject(root);
  if (!isValidObjectBounds(box)) return null;
  return {
    minX: box.min.x,
    minY: box.min.y,
    minZ: box.min.z,
    maxX: box.max.x,
    maxY: box.max.y,
    maxZ: box.max.z,
  };
}

/** Minimum score gain required before replacing the file's root rotation. */
const MIN_STANDING_GAIN = 0.2;

/**
 * How strongly the bbox reads as "standing" on +Z (BIM viewport convention).
 */
export function verticalStandingScore(ext: BboxExtents): number {
  const { dx, dy, dz } = ext;
  const maxAxis = Math.max(dx, dy, dz, 0.001);

  if (dz >= dx * 0.95 && dz >= dy * 0.95) {
    return dz / Math.max(dx, dy, 0.001);
  }

  if (dy >= dx * 0.95 && dy >= dz * 1.15) {
    return 0;
  }

  return dz / maxAxis;
}

const X_ROTATION_CANDIDATES = [0, Math.PI / 2, -Math.PI / 2] as const;

/**
 * Align GLB roots to the BIM viewport Z-up frame (floor in XY, −Y front).
 */
export function reorientGlbRootForZUp(root: THREE.Object3D): void {
  const origX = root.rotation.x;
  let baseScore = 0;
  let bestAngle = 0;
  let bestScore = -Infinity;

  for (const angle of X_ROTATION_CANDIDATES) {
    root.rotation.x = origX + angle;
    if (typeof root.updateMatrixWorld === "function") {
      root.updateMatrixWorld(true);
    }
    const score = verticalStandingScore(
      boundsExtentFromBox(new THREE.Box3().setFromObject(root)),
    );
    if (angle === 0) baseScore = score;
    if (score > bestScore + 1e-6) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  let finalAngle = origX;
  if (bestAngle !== 0 && bestScore >= baseScore + MIN_STANDING_GAIN) {
    finalAngle = origX + bestAngle;
  } else {
    // Revit / glTF exports often arrive Y-up with a wide footprint; if
    // scoring ties at 0° (e.g. near-cubic massing), still stand the model
    // when height clearly lives on +Y.
    root.rotation.x = origX;
    if (typeof root.updateMatrixWorld === "function") {
      root.updateMatrixWorld(true);
    }
    const ext0 = boundsExtentFromBox(new THREE.Box3().setFromObject(root));
    const yDominant =
      ext0.dy >= ext0.dx * 0.9 &&
      ext0.dy > ext0.dz * 1.08 &&
      ext0.dy >= Math.max(ext0.dx, ext0.dz);
    if (yDominant) {
      root.rotation.x = origX + Math.PI / 2;
      if (typeof root.updateMatrixWorld === "function") {
        root.updateMatrixWorld(true);
      }
      const stood = verticalStandingScore(
        boundsExtentFromBox(new THREE.Box3().setFromObject(root)),
      );
      if (stood > baseScore + 0.05) {
        finalAngle = origX + Math.PI / 2;
      }
    }
  }

  root.rotation.x = finalAngle;
  if (typeof root.updateMatrixWorld === "function") {
    root.updateMatrixWorld(true);
  }
}
