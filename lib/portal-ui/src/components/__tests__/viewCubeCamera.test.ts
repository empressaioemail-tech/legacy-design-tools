import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  applyOrbitDrag,
  applyStableCameraView,
  computeCubeGroupQuaternion,
  computeCubeGroupQuaternionFromCamera,
  resolveCameraUpForDirection,
  snapCameraToView,
  syncCameraAndControls,
} from "../viewCubeCamera";
import { faceIdFromWorldNormal } from "../viewCubeModel";

function mockControls(target: THREE.Vector3) {
  return {
    target,
    update: vi.fn(),
  } as unknown as import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
}

describe("applyOrbitDrag (Z-up)", () => {
  it("dragging down changes camera position when above the target", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(10, -10, 40);
    camera.lookAt(target);
    const controls = mockControls(target);

    const before = camera.position.clone();
    applyOrbitDrag(camera, controls, 0, 50);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(0.01);
  });

  it("preserves horizontal front view (elevation ≈ 0) after azimuth drag", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, -30, 0);
    syncCameraAndControls(camera, mockControls(target));

    const controls = mockControls(target);
    applyOrbitDrag(camera, controls, 40, 0);
    const offset = new THREE.Vector3().subVectors(camera.position, target);
    const elevation = Math.atan2(offset.z, Math.hypot(offset.x, offset.y));
    expect(Math.abs(elevation)).toBeLessThan(0.15);
    expect(offset.y).toBeLessThan(-5);
  });

  it("dragging right rotates camera around world Z", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.up.set(0, 0, 1);
    camera.position.set(0, -20, 10);
    camera.lookAt(target);
    const controls = mockControls(target);

    const angleBefore = Math.atan2(camera.position.y, camera.position.x);
    applyOrbitDrag(camera, controls, 60, 0);
    const angleAfter = Math.atan2(camera.position.y, camera.position.x);
    expect(angleAfter).not.toBeCloseTo(angleBefore, 5);
  });
});

describe("resolveCameraUpForDirection", () => {
  it("uses −Y up when looking straight down (top view)", () => {
    const up = resolveCameraUpForDirection([0, 0, 1]);
    expect(up).toEqual([0, -1, 0]);
  });

  it("keeps Z up for elevation views", () => {
    const up = resolveCameraUpForDirection([0, -1, 0]);
    expect(up).toEqual([0, 0, 1]);
  });
});

describe("applyStableCameraView", () => {
  it("keeps Z up on front elevation after view-cube orbit drag", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, -30, 0);
    const controls = mockControls(target);
    syncCameraAndControls(camera, controls);
    expect(camera.up.z).toBeCloseTo(1, 5);

    applyOrbitDrag(camera, controls, 20, 0);
    expect(camera.up.z).toBeCloseTo(1, 5);
    expect(camera.up.y).toBeCloseTo(0, 5);
  });

  it("uses Z up for right elevation", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(40, 0, 10);
    applyStableCameraView(camera, target);
    expect(camera.up.z).toBeCloseTo(1, 5);
    expect(camera.up.y).toBeCloseTo(0, 5);
  });
});

describe("computeCubeGroupQuaternion", () => {
  it("differs from raw inverse quaternion when camera.up is not stabilized", () => {
    const target = { x: 0, y: 0, z: 0 };
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 30);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);

    const stabilized = computeCubeGroupQuaternionFromCamera(
      camera.position,
      target,
    );
    const rawInverse = camera.quaternion.clone().invert();
    expect(stabilized.angleTo(rawInverse)).toBeGreaterThan(0.01);
  });

  it("snapCameraToView locks front elevation with Z up", () => {
    const target = new THREE.Vector3(0, 0, 0);
    const camera = new THREE.PerspectiveCamera();
    const controls = mockControls(target);
    snapCameraToView(camera, controls, [0, -1, 0], 40);
    expect(camera.position.y).toBeLessThan(-5);
    expect(camera.up.z).toBeCloseTo(1, 5);
  });

  it("matches stabilized main-camera inverse when up is explicit", () => {
    const target = { x: 0, y: 0, z: 0 };
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(40, 0, 0);
    applyStableCameraView(camera, target);

    const fromCamera = computeCubeGroupQuaternionFromCamera(
      camera.position,
      target,
    );
    const viewDir = [1, 0, 0] as [number, number, number];
    const up = resolveCameraUpForDirection(viewDir);
    const fromView = computeCubeGroupQuaternion(viewDir, up);
    expect(fromCamera.angleTo(fromView)).toBeLessThan(0.02);
  });
});

describe("faceIdFromWorldNormal", () => {
  it("maps +Z normal to top", () => {
    expect(faceIdFromWorldNormal(0, 0, 1)).toBe("top");
  });

  it("maps −Y normal to front", () => {
    expect(faceIdFromWorldNormal(0, -1, 0)).toBe("front");
  });
});
