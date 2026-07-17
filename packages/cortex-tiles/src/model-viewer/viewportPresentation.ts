import * as THREE from "three";

export interface PresentationRig {
  envMap: THREE.Texture | null;
  ground: THREE.Mesh;
  keyLight: THREE.DirectionalLight;
  dispose: () => void;
}

/** ACES + sRGB output tuned for architectural presentation (not flat CAD). */
export function configurePresentationRenderer(
  renderer: THREE.WebGLRenderer,
  exposure: number,
): void {
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    if ((THREE as unknown as { PCFSoftShadowMap?: number }).PCFSoftShadowMap !== undefined) {
      renderer.shadowMap.type = (THREE as unknown as { PCFSoftShadowMap: number })
        .PCFSoftShadowMap;
    }
  }
  if ((THREE as unknown as { ACESFilmicToneMapping?: number }).ACESFilmicToneMapping !== undefined) {
    renderer.toneMapping = (THREE as unknown as { ACESFilmicToneMapping: number })
      .ACESFilmicToneMapping;
  }
  renderer.toneMappingExposure = exposure;
  if ((THREE as unknown as { SRGBColorSpace?: string }).SRGBColorSpace) {
    (renderer as unknown as { outputColorSpace?: string }).outputColorSpace = (
      THREE as unknown as { SRGBColorSpace: string }
    ).SRGBColorSpace;
  }
}

/** Soft studio IBL without extra addon bundles — cheap PMREM from a fill scene. */
export function createStudioEnvironmentMap(
  renderer: THREE.WebGLRenderer,
): THREE.Texture | null {
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    if (typeof pmrem.compileEquirectangularShader === "function") {
      pmrem.compileEquirectangularShader();
    }
    const envScene = new THREE.Scene();
    envScene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const sky = new THREE.HemisphereLight(0xf0f4ff, 0x3a4048, 0.9);
    envScene.add(sky);
    const warm = new THREE.DirectionalLight(0xfff0e0, 0.5);
    warm.position.set(80, -120, 160);
    envScene.add(warm);
    const cool = new THREE.DirectionalLight(0xc8d8ff, 0.35);
    cool.position.set(-120, 80, 60);
    envScene.add(cool);
    const envMap = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    return envMap;
  } catch {
    return null;
  }
}

export function createPresentationRig(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): PresentationRig {
  const envMap = createStudioEnvironmentMap(renderer);
  if (envMap) {
    scene.environment = envMap;
  }

  const hemi = new THREE.HemisphereLight(0xe8eeff, 0x3a4248, 0.65);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffffff, 0.28);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(140, -180, 260);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 2000;
  const shadowSpan = 400;
  keyLight.shadow.camera.left = -shadowSpan;
  keyLight.shadow.camera.right = shadowSpan;
  keyLight.shadow.camera.top = shadowSpan;
  keyLight.shadow.camera.bottom = -shadowSpan;
  keyLight.shadow.bias = -0.00015;
  scene.add(keyLight);
  scene.add(keyLight.target);

  const fill = new THREE.DirectionalLight(0xb8c8ff, 0.45);
  fill.position.set(-180, 140, 120);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe8d0, 0.38);
  rim.position.set(20, 220, -140);
  scene.add(rim);

  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x1c2330,
    roughness: 0.88,
    metalness: 0.04,
  });
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1, 72),
    groundMat,
  );
  ground.rotation.x = 0;
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.visible = false;
  scene.add(ground);

  return {
    envMap,
    ground,
    keyLight,
    dispose: () => {
      envMap?.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
    },
  };
}

/** Scale/fade the ground disc under the framed model. */
export function updatePresentationGround(
  ground: THREE.Mesh,
  target: THREE.Vector3,
  span: number,
  minZ: number,
): void {
  const radius = Math.max(span * 1.35, 12);
  ground.position.set(target.x, target.y, minZ - 0.02);
  ground.scale.set(radius, radius, 1);
  ground.visible = radius > 0;
}

export function enhanceGlbMaterialsForPresentation(
  root: THREE.Object3D,
  envMap: THREE.Texture | null,
): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      try {
        const mat = m as THREE.MeshStandardMaterial & {
          isMeshStandardMaterial?: boolean;
          metalness?: number;
          roughness?: number;
          envMap?: THREE.Texture | null;
          envMapIntensity?: number;
          emissive?: THREE.Color;
          emissiveIntensity?: number;
        };
        if (mat.color && typeof mat.color.getHSL === "function") {
          const hsl = { h: 0, s: 0, l: 0 };
          mat.color.getHSL(hsl);
          const targetL = Math.max(hsl.l, 0.42);
          mat.color.setHSL(hsl.h, Math.min(hsl.s, 0.35), targetL);
        }
        if (typeof mat.metalness === "number") {
          mat.metalness = Math.min(mat.metalness, 0.12);
        }
        if (typeof mat.roughness === "number") {
          mat.roughness = Math.min(Math.max(mat.roughness, 0.35), 0.82);
        }
        if (envMap && (mat.isMeshStandardMaterial || typeof mat.envMapIntensity === "number")) {
          mat.envMap = envMap;
          mat.envMapIntensity = 0.85;
        }
        if (mat.emissive && typeof mat.emissive.copy === "function" && mat.color) {
          mat.emissive.copy(mat.color).multiplyScalar(0.04);
          if (typeof mat.emissiveIntensity === "number") mat.emissiveIntensity = 1;
        }
      } catch {
        /* IFC vertex-color / lambert mats — leave as-is */
      }
    }
  });
}
