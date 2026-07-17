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
const _stableEye = new THREE.Vector3();
const _stableTarget = new THREE.Vector3();
const _stableUp = new THREE.Vector3();
const _stableMatrix = new THREE.Matrix4();

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

/**
 * Re-apply lookAt with BIM-stable camera.up derived from the current view
 * direction (target → camera). Use after every programmatic camera move.
 */
export function applyStableCameraView(
  camera: THREE.PerspectiveCamera,
  target: Vec3Like,
): void {
  const dir = computeViewDirection(
    { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target,
  );
  const up = resolveCameraUpForDirection(dir);
  applyCameraUp(camera, up);
  _stableEye.copy(camera.position);
  _stableTarget.set(target.x, target.y, target.z);
  _stableUp.set(up[0], up[1], up[2]);
  _stableMatrix.lookAt(_stableEye, _stableTarget, _stableUp);
  camera.quaternion.setFromRotationMatrix(_stableMatrix);
  applyCameraUp(camera, up);
}

/** Apply stable camera.up then resync OrbitControls internal state (post-snap / post-drag). */
export function syncCameraAndControls(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
): void {
  applyStableCameraView(camera, controls.target);
  controls.update();
}

const _cubeSyncPose = new THREE.Object3D();

/**
 * ViewCube body orientation from stabilized (viewDir, up) — roll is fixed by
 * {@link resolveCameraUpForDirection}, not copied from the live quaternion.
 */
export function computeCubeGroupQuaternion(
  viewDir: [number, number, number],
  up: [number, number, number],
): THREE.Quaternion {
  _cubeSyncPose.position.set(viewDir[0], viewDir[1], viewDir[2]);
  _cubeSyncPose.up.set(up[0], up[1], up[2]);
  _cubeSyncPose.lookAt(0, 0, 0);
  return _cubeSyncPose.quaternion.clone().invert();
}

/** Stabilized cube mirror for the main viewport camera + orbit target. */
export function computeCubeGroupQuaternionFromCamera(
  camera: Vec3Like,
  target: Vec3Like,
): THREE.Quaternion {
  const viewDir = computeViewDirection(camera, target);
  const up = resolveCameraUpForDirection(viewDir);
  return computeCubeGroupQuaternion(viewDir, up);
}

/** ViewCube group orientation — always derived from position + target, not raw quat. */
export function computeCubeGroupQuaternionFromMainCamera(
  camera: THREE.PerspectiveCamera,
  target: Vec3Like,
): THREE.Quaternion {
  return computeCubeGroupQuaternionFromCamera(camera.position, target);
}

/** Place camera on a standard view and sync controls (face / HUD snap). */
export function snapCameraToView(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  direction: [number, number, number],
  distance: number,
): void {
  const { position, target } = snapCameraToDirectionVector(
    camera,
    controls,
    direction,
    distance,
  );
  camera.position.set(position.x, position.y, position.z);
  controls.target.set(target.x, target.y, target.z);
  syncCameraAndControls(camera, controls);
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
    syncCameraAndControls(camera, controls);
    if (t < 1) {
      frame = requestAnimationFrame(tick);
    } else {
      syncCameraAndControls(camera, controls);
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

/** Stay off straight top/bottom poles (elevation ±π/2 in Z-up spherical). */
const MAX_ELEVATION = Math.PI / 2 - 0.06;

/** Orbit the camera around `controls.target` in a Z-up world (true Z-pole spherical). */
export function applyOrbitDrag(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  deltaX: number,
  deltaY: number,
  rotateSpeed = VIEW_CUBE_ORBIT_ROTATE_SPEED,
): void {
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const radius = offset.length();
  if (radius < 1e-10) return;

  const azimuth = Math.atan2(offset.y, offset.x);
  const elevation = Math.atan2(offset.z, Math.hypot(offset.x, offset.y));

  const nextAzimuth = azimuth - deltaX * rotateSpeed;
  const nextElevation = Math.max(
    -MAX_ELEVATION,
    Math.min(MAX_ELEVATION, elevation - deltaY * rotateSpeed),
  );

  const cosElev = Math.cos(nextElevation);
  const sinElev = Math.sin(nextElevation);
  offset.set(
    radius * cosElev * Math.cos(nextAzimuth),
    radius * cosElev * Math.sin(nextAzimuth),
    radius * sinElev,
  );

  camera.position.copy(controls.target).add(offset);
  syncCameraAndControls(camera, controls);
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
  syncCameraAndControls(camera, controls);
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
  camera.position.set(position.x, position.y, position.z);
  controls.target.set(target.x, target.y, target.z);
  syncCameraAndControls(camera, controls);
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
  return {
    position: {
      x: tx + (vx / len) * distance,
      y: ty + (vy / len) * distance,
      z: tz + (vz / len) * distance,
    },
    target: { x: tx, y: ty, z: tz },
  };
}
