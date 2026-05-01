/**
 * BimModelViewport — Plan Review reviewer surface for the bim-model
 * 3D viewer (Task #370 — building on the cross-tab jump from
 * Task #343).
 *
 * The viewer wraps a Three.js renderer that happy-dom can't actually
 * execute (no WebGL, no canvas pipeline). The unit under test here is
 * the React-level data flow: which elements end up in the renderable
 * set, how the selection resolves through the AI-style ref matcher,
 * which scene-representation path each selection picks (`ring` vs
 * `glb`), and the camera-fit semantics — all asserted via the
 * deterministic data-attributes the component exposes.
 *
 * Three.js itself is stubbed at the module boundary (mirroring
 * `SiteContextViewer.test.tsx`) so the test never touches a real GL
 * context. The GLTFLoader stub fires `onLoad` synchronously so the
 * `loaded` state + `glbBounds` flip is observable inside `waitFor`.
 *
 * Coverage:
 *   1. Pure helpers (`extractElementBounds`, `extractElementRing`,
 *      `computeCameraFit`) honour every documented geometry shape
 *      and reject malformed / degenerate inputs.
 *   2. Renderable-element accounting: inline-ring elements +
 *      glb-via-briefingSourceId elements both count;
 *      no-geometry-no-source elements are excluded and surface the
 *      no-geometry overlay on selection.
 *   3. Selection resolution mirrors the elements list (id → label
 *      → ci-label → trailing-segment) so the viewport's selection
 *      always agrees with the row pulse.
 *   4. Camera-fit: ring-source selection frames the extruded slab
 *      bounds; glb-source selection frames the GLB-derived bounds
 *      once loaded, falls back to scene bounds while loading.
 *   5. WebGL-fallback / empty-state / GLB-error overlays render
 *      under the right conditions and don't suppress the data
 *      attributes the test contract relies on.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { MaterializableElement } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  webGlAvailable: true,
  fetchMock: vi.fn(),
  parseMock: vi.fn(),
  glbBoundsHook: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  // Most-recently constructed OrbitControls instance — tests
  // use this to assert the pan/zoom configuration applied
  // (Task #380) and to count how many times the camera-fit
  // logic actually wrote a new target into the live controls.
  lastOrbitControls: null as Record<string, unknown> | null,
}));

// Three.js module stub — only the surface BimModelViewport touches.
// Box3.setFromObject reads from `hoisted.glbBoundsHook` so a test
// can prearrange the bounds the GLB load will report.
vi.mock("three", () => {
  class FakeObject {
    children: FakeObject[] = [];
    parent: FakeObject | null = null;
    userData: Record<string, unknown> = {};
    position = { set: () => {} };
    quaternion = { set: () => {} };
    scale = { set: () => {} };
    matrixWorld = { decompose: () => {} };
    isMesh = false;
    geometry?: { dispose: () => void; computeBoundingBox: () => void };
    material?: { dispose: () => void; color?: { setHex: (n: number) => void }; opacity?: number };
    add(child: FakeObject) {
      this.children.push(child);
      child.parent = this;
    }
    remove(child: FakeObject) {
      this.children = this.children.filter((c) => c !== child);
      child.parent = null;
    }
    traverse(cb: (o: FakeObject) => void) {
      cb(this);
      for (const c of this.children) c.traverse(cb);
    }
    clone(_recursive?: boolean): FakeObject {
      const c = new (this.constructor as { new (): FakeObject })();
      c.userData = { ...this.userData };
      return c;
    }
    lookAt() {}
  }
  class Group extends FakeObject {}
  class Scene extends FakeObject {}
  class Mesh extends FakeObject {
    isMesh = true;
    constructor(geom?: unknown, mat?: unknown) {
      super();
      this.geometry = geom as never;
      this.material = mat as never;
    }
  }
  class PerspectiveCamera extends FakeObject {
    aspect = 1;
    up = { set: () => {} };
    updateProjectionMatrix() {}
  }
  class WebGLRenderer {
    domElement: HTMLCanvasElement;
    constructor() {
      this.domElement = document.createElement("canvas");
    }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render() {}
    dispose() {}
  }
  class AmbientLight extends FakeObject {}
  class DirectionalLight extends FakeObject {}
  class Color {
    setHex(_n: number) {}
  }
  class MeshLambertMaterial {
    color = new Color();
    opacity = 1;
    dispose() {}
    constructor(_opts?: unknown) {}
  }
  class Shape {
    moveTo() {}
    lineTo() {}
    closePath() {}
  }
  class ExtrudeGeometry {
    dispose() {}
    rotateX() {}
    constructor(_shape: unknown, _opts: unknown) {}
  }
  class Box3 {
    min = { x: 0, y: 0, z: 0 };
    max = { x: 0, y: 0, z: 0 };
    setFromObject(_obj: FakeObject) {
      this.min = { ...hoisted.glbBoundsHook.min };
      this.max = { ...hoisted.glbBoundsHook.max };
      return this;
    }
  }
  return {
    Object3D: FakeObject,
    Group,
    Scene,
    Mesh,
    PerspectiveCamera,
    WebGLRenderer,
    AmbientLight,
    DirectionalLight,
    Color,
    MeshLambertMaterial,
    Shape,
    ExtrudeGeometry,
    Box3,
    DoubleSide: 2,
    // OrbitControls reads the requested mouse-button / touch
    // bindings off these enums (Task #380 — pan-on-left,
    // dolly-on-middle, rotate-on-right). Values mirror the real
    // three.js exports so the test can assert the binding
    // BimModelViewport applied is the one a reviewer actually
    // sees in the browser.
    MOUSE: { LEFT: 0, MIDDLE: 1, RIGHT: 2, ROTATE: 0, DOLLY: 1, PAN: 2 },
    TOUCH: { ROTATE: 0, PAN: 1, DOLLY_PAN: 2, DOLLY_ROTATE: 3 },
  };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    // Captures every (x, y, z) the camera-fit logic writes to the
    // controls target — tests assert the length of this array to
    // tell "the camera was reframed once / twice / not at all"
    // apart from "the React-derived data-camera-target attribute
    // changed reactively but the camera was left alone".
    targetCalls: Array<[number, number, number]> = [];
    target = {
      set: (x: number, y: number, z: number) => {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this as unknown as {
          targetCalls: Array<[number, number, number]>;
        };
        self.targetCalls.push([x, y, z]);
      },
    };
    enableDamping = false;
    dampingFactor = 0;
    enablePan?: boolean;
    enableZoom?: boolean;
    enableRotate?: boolean;
    screenSpacePanning?: boolean;
    zoomToCursor?: boolean;
    mouseButtons?: { LEFT?: number; MIDDLE?: number; RIGHT?: number };
    touches?: { ONE?: number; TWO?: number };
    update() {}
    dispose() {}
    constructor() {
      hoisted.lastOrbitControls = this as unknown as Record<string, unknown>;
    }
  },
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    parse(
      _buffer: ArrayBuffer,
      _path: string,
      onLoad: (gltf: { scene: { children: unknown[] } }) => void,
    ) {
      hoisted.parseMock(_buffer);
      onLoad({ scene: { children: [] } });
    }
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetBriefingSourceGlbUrl: (id: string) =>
    `/api/briefing-sources/${id}/glb`,
  getGetMaterializableElementGlbUrl: (id: string) =>
    `/api/materializable-elements/${id}/glb`,
}));

const {
  BimModelViewport,
  extractElementBounds,
  extractElementRing,
  computeCameraFit,
} = await import("../BimModelViewport");

function makeElement(
  overrides: Partial<MaterializableElement> & { id: string },
): MaterializableElement {
  return {
    briefingId: "br-1",
    elementKind: "buildable-envelope",
    briefingSourceId: null,
    label: null,
    geometry: {},
    glbObjectPath: null,
    locked: true,
    createdAt: "2026-04-01T09:00:00.000Z",
    updatedAt: "2026-04-01T09:00:00.000Z",
    ...overrides,
  } as MaterializableElement;
}

beforeEach(() => {
  hoisted.webGlAvailable = true;
  hoisted.fetchMock.mockReset();
  // Default to a never-resolving promise so tests that don't
  // care about the GLB-load path don't blow up when the load
  // effect fires fetch on a glb-source element. Tests that
  // exercise loaded / error paths override with their own
  // mockResolvedValue / mockImplementation.
  hoisted.fetchMock.mockImplementation(() => new Promise(() => {}));
  hoisted.parseMock.mockReset();
  hoisted.glbBoundsHook = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  };
  hoisted.lastOrbitControls = null;
  // happy-dom doesn't implement WebGL — stub getContext so the
  // viewport's detectWebGl() branches the test wants.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => (hoisted.webGlAvailable ? ({} as RenderingContext) : null),
  );
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      disconnect() {}
    };
  globalThis.fetch = hoisted.fetchMock as unknown as typeof fetch;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
    () => 0 as unknown as number,
  );
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("extractElementBounds", () => {
  it("returns bounds for a [x, y] polygon ring", () => {
    expect(
      extractElementBounds(
        makeElement({
          id: "el-1",
          geometry: {
            ring: [
              [0, 0],
              [10, 0],
              [10, 5],
              [0, 5],
            ],
          },
        }),
      ),
    ).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 5 });
  });

  it("ignores the z component of [x, y, z] tuples (plan view)", () => {
    expect(
      extractElementBounds(
        makeElement({
          id: "el-1",
          geometry: {
            ring: [
              [-2, -3, 99],
              [4, -3, 99],
              [4, 5, 99],
              [-2, 5, 99],
            ],
          },
        }),
      ),
    ).toEqual({ minX: -2, minY: -3, maxX: 4, maxY: 5 });
  });

  it("unions bounds across a multi-ring `rings` payload", () => {
    expect(
      extractElementBounds(
        makeElement({
          id: "el-1",
          geometry: {
            rings: [
              [
                [0, 0],
                [2, 0],
                [2, 2],
                [0, 2],
              ],
              [
                [10, 10],
                [12, 10],
                [12, 12],
                [10, 12],
              ],
            ],
          },
        }),
      ),
    ).toEqual({ minX: 0, minY: 0, maxX: 12, maxY: 12 });
  });

  it("returns null for an empty ring", () => {
    expect(
      extractElementBounds(
        makeElement({ id: "el-1", geometry: { ring: [] } }),
      ),
    ).toBeNull();
  });

  it("returns null for a degenerate single-point ring", () => {
    expect(
      extractElementBounds(
        makeElement({ id: "el-1", geometry: { ring: [[5, 5]] } }),
      ),
    ).toBeNull();
  });

  it("returns null for a glb-only element with no inline ring", () => {
    expect(
      extractElementBounds(
        makeElement({
          id: "el-1",
          elementKind: "terrain",
          geometry: {},
          glbObjectPath: "/objects/terrain-1",
        }),
      ),
    ).toBeNull();
  });

  it("returns null for a setback-plane normal+offset payload", () => {
    expect(
      extractElementBounds(
        makeElement({
          id: "el-1",
          elementKind: "setback-plane",
          geometry: { normal: [0, 0, 1], offset: 15 },
        }),
      ),
    ).toBeNull();
  });

  it("skips malformed point entries without throwing", () => {
    expect(
      extractElementBounds(
        makeElement({
          id: "el-1",
          geometry: {
            ring: [
              [0, 0],
              [Number.NaN, 1],
              ["bogus", "data"] as unknown as [number, number],
              [3, 3],
              [4],
            ],
          },
        }),
      ),
    ).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
  });
});

describe("extractElementRing", () => {
  it("returns the ring as [x, y] pairs (z dropped) for a single-ring payload", () => {
    expect(
      extractElementRing(
        makeElement({
          id: "el-1",
          geometry: {
            ring: [
              [0, 0, 1],
              [2, 0, 1],
              [2, 2, 1],
            ],
          },
        }),
      ),
    ).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
    ]);
  });

  it("returns the outer (first) ring for a multi-ring payload", () => {
    expect(
      extractElementRing(
        makeElement({
          id: "el-1",
          geometry: {
            rings: [
              [
                [0, 0],
                [3, 0],
                [3, 3],
                [0, 3],
              ],
              [
                [100, 100],
                [101, 100],
                [101, 101],
              ],
            ],
          },
        }),
      ),
    ).toEqual([
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ]);
  });

  it("returns [] for glb-only / empty geometry", () => {
    expect(extractElementRing(makeElement({ id: "el-1" }))).toEqual([]);
    expect(
      extractElementRing(makeElement({ id: "el-2", geometry: { ring: [] } })),
    ).toEqual([]);
  });
});

describe("computeCameraFit", () => {
  it("targets the bounds center and pulls the camera back 1.5× the longest axis", () => {
    expect(
      computeCameraFit({
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 20,
        maxY: 12,
        maxZ: 0.5,
      }),
    ).toEqual({ target: [10, 6, 0.25], distance: 30 });
  });

  it("uses a tiny floor for distance so a degenerate bounds doesn't put the camera at the target", () => {
    const fit = computeCameraFit({
      minX: 5,
      minY: 5,
      minZ: 5,
      maxX: 5,
      maxY: 5,
      maxZ: 5,
    });
    expect(fit.target).toEqual([5, 5, 5]);
    expect(fit.distance).toBeGreaterThan(0);
  });
});

describe("BimModelViewport — Plan Review (Task #370)", () => {
  const elements: MaterializableElement[] = [
    makeElement({
      id: "el-envelope",
      label: "Buildable envelope",
      elementKind: "buildable-envelope",
      geometry: {
        ring: [
          [0, 0],
          [20, 0],
          [20, 12],
          [0, 12],
        ],
      },
    }),
    makeElement({
      id: "el-property-line",
      label: "Property line",
      elementKind: "property-line",
      geometry: {
        ring: [
          [-2, -2],
          [22, -2],
          [22, 14],
          [-2, 14],
        ],
      },
    }),
    makeElement({
      // glb-only: no inline ring, but has a briefingSourceId so the
      // viewer fetches and renders the source GLB.
      id: "el-terrain",
      label: "Site terrain",
      elementKind: "terrain",
      geometry: {},
      briefingSourceId: "src-terrain-1",
      glbObjectPath: "objects/terrain-1.glb",
    }),
    makeElement({
      // Server-side id intentionally ends with the AI-emitted ref's
      // tail so the trailing-segment matcher exercises the
      // `id.endsWith(tail)` branch. No inline ring, no
      // briefingSourceId → unrenderable → no-geometry overlay path.
      id: "el-wall-north-side-l2",
      label: "North side L2",
      elementKind: "setback-plane",
      geometry: { normal: [0, 1, 0], offset: 5 },
      briefingSourceId: null,
    }),
  ];

  it("counts inline-ring AND glb-source elements as renderable, skipping no-source elements", () => {
    render(<BimModelViewport elements={elements} />);
    const viewport = screen.getByTestId("bim-model-viewport");
    // envelope + property-line (ring) + terrain (glb) = 3.
    // wall-north-side-l2 is excluded — neither ring nor source.
    expect(viewport.getAttribute("data-renderable-element-count")).toBe("3");
    expect(within(viewport).queryByTestId("bim-model-viewport-empty")).toBeNull();
  });

  it("exposes the WebGL-available attribute and renders the canvas container", () => {
    render(<BimModelViewport elements={elements} />);
    const viewport = screen.getByTestId("bim-model-viewport");
    expect(viewport.getAttribute("data-webgl-available")).toBe("true");
    expect(
      screen.getByTestId("bim-model-viewport-canvas"),
    ).toBeInTheDocument();
  });

  it("renders the WebGL fallback when the canvas has no GL context", () => {
    hoisted.webGlAvailable = false;
    render(<BimModelViewport elements={elements} />);
    expect(
      screen.getByTestId("bim-model-viewport-webgl-fallback"),
    ).toBeInTheDocument();
    const viewport = screen.getByTestId("bim-model-viewport");
    expect(viewport.getAttribute("data-webgl-available")).toBe("false");
    // Renderable accounting still works without WebGL — the data
    // contract the elements list relies on is decoupled from the
    // canvas pipeline.
    expect(viewport.getAttribute("data-renderable-element-count")).toBe("3");
  });

  it("frames the camera onto the scene bounds when no selection is active", () => {
    render(<BimModelViewport elements={elements} />);
    const viewport = screen.getByTestId("bim-model-viewport");
    // Scene bounds (ring elements only — terrain GLB hasn't loaded
    // yet under the stubbed fetch): union(envelope, property-line)
    // = x:[-2,22], y:[-2,14], z:[0,0.5]. Padded 10% → x:[-4.4,24.4],
    // y:[-3.6,15.6]. Center = (10, 6, 0.25). Distance = max(28.8,
    // 19.2, 0.5) * 1.5 = 43.2.
    expect(viewport.getAttribute("data-camera-target")).toBe("10.00,6.00,0.25");
    expect(viewport.getAttribute("data-camera-distance")).toBe("43.20");
    expect(viewport.getAttribute("data-selected-element-id")).toBe("");
    expect(viewport.getAttribute("data-selected-element-source")).toBe("");
  });

  it("frames the camera onto the matched ring element when selection resolves with inline geometry", () => {
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-envelope"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    // Envelope bounds: x:[0,20], y:[0,12], z:[0,0.5]. Padded 40% on
    // x/y → x:[-8,28], y:[-8,20] (z untouched). Center = (10,6,0.25).
    // Distance = max(36, 28, 0.5) * 1.5 = 54.
    expect(viewport.getAttribute("data-selected-element-id")).toBe(
      "el-envelope",
    );
    expect(viewport.getAttribute("data-selected-element-source")).toBe("ring");
    expect(viewport.getAttribute("data-camera-target")).toBe("10.00,6.00,0.25");
    expect(viewport.getAttribute("data-camera-distance")).toBe("54.00");
  });

  it("falls back to scene-bounds framing + the no-geometry overlay when the matched element has no scene representation", () => {
    // wall-north-side-l2 has no ring AND no briefingSourceId — the
    // graceful unrenderable fallback path. Resolves via the
    // trailing-segment matcher from the AI-style `wall:north-side-l2`
    // ref the finding emitted.
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="wall:north-side-l2"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    expect(viewport.getAttribute("data-selected-element-id")).toBe("");
    expect(viewport.getAttribute("data-selected-element-source")).toBe("");
    const overlay = screen.getByTestId("bim-model-viewport-no-geometry");
    expect(overlay.textContent).toContain("North side L2");
    // Scene-bounds framing remains in place (camera target unchanged
    // from the no-selection case).
    expect(viewport.getAttribute("data-camera-target")).toBe("10.00,6.00,0.25");
  });

  it("issues a glb fetch for an element backed only by a briefingSource and surfaces the loaded state", async () => {
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    // Pre-arrange the bounds the stubbed GLTFLoader will report
    // for the source so we can assert camera-fit framing onto it.
    hoisted.glbBoundsHook = {
      min: { x: -50, y: 0, z: -50 },
      max: { x: 50, y: 4, z: 50 },
    };

    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-terrain"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    // Selection resolves to the glb element and the source-load
    // status flips through the fetch + parse path.
    expect(viewport.getAttribute("data-selected-element-id")).toBe(
      "el-terrain",
    );
    expect(viewport.getAttribute("data-selected-element-source")).toBe("glb");
    await waitFor(() =>
      expect(hoisted.fetchMock).toHaveBeenCalledWith(
        "/api/briefing-sources/src-terrain-1/glb",
        expect.any(Object),
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("bim-model-viewport")
          .getAttribute("data-source-load-src-terrain-1"),
      ).toBe("loaded"),
    );
    // Once loaded, the camera-fit math frames the GLB-derived
    // bounds. Bounds: x:[-50,50], y:[0,4], z:[-50,50]. Padded 25%
    // of max axis (100) = 25 → x:[-75,75], y:[-25,29], z:[-75,75].
    // Center = (0, 2, 0). Distance = 150 * 1.5 = 225.
    await waitFor(() => {
      const v = screen.getByTestId("bim-model-viewport");
      expect(v.getAttribute("data-camera-target")).toBe("0.00,2.00,0.00");
      expect(v.getAttribute("data-camera-distance")).toBe("225.00");
    });
  });

  it("surfaces the glb-loading hint while the fetch is in flight and falls back to scene-bounds framing", async () => {
    let resolveFetch!: (value: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void;
    hoisted.fetchMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFetch = res;
        }),
    );
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-terrain"
      />,
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("bim-model-viewport")
          .getAttribute("data-source-load-src-terrain-1"),
      ).toBe("loading"),
    );
    expect(
      screen.getByTestId("bim-model-viewport-glb-loading"),
    ).toBeInTheDocument();
    // Camera target stays at the scene-bounds center while the GLB
    // loads (no GLB bounds yet → fall through to ring-only scene).
    expect(
      screen.getByTestId("bim-model-viewport").getAttribute("data-camera-target"),
    ).toBe("10.00,6.00,0.25");
    // Resolve the promise so the test cleans up without dangling.
    resolveFetch({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });

  it("surfaces the glb-error overlay when the fetch fails", async () => {
    hoisted.fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-terrain"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("bim-model-viewport-glb-error"),
      ).toBeInTheDocument(),
    );
    expect(
      screen
        .getByTestId("bim-model-viewport")
        .getAttribute("data-source-load-src-terrain-1"),
    ).toBe("error");
  });

  it("renders the empty-state hint when no elements have any renderable representation", () => {
    const noneRenderable = [
      makeElement({
        id: "el-empty",
        elementKind: "buildable-envelope",
        geometry: { ring: [] },
        briefingSourceId: null,
      }),
      makeElement({
        id: "el-setback-only",
        elementKind: "setback-plane",
        geometry: { normal: [0, 0, 1], offset: 10 },
        briefingSourceId: null,
      }),
    ];
    render(<BimModelViewport elements={noneRenderable} />);
    const viewport = screen.getByTestId("bim-model-viewport");
    expect(viewport.getAttribute("data-renderable-element-count")).toBe("0");
    expect(
      screen.getByTestId("bim-model-viewport-empty"),
    ).toBeInTheDocument();
    expect(viewport.getAttribute("data-camera-target")).toBe("");
  });

  it("fetches a glbObjectPath-only element via the materializable-element glb endpoint and frames its loaded bounds", async () => {
    // Task #379 — the schema permits an element to advertise a
    // glbObjectPath without a briefingSourceId (e.g. an architect-
    // supplied mesh that didn't pass through the briefing-source
    // converter pipeline). Before #379 these were classed as
    // "glb-orphan" with a hint that the bytes couldn't be fetched;
    // now the viewer routes the load through the per-element glb
    // endpoint so the mesh loads + the camera frames it.
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    hoisted.glbBoundsHook = {
      min: { x: -10, y: 0, z: -10 },
      max: { x: 10, y: 8, z: 10 },
    };
    const orphanElements: MaterializableElement[] = [
      makeElement({
        id: "el-orphan-mesh",
        label: "Architect-supplied mesh",
        elementKind: "neighbor-mass",
        geometry: {},
        briefingSourceId: null,
        glbObjectPath: "/objects/architect-mesh-7",
      }),
    ];
    render(
      <BimModelViewport
        elements={orphanElements}
        selectedElementRef="el-orphan-mesh"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    // Counts as renderable + selection resolves to the glb path
    // (no longer "glb-orphan" — same source enum as the briefing-
    // source-backed case, just keyed by element id).
    expect(viewport.getAttribute("data-renderable-element-count")).toBe("1");
    expect(viewport.getAttribute("data-selected-element-id")).toBe(
      "el-orphan-mesh",
    );
    expect(viewport.getAttribute("data-selected-element-source")).toBe("glb");
    // Empty-state hint should NOT render — geometry exists.
    expect(
      screen.queryByTestId("bim-model-viewport-empty"),
    ).toBeNull();
    // The viewer fetches the bytes via the new per-element endpoint
    // (Task #379) — never the briefing-source endpoint, since
    // briefingSourceId is null here.
    await waitFor(() =>
      expect(hoisted.fetchMock).toHaveBeenCalledWith(
        "/api/materializable-elements/el-orphan-mesh/glb",
        expect.any(Object),
      ),
    );
    // Once parsed, the per-key load status flips to "loaded" under
    // the element id (the dedup key for direct-element fetches).
    await waitFor(() =>
      expect(
        screen
          .getByTestId("bim-model-viewport")
          .getAttribute("data-source-load-el-orphan-mesh"),
      ).toBe("loaded"),
    );
    // The legacy glb-orphan overlay must no longer surface for this
    // case — bytes are fetchable, no warning needed.
    expect(
      screen.queryByTestId("bim-model-viewport-glb-orphan"),
    ).toBeNull();
  });

  it("does not render the no-geometry overlay when the ref doesn't resolve at all", () => {
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="window:bedroom-2-egress"
      />,
    );
    expect(
      screen.queryByTestId("bim-model-viewport-no-geometry"),
    ).toBeNull();
    // Scene-bounds framing still applies.
    expect(
      screen
        .getByTestId("bim-model-viewport")
        .getAttribute("data-camera-target"),
    ).toBe("10.00,6.00,0.25");
  });

  // --- Task #380 — reviewer pan / zoom / reset-view -----------------

  it("configures OrbitControls for left-mouse pan, screen-space panning, and right-mouse rotate", () => {
    render(<BimModelViewport elements={elements} />);
    const controls = hoisted.lastOrbitControls as
      | (Record<string, unknown> & {
          mouseButtons?: { LEFT?: number; MIDDLE?: number; RIGHT?: number };
          touches?: { ONE?: number; TWO?: number };
        })
      | null;
    expect(controls).not.toBeNull();
    expect(controls?.enablePan).toBe(true);
    expect(controls?.enableZoom).toBe(true);
    expect(controls?.screenSpacePanning).toBe(true);
    // PAN = 2 in the MOUSE enum we expose from the three mock.
    expect(controls?.mouseButtons?.LEFT).toBe(2);
    expect(controls?.mouseButtons?.MIDDLE).toBe(1);
    expect(controls?.mouseButtons?.RIGHT).toBe(0);
    // Touch: single-finger pan, two-finger dolly+rotate (so a
    // pinch zooms in / out the way reviewers expect on a laptop
    // trackpad).
    expect(controls?.touches?.ONE).toBe(1);
    expect(controls?.touches?.TWO).toBe(3);
  });

  it("renders the Reset view button when WebGL is available and there's a frame to restore", () => {
    render(<BimModelViewport elements={elements} />);
    const button = screen.getByTestId("bim-model-viewport-reset-view");
    expect(button).toBeInTheDocument();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("title")).toContain("full scene");
  });

  it("hides the Reset view button when there's no scene to frame (empty renderable set)", () => {
    render(<BimModelViewport elements={[]} />);
    expect(
      screen.queryByTestId("bim-model-viewport-reset-view"),
    ).toBeNull();
  });

  it("hides the Reset view button when WebGL is unavailable (the canvas isn't live, so reset has nothing to act on)", () => {
    hoisted.webGlAvailable = false;
    render(<BimModelViewport elements={elements} />);
    expect(
      screen.queryByTestId("bim-model-viewport-reset-view"),
    ).toBeNull();
  });

  it("re-applies the auto-frame to the live OrbitControls when the reviewer clicks Reset view", () => {
    render(<BimModelViewport elements={elements} selectedElementRef="el-envelope" />);
    const viewport = screen.getByTestId("bim-model-viewport");
    // Initial selection-driven frame ran once.
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("1");
    fireEvent.click(screen.getByTestId("bim-model-viewport-reset-view"));
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("2");
    const controls = hoisted.lastOrbitControls as
      | { targetCalls: Array<[number, number, number]> }
      | null;
    // The reset-driven write targets the same envelope-fit center
    // the initial frame did. Initial call (0,0,0 from the
    // controls constructor) + selection frame + reset frame = 3.
    expect(controls?.targetCalls.length).toBe(3);
    expect(controls?.targetCalls[0]).toEqual([0, 0, 0]);
    expect(controls?.targetCalls[1]).toEqual([10, 6, 0.25]);
    expect(controls?.targetCalls[2]).toEqual([10, 6, 0.25]);
  });

  it("Reset view button label / title reflects the current selection so reviewers know what they're snapping back to", () => {
    const { rerender } = render(
      <BimModelViewport elements={elements} />,
    );
    expect(
      screen.getByTestId("bim-model-viewport-reset-view").getAttribute("title"),
    ).toContain("full scene");
    rerender(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-envelope"
      />,
    );
    expect(
      screen.getByTestId("bim-model-viewport-reset-view").getAttribute("title"),
    ).toContain("selected element");
  });

  it("does not yank the camera back when an unrelated GLB load completes mid-pan", async () => {
    // Reviewer is inspecting a ring element (envelope) and is
    // free-form panning. Meanwhile the terrain GLB finishes
    // loading in the background — the scene bounds would expand,
    // but the auto-frame must NOT re-fire because the reviewer
    // didn't pick a new element.
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    hoisted.glbBoundsHook = {
      min: { x: -50, y: 0, z: -50 },
      max: { x: 50, y: 4, z: 50 },
    };
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-envelope"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    // Initial selection frame.
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("1");
    // Wait for the terrain GLB load to settle.
    await waitFor(() =>
      expect(
        viewport.getAttribute("data-source-load-src-terrain-1"),
      ).toBe("loaded"),
    );
    // Critical: the applied-count is still 1 — the unrelated GLB
    // load did not re-fit the camera (which would have ripped the
    // reviewer's pan/zoom away from them).
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("1");
  });

  it("does re-fit when the reviewer jumps to a different element via Show in 3D viewer", () => {
    const { rerender } = render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-envelope"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("1");
    // Same prop value — should NOT re-fit (nothing changed).
    rerender(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-envelope"
      />,
    );
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("1");
    // New selection — the camera-fit should fire again so the
    // reviewer's "Show in 3D viewer" jump always re-frames.
    rerender(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-property-line"
      />,
    );
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("2");
  });

  it("re-fits onto the GLB-derived bounds once the selected element's GLB resolves", async () => {
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    hoisted.glbBoundsHook = {
      min: { x: -50, y: 0, z: -50 },
      max: { x: 50, y: 4, z: 50 },
    };
    render(
      <BimModelViewport
        elements={elements}
        selectedElementRef="el-terrain"
      />,
    );
    const viewport = screen.getByTestId("bim-model-viewport");
    // Initial frame (scene-bounds fallback while the GLB loads).
    expect(viewport.getAttribute("data-camera-fit-applied-count")).toBe("1");
    await waitFor(() =>
      expect(
        viewport.getAttribute("data-source-load-src-terrain-1"),
      ).toBe("loaded"),
    );
    // GLB bounds now resolved → second fit lands on the
    // GLB-derived frame.
    await waitFor(() =>
      expect(
        viewport.getAttribute("data-camera-fit-applied-count"),
      ).toBe("2"),
    );
    expect(viewport.getAttribute("data-camera-target")).toBe("0.00,2.00,0.00");
  });
});
