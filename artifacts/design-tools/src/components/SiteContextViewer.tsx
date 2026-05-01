import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  getGetBriefingSourceGlbUrl,
  type EngagementBriefingSource,
} from "@workspace/api-client-react";

/**
 * Read-only Three.js (r128) viewer for the briefing's `ready` glb
 * sources. Materials and property-line edge extraction follow the
 * Spec 52 §2 locked decisions.
 */

export interface SiteContextViewerProps {
  sources: EngagementBriefingSource[];
}

const TERRAIN_COLOR = 0x8b7355;
const PROPERTY_LINE_COLOR = 0xff3344;
const SETBACK_COLOR = 0xe8a23a;
const ENVELOPE_COLOR = 0xcccccc;
const FLOODPLAIN_COLOR = 0x4488cc;
const WETLAND_COLOR = 0x55aa77;
const NEIGHBOR_COLOR = 0xb8c0cc;

type VariantHandler = (root: THREE.Object3D) => THREE.Object3D;

const buildTerrain: VariantHandler = (root) => {
  const mat = new THREE.MeshLambertMaterial({
    color: TERRAIN_COLOR,
    side: THREE.DoubleSide,
  });
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      (obj as THREE.Mesh).material = mat;
    }
  });
  return root;
};

const buildPropertyLine: VariantHandler = (root) => {
  // Spec 52 §2 — property-line via EdgesGeometry → THREE.Line
  // extraction (not a material swap on the mesh).
  const out = new THREE.Group();
  const lineMat = new THREE.LineBasicMaterial({ color: PROPERTY_LINE_COLOR });
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const edges = new THREE.EdgesGeometry(mesh.geometry);
      const line = new THREE.LineSegments(edges, lineMat);
      mesh.matrixWorld.decompose(line.position, line.quaternion, line.scale);
      out.add(line);
    }
  });
  return out;
};

function translucent(color: number, opacity: number): THREE.Material {
  return new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const buildSetback: VariantHandler = (root) => {
  const mat = translucent(SETBACK_COLOR, 0.4);
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).material = mat;
  });
  return root;
};

const buildEnvelope: VariantHandler = (root) => {
  const mat = translucent(ENVELOPE_COLOR, 0.3);
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).material = mat;
  });
  return root;
};

const buildFloodplain: VariantHandler = (root) => {
  const mat = translucent(FLOODPLAIN_COLOR, 0.5);
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).material = mat;
  });
  return root;
};

const buildWetland: VariantHandler = (root) => {
  const mat = translucent(WETLAND_COLOR, 0.5);
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).material = mat;
  });
  return root;
};

const buildNeighborMass: VariantHandler = (root) => {
  // Glassy ~0.5 — translucent neutral mass with low opacity so
  // adjacent buildings read as context, not foreground.
  const mat = new THREE.MeshLambertMaterial({
    color: NEIGHBOR_COLOR,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) (obj as THREE.Mesh).material = mat;
  });
  return root;
};

const VARIANT_HANDLERS: Record<string, VariantHandler> = {
  terrain: buildTerrain,
  "property-line": buildPropertyLine,
  "setback-plane": buildSetback,
  "buildable-envelope": buildEnvelope,
  floodplain: buildFloodplain,
  wetland: buildWetland,
  "neighbor-mass": buildNeighborMass,
};

const RENDERABLE_LAYER_KINDS = new Set(Object.keys(VARIANT_HANDLERS));

interface LoadedSourceState {
  status: "loading" | "loaded" | "error";
  error?: string;
}

function detectWebGl(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((obj) => {
    const mesh = obj as Partial<THREE.Mesh> & Partial<THREE.Line>;
    if (mesh.geometry && typeof mesh.geometry.dispose === "function") {
      mesh.geometry.dispose();
    }
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material && typeof material.dispose === "function") {
      material.dispose();
    }
  });
  group.parent?.remove(group);
}

function applyVariant(root: THREE.Object3D, layerKind: string): THREE.Object3D {
  const handler = VARIANT_HANDLERS[layerKind] ?? buildNeighborMass;
  return handler(root);
}

