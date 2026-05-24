import * as THREE from "three";
import { faceIdFromWorldNormal, type ViewCubeFaceId } from "./viewCubeModel";

/**
 * Mini WebGL ViewCube — Z-up BIM axes (matches BimModelViewport):
 *   TOP +Z, FRONT −Y, RIGHT +X, compass N = −Y on the ground (XY) plane.
 *
 * Cube orientation = inverse(mainCamera.quaternion) so visible faces occlude
 * correctly and at most ~3 labeled faces show at once.
 */

const FACE_LABELS: Record<ViewCubeFaceId, string> = {
  right: "RIGHT",
  left: "LEFT",
  top: "TOP",
  bottom: "BOTTOM",
  front: "FRONT",
  back: "BACK",
};

/** BoxGeometry material index → face id (local space, hover highlight only). */
const MATERIAL_TO_FACE: ViewCubeFaceId[] = [
  "right",
  "left",
  "top",
  "bottom",
  "front",
  "back",
];

const _faceNormal = new THREE.Vector3();

export type ViewCubeCompassCardinal = "n" | "e" | "s" | "w";

function makeFaceTexture(label: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return new THREE.CanvasTexture(canvas);
  }
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#4a4a4a";
  ctx.lineWidth = 3;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function makeLabelSprite(text: string, scale = 0.22): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 32);
  }
  const map = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale, scale, 1);
  sprite.userData.cardinal = text.toLowerCase();
  return sprite;
}

export class ViewCubeRenderer {
  readonly domElement: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly cubeGroup: THREE.Group;
  private readonly compassRoot: THREE.Group;
  private readonly cubeMesh: THREE.Mesh;
  private readonly compassGroup: THREE.Group;
  private readonly compassRing: THREE.Mesh;
  private readonly invertQuat = new THREE.Quaternion();
  private readonly yawEuler = new THREE.Euler(0, 0, 0, "ZYX");
  private readonly hitTargets: THREE.Object3D[] = [];
  private readonly size: { w: number; h: number };
  private hoveredFace: ViewCubeFaceId | null = null;
  private baseMaterials: THREE.MeshLambertMaterial[] = [];
  private hoverMaterial: THREE.MeshLambertMaterial;

