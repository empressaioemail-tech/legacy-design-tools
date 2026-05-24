import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * BIM viewport camera helpers (Z-up: −Y front, +X right, +Z top).
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const Z_UP = new THREE.Vector3(0, 0, 1);

/** Unit vector from orbit target toward the camera. */
export function computeViewDirection(
  camera: Vec3Like,
  target: Vec3Like,
): [number, number, number] {
  const dx = camera.x - target.x;
  const dy = camera.y - target.y;
  const dz = camera.z - target.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return [dx / len, dy / len, dz / len];
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export interface CameraTweenHandle {
  cancel: () => void;
}

/**
 * Stable camera.up for Z-up BIM views. Keeps project north (−Y) toward the
 * top of the screen on plan views and standard elevation roll elsewhere.
 */
export function resolveCameraUpForDirection(
  direction: [number, number, number],
): [number, number, number] {
  const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const dz = direction[2] / len;
  if (Math.abs(dz) > 0.999) {
    return [0, dz > 0 ? -1 : 1, 0];
  }
  return [0, 0, 1];
}

function applyCameraUp(
  camera: THREE.PerspectiveCamera,
  up: [number, number, number],
): void {
  if (typeof camera.up.set === "function") {
    camera.up.set(up[0], up[1], up[2]);
  } else {
    (camera.up as THREE.Vector3).x = up[0];
    (camera.up as THREE.Vector3).y = up[1];
    (camera.up as THREE.Vector3).z = up[2];
  }
}

/** Smoothly move camera + target over `durationMs` (default 300). */
export function tweenCameraToView(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  endPosition: Vec3Like,
  endTarget: Vec3Like,
  durationMs = 300,
  onComplete?: () => void,
): CameraTweenHandle {
  const startPos = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
  };
  const startTarget = {
    x: controls.target.x,
    y: controls.target.y,
    z: controls.target.z,
  };
  const endDir = computeViewDirection(endPosition, endTarget);
  const endUp = resolveCameraUpForDirection(endDir);
  const start = performance.now();
  let frame = 0;
  let cancelled = false;

  const tick = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeOutCubic(t);
    camera.position.set(
      startPos.x + (endPosition.x - startPos.x) * e,
      startPos.y + (endPosition.y - startPos.y) * e,
      startPos.z + (endPosition.z - startPos.z) * e,
    );
    controls.target.set(
      startTarget.x + (endTarget.x - startTarget.x) * e,
      startTarget.y + (endTarget.y - startTarget.y) * e,
      startTarget.z + (endTarget.z - startTarget.z) * e,
    );
    applyCameraUp(camera, endUp);
    camera.lookAt(controls.target.x, controls.target.y, controls.target.z);
    controls.update();
    if (t < 1) {
      frame = requestAnimationFrame(tick);
    } else {
      onComplete?.();
    }
  };

  frame = requestAnimationFrame(tick);
  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    },
  };
}

/** Snappier ViewCube drag — Z-up orbit math (not THREE.Spherical, which is Y-up). */
export const VIEW_CUBE_ORBIT_ROTATE_SPEED = 0.011;

/** Orbit the camera around `controls.target` in a Z-up world. */
export function applyOrbitDrag(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  deltaX: number,
  deltaY: number,
  rotateSpeed = VIEW_CUBE_ORBIT_ROTATE_SPEED,
): void {
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (offset.lengthSq() < 1e-10) return;

  // Horizontal: spin around world Z (matches compass / plan rotation).
  offset.applyAxisAngle(Z_UP, -deltaX * rotateSpeed);

  // Vertical: elevate around axis ⊥ (Z × view).
  const viewDir = offset.clone().normalize();
  const elevationAxis = new THREE.Vector3().crossVectors(Z_UP, viewDir);
  if (elevationAxis.lengthSq() > 1e-8) {
    elevationAxis.normalize();
    offset.applyAxisAngle(elevationAxis, -deltaY * rotateSpeed);
  }

  // Prevent camera crossing the XY plane (flip / gimbal).
  const horiz = Math.hypot(offset.x, offset.y);
  const minHoriz = 0.08;
  if (horiz < minHoriz) {
    const sign = offset.z >= 0 ? 1 : -1;
    offset.x = minHoriz;
    offset.y = 0;
    offset.z = sign * Math.abs(offset.z || minHoriz);
  }

  camera.position.copy(controls.target).add(offset);
  camera.up.set(0, 0, 1);
  camera.lookAt(controls.target);
  controls.update();
}

/** Rotate heading only (compass): spin around world Z. */
export function applyCompassHeadingDrag(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  deltaRadians: number,
): void {
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  offset.applyAxisAngle(Z_UP, deltaRadians);
  camera.position.copy(controls.target).add(offset);
  camera.up.set(0, 0, 1);
  camera.lookAt(controls.target);
  controls.update();
}

/** Snap so the given world horizontal direction faces the camera (−Y = front = N). */
export function snapCompassCardinal(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  cardinal: "n" | "e" | "s" | "w",
): void {
  const dist = camera.position.distanceTo(controls.target) || 100;
  const dirs: Record<typeof cardinal, [number, number, number]> = {
    n: [0, -1, 0],
    e: [1, 0, 0],
    s: [0, 1, 0],
    w: [-1, 0, 0],
  };
  const dir = dirs[cardinal];
  const { position, target } = snapCameraToDirectionVector(
    camera,
    controls,
    dir,
    dist,
  );
  applyCameraUp(camera, resolveCameraUpForDirection(dir));
  camera.position.set(position.x, position.y, position.z);
  controls.target.set(target.x, target.y, target.z);
  camera.lookAt(controls.target);
  controls.update();
}

export function snapCameraToDirectionVector(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  direction: [number, number, number],
  distance: number,
): { position: Vec3Like; target: Vec3Like } {
  const tx = controls.target.x;
  const ty = controls.target.y;
  const tz = controls.target.z;
  const [vx, vy, vz] = direction;
  const len = Math.hypot(vx, vy, vz) || 1;
  applyCameraUp(camera, resolveCameraUpForDirection(direction));
  return {
    position: {
      x: tx + (vx / len) * distance,
      y: ty + (vy / len) * distance,
      z: tz + (vz / len) * distance,
    },
    target: { x: tx, y: ty, z: tz },
  };
}