export function SiteContextViewer({ sources }: SiteContextViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const sourceGroupsRef = useRef<Map<string, THREE.Group>>(new Map());

  const [webGlOk] = useState<boolean>(detectWebGl);
  const [sourceState, setSourceState] = useState<
    Record<string, LoadedSourceState>
  >({});
  const [retryNonce, setRetryNonce] = useState<Record<string, number>>({});

  const readySources = useMemo(
    () =>
      sources
        .filter(
          (s) =>
            s.conversionStatus === "ready" &&
            s.glbObjectPath !== null &&
            s.glbObjectPath !== "",
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
    [sources],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webGlOk) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(
      container.clientWidth || 1,
      container.clientHeight || 1,
      false,
    );
    // Spec 52 §2 / locked decision #5: transparent renderer
    // background. No setClearColor with alpha=1, no scene.background.
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Locked decision #5: ambient ~0.4 + north-aligned directional.
    // No hemisphere fill, no GridHelper — those belong to DA-MV-2.
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    // North-aligned: in the viewer's right-handed space we treat
    // -Z as north, so the sun sits high to the north.
    sun.position.set(0, 100, -100);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(
      45,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.1,
      5000,
    );
    // Iso default: above-and-SW of parcel center (per task spec).
    camera.position.set(-80, 80, 80);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    resize();

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      observer?.disconnect();
      controls.dispose();
      controlsRef.current = null;
      sourceGroupsRef.current.forEach(disposeGroup);
      sourceGroupsRef.current.clear();
      renderer.dispose();
      renderer.domElement.parentNode?.removeChild(renderer.domElement);
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, [webGlOk]);

  useEffect(() => {
    if (!webGlOk) return;
    const scene = sceneRef.current;
    if (!scene) return;

    const groups = sourceGroupsRef.current;
    const wantedIds = new Set(readySources.map((s) => s.id));

    for (const [id, group] of groups.entries()) {
      if (!wantedIds.has(id)) {
        disposeGroup(group);
        groups.delete(id);
      }
    }

    const controller = new AbortController();
    const loader = new GLTFLoader();

    readySources.forEach((source) => {
      if (groups.has(source.id)) return;
      setSourceState((prev) => ({
        ...prev,
        [source.id]: { status: "loading" },
      }));
      const url = getGetBriefingSourceGlbUrl(source.id);
      void fetch(url, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch glb (HTTP ${res.status} ${res.statusText}).`,
            );
          }
          const buffer = await res.arrayBuffer();
          await new Promise<void>((resolve, reject) => {
            loader.parse(
              buffer,
              "",
              (gltf) => {
                if (controller.signal.aborted) {
                  resolve();
                  return;
                }
                const root = new THREE.Group();
                gltf.scene.children
                  .slice()
                  .forEach((child) => root.add(child));
                const variantRoot = applyVariant(root, source.layerKind);
                const group = new THREE.Group();
                group.userData.sourceId = source.id;
                group.userData.layerKind = source.layerKind;
                group.add(variantRoot);
                scene.add(group);
                groups.set(source.id, group);
                setSourceState((prev) => ({
                  ...prev,
                  [source.id]: { status: "loaded" },
                }));
                resolve();
              },
              (err) => reject(err as unknown),
            );
          });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            err instanceof Error ? err.message : "Failed to load 3D mesh.";
          setSourceState((prev) => ({
            ...prev,
            [source.id]: { status: "error", error: message },
          }));
        });
    });

    return () => {
      controller.abort();
    };
    // retryNonce is a dependency so a per-source retry button can
    // force the loader to re-run for a single failed source by
    // bumping its nonce; the existing group-presence check skips
    // sources already loaded.
  }, [readySources, webGlOk, retryNonce]);

  const retryFetch = useCallback((sourceId: string) => {
    // Dropping the group makes the next pass re-fetch only this id.
    const group = sourceGroupsRef.current.get(sourceId);
    if (group) {
      disposeGroup(group);
      sourceGroupsRef.current.delete(sourceId);
    }
    setSourceState((prev) => {
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    setRetryNonce((prev) => ({ ...prev, [sourceId]: (prev[sourceId] ?? 0) + 1 }));
  }, []);

  const dxfSources = sources.filter((s) => s.conversionStatus !== null);

  return (
    <div
      data-testid="site-context-viewer"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        ref={containerRef}
        data-testid="site-context-viewer-canvas"
        style={{
          flex: 1,
          minHeight: 320,
          width: "100%",
          borderRadius: 6,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {!webGlOk && (
          <div
            data-testid="site-context-viewer-webgl-fallback"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
              padding: 16,
              textAlign: "center",
            }}
          >
            Your browser doesn&apos;t support 3D viewing.
          </div>
        )}
        {webGlOk && readySources.length === 0 && (
          <div
            data-testid="site-context-viewer-empty"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-muted)",
              fontSize: 13,
              padding: 16,
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            No 3D geometry yet. Upload a DXF (terrain, property line,
            buildable envelope, …) to populate the scene.
          </div>
        )}
      </div>

      {dxfSources.length > 0 && (
        <div
          data-testid="site-context-viewer-status-panel"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            fontSize: 11,
          }}
        >
          {dxfSources.map((source) => {
            const state = sourceState[source.id];
            const known = RENDERABLE_LAYER_KINDS.has(source.layerKind);
            const isLoadFailed =
              source.conversionStatus === "ready" && state?.status === "error";
            let label: string;
            if (source.conversionStatus === "ready") {
              if (state?.status === "error") {
                label = `${source.layerKind} · load failed`;
              } else if (state?.status === "loaded") {
                label = `${source.layerKind} · in scene`;
              } else {
                label = `${source.layerKind} · loading…`;
              }
            } else if (source.conversionStatus === "failed") {
              label = `${source.layerKind} · conversion not yet complete or failed`;
            } else if (source.conversionStatus === "converting") {
              label = `${source.layerKind} · converting`;
            } else if (source.conversionStatus === "pending") {
              label = `${source.layerKind} · pending`;
            } else {
              label = `${source.layerKind} · conversion not yet complete or failed`;
            }
            return (
              <span
                key={source.id}
                data-testid={`site-context-viewer-status-${source.id}`}
                title={
                  !known ? "No curated material; rendered as massing." : undefined
                }
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "var(--surface-2, var(--info-dim))",
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span>{label}</span>
                {isLoadFailed && (
                  <button
                    type="button"
                    data-testid={`site-context-viewer-retry-${source.id}`}
                    onClick={() => retryFetch(source.id)}
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 3,
                      border: "1px solid var(--border-default, #444)",
                      background: "transparent",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    Retry
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