  constructor(container: HTMLElement, size: { w: number; h: number }) {
    this.size = size;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(size.w, size.h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.domElement = this.renderer.domElement;
    this.domElement.className = "bim-viewport-viewcube-canvas";
    this.domElement.style.display = "block";
    this.domElement.style.touchAction = "none";
    container.appendChild(this.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, size.w / size.h, 0.1, 20);
    this.camera.position.set(2.4, -2.2, 1.9);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(2, -1, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(256, 256);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xd0d8e8, 0.35);
    fill.position.set(-2, 2, 1);
    this.scene.add(fill);

    this.cubeGroup = new THREE.Group();
    this.scene.add(this.cubeGroup);

    this.compassRoot = new THREE.Group();
    // Ground + compass live on the world XY plane below the cube — not rotated
    // with the cube body, so a top-down view still shows the ring beneath TOP.
    this.compassRoot.position.z = -0.72;
    this.scene.add(this.compassRoot);

    this.baseMaterials = (
      [
        "right",
        "left",
        "top",
        "bottom",
        "front",
        "back",
      ] as ViewCubeFaceId[]
    ).map((id) => {
      const tex = makeFaceTexture(FACE_LABELS[id]);
      return new THREE.MeshLambertMaterial({
        map: tex,
        color: 0xffffff,
      });
    });
    this.hoverMaterial = new THREE.MeshLambertMaterial({
      color: 0x00b4d8,
      emissive: 0x003344,
    });

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.cubeMesh = new THREE.Mesh(geometry, this.baseMaterials);
    this.cubeMesh.rotation.x = -Math.PI / 2;
    this.cubeMesh.castShadow = true;
    this.cubeMesh.receiveShadow = false;
    this.cubeMesh.userData.viewCubeBody = true;
    this.cubeGroup.add(this.cubeMesh);
    this.hitTargets.push(this.cubeMesh);

    const edges = new THREE.EdgesGeometry(geometry);
    const edgeLines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x2a2a2a, linewidth: 1 }),
    );
    edgeLines.rotation.x = -Math.PI / 2;
    this.cubeGroup.add(edgeLines);

    const groundGeo = new THREE.PlaneGeometry(2.2, 2.2);
    const groundMat = new THREE.MeshLambertMaterial({
      color: 0x141820,
      transparent: true,
      opacity: 0.92,
    });
    const groundPlate = new THREE.Mesh(groundGeo, groundMat);
    groundPlate.receiveShadow = true;
    this.compassRoot.add(groundPlate);

    this.compassGroup = new THREE.Group();
    this.compassGroup.position.z = 0.04;
    this.compassRoot.add(this.compassGroup);

    const ringGeo = new THREE.RingGeometry(0.72, 0.88, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x888888,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
    });
    this.compassRing = new THREE.Mesh(ringGeo, ringMat);
    this.compassRing.userData.compassRing = true;
    this.compassGroup.add(this.compassRing);
    this.hitTargets.push(this.compassRing);

    const ringR = 0.8;
    const cardinals: Array<{ label: string; pos: [number, number, number] }> = [
      { label: "N", pos: [0, -ringR, 0.02] },
      { label: "E", pos: [ringR, 0, 0.02] },
      { label: "S", pos: [0, ringR, 0.02] },
      { label: "W", pos: [-ringR, 0, 0.02] },
    ];
    for (const c of cardinals) {
      const sprite = makeLabelSprite(c.label, 0.2);
      sprite.position.set(c.pos[0], c.pos[1], c.pos[2]);
      sprite.userData.compassCardinal = c.label.toLowerCase();
      this.compassGroup.add(sprite);
      this.hitTargets.push(sprite);
    }
  }

  setOrientationFromMainCamera(mainCamera: THREE.Camera): void {
    this.invertQuat.copy(mainCamera.quaternion).invert();
    this.cubeGroup.quaternion.copy(this.invertQuat);

    // Compass stays on the ground plane: yaw-only spin so N/E/S/W track heading
    // without pitching up to the top face when the main view is plan (TOP).
    this.yawEuler.setFromQuaternion(this.invertQuat, "ZYX");
    this.compassRoot.rotation.set(0, 0, this.yawEuler.z);
  }

  resize(w: number, h: number): void {
    this.size.w = w;
    this.size.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private updatePointer(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private intersect(clientX: number, clientY: number): THREE.Intersection[] {
    this.updatePointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.hitTargets, false);
  }

  /**
   * Raycast the clicked face using its **world-space outward normal** so the
   * snap matches the face the user sees (local material index is wrong once
   * the cube group is rotated to mirror the main camera).
   */
  raycastFace(clientX: number, clientY: number): ViewCubeFaceId | null {
    const hits = this.intersect(clientX, clientY);
    for (const hit of hits) {
      if (hit.object === this.cubeMesh && hit.face) {
        _faceNormal.copy(hit.face.normal);
        this.cubeMesh.updateMatrixWorld(true);
        _faceNormal.transformDirection(this.cubeMesh.matrixWorld);
        return faceIdFromWorldNormal(_faceNormal.x, _faceNormal.y, _faceNormal.z);
      }
    }
    return null;
  }

  /** True when pointer is over cube body (for drag-orbit). */
  raycastCubeBody(clientX: number, clientY: number): boolean {
    const hits = this.intersect(clientX, clientY);
    return hits.some((h) => h.object.userData.viewCubeBody);
  }

  raycastCompass(clientX: number, clientY: number): ViewCubeCompassCardinal | null {
    const hits = this.intersect(clientX, clientY);
    for (const hit of hits) {
      const cardinal = hit.object.userData.compassCardinal as
        | ViewCubeCompassCardinal
        | undefined;
      if (cardinal) return cardinal;
      if (hit.object.userData.compassRing) {
        const local = this.compassGroup.worldToLocal(hit.point.clone());
        const ax = Math.abs(local.x);
        const ay = Math.abs(local.y);
        if (ay >= ax) return local.y < 0 ? "n" : "s";
        return local.x > 0 ? "e" : "w";
      }
    }
    return null;
  }

  setHoverFace(face: ViewCubeFaceId | null): void {
    if (this.hoveredFace === face) return;
    this.hoveredFace = face;
    if (!face) {
      this.cubeMesh.material = this.baseMaterials;
      return;
    }
    const idx = MATERIAL_TO_FACE.indexOf(face);
    if (idx < 0) return;
    const mats = this.baseMaterials.map((m, i) => (i === idx ? this.hoverMaterial : m));
    this.cubeMesh.material = mats;
  }

  updateHover(clientX: number, clientY: number): void {
    const hits = this.intersect(clientX, clientY);
    for (const hit of hits) {
      if (hit.object === this.cubeMesh && hit.face) {
        const idx = hit.face.materialIndex ?? 0;
        this.setHoverFace(MATERIAL_TO_FACE[idx] ?? null);
        return;
      }
    }
    this.setHoverFace(null);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.cubeMesh.geometry.dispose();
    for (const m of this.baseMaterials) {
      m.map?.dispose();
      m.dispose();
    }
    this.hoverMaterial.dispose();
    this.compassRing.geometry.dispose();
    (this.compassRing.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.domElement.remove();
  }
}
