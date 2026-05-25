import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  bounds3FromObject3D,
  boundsExtentFromBox,
  reorientGlbRootForZUp,
  verticalStandingScore,
} from "../bimGlbOrientation";

function boxGroup(sizeX: number, sizeY: number, sizeZ: number): THREE.Group {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(sizeX, sizeY, sizeZ),
    new THREE.MeshBasicMaterial(),
  );
  mesh.position.set(sizeX / 2, sizeY / 2, sizeZ / 2);
  root.add(mesh);
  return root;
}

describe("verticalStandingScore", () => {
  it("prefers tall Z over tall Y at the same footprint", () => {
    const zUp = boundsExtentFromBox(
      new THREE.Box3().setFromObject(boxGroup(14, 18, 24)),
    );
    const yUp = boundsExtentFromBox(
      new THREE.Box3().setFromObject(boxGroup(14, 24, 18)),
    );
    expect(verticalStandingScore(zUp)).toBeGreaterThan(verticalStandingScore(yUp));
  });
});

describe("reorientGlbRootForZUp", () => {
  it("leaves an already Z-up massing unrotated", () => {
    const root = boxGroup(14, 18, 24);
    reorientGlbRootForZUp(root);
    expect(root.rotation.x).toBe(0);
    const ext = boundsExtentFromBox(new THREE.Box3().setFromObject(root));
    expect(ext.dz).toBeCloseTo(24, 0);
  });

  it("does not rotate when footprint depth exceeds height but Z is still vertical", () => {
    const root = boxGroup(24, 20, 16);
    reorientGlbRootForZUp(root);
    expect(root.rotation.x).toBe(0);
    const ext = boundsExtentFromBox(new THREE.Box3().setFromObject(root));
    expect(ext.dz).toBeCloseTo(16, 0);
  });

  it("rotates glTF-style Y-up (+90° X) so height lands on Z", () => {
    const root = boxGroup(14, 28, 10);
    reorientGlbRootForZUp(root);
    expect(root.rotation.x).toBeCloseTo(Math.PI / 2, 5);
    const ext = boundsExtentFromBox(new THREE.Box3().setFromObject(root));
    expect(ext.dz).toBeGreaterThan(25);
    expect(ext.dz).toBeGreaterThan(ext.dy);
  });

  it("returns null bounds for an empty group", () => {
    expect(bounds3FromObject3D(new THREE.Group())).toBeNull();
  });

  it("stands Y-dominant massing when 0° and ±90° scores tie", () => {
    const root = boxGroup(20, 26, 19);
    reorientGlbRootForZUp(root);
    expect(root.rotation.x).toBeCloseTo(Math.PI / 2, 5);
    const ext = boundsExtentFromBox(new THREE.Box3().setFromObject(root));
    expect(ext.dz).toBeGreaterThan(24);
  });

  it("fixes the prior mistaken −90° on Z-up (lying on back)", () => {
    const root = boxGroup(14, 18, 24);
    root.rotation.x = -Math.PI / 2;
    root.updateMatrixWorld(true);
    reorientGlbRootForZUp(root);
    expect(root.rotation.x).toBeCloseTo(0, 5);
    const ext = boundsExtentFromBox(new THREE.Box3().setFromObject(root));
    expect(ext.dz).toBeGreaterThan(20);
  });
});
