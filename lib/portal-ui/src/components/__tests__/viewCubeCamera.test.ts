import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  applyOrbitDrag,
  resolveCameraUpForDirection,
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

describe("faceIdFromWorldNormal", () => {
  it("maps +Z normal to top", () => {
    expect(faceIdFromWorldNormal(0, 0, 1)).toBe("top");
  });

  it("maps −Y normal to front", () => {
    expect(faceIdFromWorldNormal(0, -1, 0)).toBe("front");
  });
});
