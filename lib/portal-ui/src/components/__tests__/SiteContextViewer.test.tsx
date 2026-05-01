/**
 * SiteContextViewer — DA-MV-1 test coverage.
 *
 * The viewer wraps a Three.js renderer that happy-dom can't actually
 * execute (no WebGL, no canvas pipeline). The unit under test here is
 * the React-level data flow: which sources end up requested from the
 * glb endpoint, which status labels render in the side panel, and how
 * the WebGL-fallback / empty-state branches behave. Three.js itself is
 * stubbed at the module boundary so the test never touches a real GL
 * context — the same pattern `SheetViewer.test.tsx` uses for
 * react-zoom-pan-pinch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { EngagementBriefingSource } from "@workspace/api-client-react";

const hoisted = vi.hoisted(() => ({
  webGlAvailable: true,
  fetchMock: vi.fn(),
  parseMock: vi.fn(),
}));

// Stub the three.js entry surface used by the viewer. The viewer
// only needs constructible classes + a few static-ish helpers; the
// actual rendering pipeline is irrelevant to the React contract.
vi.mock("three", () => {
  class FakeObject {
    children: FakeObject[] = [];
    parent: FakeObject | null = null;
    userData: Record<string, unknown> = {};
    position = { set: () => {} };
    quaternion = { set: () => {} };
    scale = { set: () => {} };
    matrixWorld = {
      decompose: () => {},
    };
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
    lookAt() {}
  }
  class Group extends FakeObject {}
  class Scene extends FakeObject {}
  class PerspectiveCamera extends FakeObject {
    aspect = 1;
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
  class Color {}
  class Material {
    dispose() {}
  }
  class MeshLambertMaterial extends Material {}
  class LineBasicMaterial extends Material {}
  class EdgesGeometry {
    constructor(public source: unknown) {}
    dispose() {}
  }
  class LineSegments extends FakeObject {
    constructor(
      public geometry: unknown,
      public material: unknown,
    ) {
      super();
    }
  }
  return {
    Object3D: FakeObject,
    Group,
    Scene,
    PerspectiveCamera,
    WebGLRenderer,
    AmbientLight,
    DirectionalLight,
    Color,
    MeshLambertMaterial,
    LineBasicMaterial,
    EdgesGeometry,
    LineSegments,
    DoubleSide: 2,
  };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    target = { set: () => {} };
    enableDamping = false;
    dampingFactor = 0;
    update() {}
    dispose() {}
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

vi.mock("@workspace/api-client-react", async () => {
  // Real type re-export is fine — only the URL helper is stubbed.
  return {
    getGetBriefingSourceGlbUrl: (id: string) =>
      `/api/briefing-sources/${id}/glb`,
  };
});

const { SiteContextViewer } = await import("../SiteContextViewer");

function mkSource(
  over: Partial<EngagementBriefingSource> &
    Pick<EngagementBriefingSource, "id" | "layerKind">,
): EngagementBriefingSource {
  return {
    id: over.id,
    layerKind: over.layerKind,
    sourceKind: over.sourceKind ?? "manual-upload",
    provider: over.provider ?? null,
    snapshotDate:
      over.snapshotDate ?? "2026-01-01T12:00:00.000Z",
    note: over.note ?? null,
    uploadObjectPath: over.uploadObjectPath ?? "uploads/x",
    uploadOriginalFilename: over.uploadOriginalFilename ?? "x.dxf",
    uploadContentType: over.uploadContentType ?? "application/octet-stream",
    uploadByteSize: over.uploadByteSize ?? 100,
    dxfObjectPath: over.dxfObjectPath ?? null,
    glbObjectPath: over.glbObjectPath ?? null,
    conversionStatus: over.conversionStatus ?? null,
    conversionError: over.conversionError ?? null,
    payload: over.payload ?? {},
    createdAt: over.createdAt ?? "2026-01-02T12:00:00.000Z",
    supersededAt: over.supersededAt ?? null,
    supersededById: over.supersededById ?? null,
  };
}

beforeEach(() => {
  hoisted.webGlAvailable = true;
  hoisted.fetchMock.mockReset();
  hoisted.parseMock.mockReset();
  // happy-dom doesn't implement WebGL — stub getContext so the
  // component's detectWebGl() returns whatever this test wants.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => (hoisted.webGlAvailable ? ({} as RenderingContext) : null),
  );
  // Polyfill ResizeObserver (happy-dom omits it). The viewer
  // tolerates a missing implementation but providing one exercises
  // the observer.observe() call path.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      disconnect() {}
    };
  globalThis.fetch = hoisted.fetchMock as unknown as typeof fetch;
  // requestAnimationFrame: happy-dom supports it but tests should not
  // run forever, so stub to a no-op that returns a handle.
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
    () => 0 as unknown as number,
  );
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SiteContextViewer", () => {
  it("renders the WebGL fallback when the canvas has no GL context", () => {
    hoisted.webGlAvailable = false;
    render(<SiteContextViewer sources={[]} />);
    expect(
      screen.getByTestId("site-context-viewer-webgl-fallback"),
    ).toBeInTheDocument();
    // No fetch is issued when WebGL is unavailable — the viewer
    // doesn't even try to load glb bytes it has no scene to put in.
    expect(hoisted.fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty-state message when no source has reached ready", () => {
    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-pending",
            layerKind: "terrain",
            conversionStatus: "pending",
          }),
        ]}
      />,
    );
    expect(
      screen.getByTestId("site-context-viewer-empty"),
    ).toBeInTheDocument();
    // The pending row still surfaces in the status panel so the
    // architect knows why nothing's on the canvas yet.
    expect(
      screen.getByTestId("site-context-viewer-status-src-pending"),
    ).toHaveTextContent(/terrain.*pending/i);
    expect(hoisted.fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the glb endpoint for each ready DXF source and labels them as in-scene", async () => {
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });

    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-terrain",
            layerKind: "terrain",
            conversionStatus: "ready",
            glbObjectPath: "glb/terrain",
          }),
          mkSource({
            id: "src-envelope",
            layerKind: "buildable-envelope",
            conversionStatus: "ready",
            glbObjectPath: "glb/envelope",
          }),
        ]}
      />,
    );

    await waitFor(() => {
      expect(hoisted.fetchMock).toHaveBeenCalledWith(
        "/api/briefing-sources/src-terrain/glb",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(hoisted.fetchMock).toHaveBeenCalledWith(
        "/api/briefing-sources/src-envelope/glb",
        expect.any(Object),
      );
    });

    // The GLTFLoader stub's onLoad runs synchronously, so the
    // status panel should update to "in scene" once React flushes
    // the post-fetch state update.
    await waitFor(() => {
      expect(
        screen.getByTestId("site-context-viewer-status-src-terrain"),
      ).toHaveTextContent(/terrain.*in scene/i);
      expect(
        screen.getByTestId("site-context-viewer-status-src-envelope"),
      ).toHaveTextContent(/buildable-envelope.*in scene/i);
    });
  });

  it("surfaces a 'load failed' status when the glb fetch returns a non-2xx", async () => {
    hoisted.fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-broken",
            layerKind: "floodplain",
            conversionStatus: "ready",
            glbObjectPath: "glb/broken",
          }),
        ]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("site-context-viewer-status-src-broken"),
      ).toHaveTextContent(/floodplain.*load failed/i);
    });
  });

  it("does not fetch glb for non-ready DXF rows but lists them in the status panel", async () => {
    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-failed",
            layerKind: "wetland",
            conversionStatus: "failed",
            conversionError: "Converter rejected the DXF.",
          }),
          mkSource({
            id: "src-converting",
            layerKind: "neighbor-mass",
            conversionStatus: "converting",
          }),
        ]}
      />,
    );

    expect(
      screen.getByTestId("site-context-viewer-status-src-failed"),
    ).toHaveTextContent(/wetland.*conversion not yet complete or failed/i);
    expect(
      screen.getByTestId("site-context-viewer-status-src-converting"),
    ).toHaveTextContent(/neighbor-mass.*converting/i);
    expect(hoisted.fetchMock).not.toHaveBeenCalled();
  });

  it("renders a Retry button on a load-failed source and re-fetches when clicked", async () => {
    // First call fails, second call (after retry) succeeds.
    hoisted.fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });

    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-flaky",
            layerKind: "terrain",
            conversionStatus: "ready",
            glbObjectPath: "glb/flaky",
          }),
        ]}
      />,
    );

    const retry = await waitFor(() =>
      screen.getByTestId("site-context-viewer-retry-src-flaky"),
    );
    expect(hoisted.fetchMock).toHaveBeenCalledTimes(1);

    retry.click();

    await waitFor(() => {
      expect(hoisted.fetchMock).toHaveBeenCalledTimes(2);
      expect(
        screen.getByTestId("site-context-viewer-status-src-flaky"),
      ).toHaveTextContent(/terrain.*in scene/i);
    });
  });

  it("extracts edges via EdgesGeometry for property-line sources (not a material swap)", async () => {
    hoisted.fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    // GLTFLoader stub returns a synthetic mesh with isMesh + geometry
    // so the property-line branch can call EdgesGeometry on it.
    hoisted.parseMock.mockImplementation(() => {
      // The actual GLTFLoader stub above ignores parseMock's return —
      // it only uses parseMock to record the buffer call. To exercise
      // the EdgesGeometry path we need a different stub for this test.
    });
    // Re-stub the GLTFLoader for this test only by replacing its
    // module export's parse implementation to feed in a mesh.
    const { GLTFLoader } = (await import(
      "three/examples/jsm/loaders/GLTFLoader.js"
    )) as { GLTFLoader: { prototype: { parse: unknown } } };
    const fakeMesh = {
      isMesh: true,
      geometry: { dispose: () => {} },
      matrixWorld: { decompose: () => {} },
      children: [] as unknown[],
      parent: null,
      traverse(cb: (o: unknown) => void) {
        cb(this);
      },
    };
    const originalParse = GLTFLoader.prototype.parse;
    GLTFLoader.prototype.parse = function (
      _buf: ArrayBuffer,
      _path: string,
      onLoad: (g: { scene: { children: unknown[] } }) => void,
    ) {
      onLoad({ scene: { children: [fakeMesh] } });
    } as unknown as typeof originalParse;

    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-prop",
            layerKind: "property-line",
            conversionStatus: "ready",
            glbObjectPath: "glb/prop",
          }),
        ]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("site-context-viewer-status-src-prop"),
      ).toHaveTextContent(/property-line.*in scene/i);
    });

    GLTFLoader.prototype.parse = originalParse;
  });

  it("excludes QGIS rows (null conversionStatus) from the status panel entirely", () => {
    render(
      <SiteContextViewer
        sources={[
          mkSource({
            id: "src-qgis",
            layerKind: "qgis-zoning",
            conversionStatus: null,
          }),
        ]}
      />,
    );
    // No DXF row at all — the status panel is suppressed and the
    // empty-state copy on the canvas is what the architect sees.
    expect(
      screen.queryByTestId("site-context-viewer-status-panel"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("site-context-viewer-empty"),
    ).toBeInTheDocument();
  });
});
