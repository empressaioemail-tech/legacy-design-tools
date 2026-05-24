import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ViewCubeWidget } from "../ViewCubeWidget";

const viewCubeMock = vi.hoisted(() => ({
  instances: [] as Array<{ setOrientationFromMainCamera: () => void }>,
  raycastFace: vi.fn(() => null as string | null),
  raycastCompass: vi.fn(() => null as string | null),
  raycastCubeBody: vi.fn(() => false),
  syncCalls: 0,
}));

vi.mock("../ViewCubeRenderer", () => ({
  ViewCubeRenderer: class MockViewCubeRenderer {
    domElement: HTMLCanvasElement;

    constructor(container: HTMLElement) {
      this.domElement = document.createElement("canvas");
      this.domElement.className = "bim-viewport-viewcube-canvas";
      container.appendChild(this.domElement);
      viewCubeMock.instances.push(this);
    }

    setOrientationFromMainCamera() {
      viewCubeMock.syncCalls += 1;
    }

    raycastFace(...args: unknown[]) {
      return viewCubeMock.raycastFace(...args);
    }

    raycastCompass(...args: unknown[]) {
      return viewCubeMock.raycastCompass(...args);
    }

    raycastCubeBody(...args: unknown[]) {
      return viewCubeMock.raycastCubeBody(...args);
    }

    updateHover() {}
    setHoverFace() {}
    render() {}
    dispose() {}
  },
}));

describe("ViewCubeWidget", () => {
  const mainCamera = { current: { quaternion: { x: 0, y: 0, z: 0, w: 1 } } };

  beforeEach(() => {
    viewCubeMock.instances.length = 0;
    viewCubeMock.syncCalls = 0;
    viewCubeMock.raycastFace.mockReset();
    viewCubeMock.raycastCompass.mockReset();
    viewCubeMock.raycastCubeBody.mockReset();
    viewCubeMock.raycastFace.mockReturnValue(null);
    viewCubeMock.raycastCompass.mockReturnValue(null);
    viewCubeMock.raycastCubeBody.mockReturnValue(false);

    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let rafId = 0;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      const id = ++rafId;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        cb(performance.now());
      }, 0);
      rafTimers.set(id, timer);
      return id;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      const timer = rafTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        rafTimers.delete(id);
      }
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("calls onSelectRegion when raycast hits a face", () => {
    viewCubeMock.raycastFace.mockReturnValue("top");
    const onSelectRegion = vi.fn();
    render(
      <ViewCubeWidget mainCamera={mainCamera} onSelectRegion={onSelectRegion} />,
    );
    fireEvent.click(screen.getByTestId("bim-viewport-viewcube-canvas-wrap"));
    expect(onSelectRegion).toHaveBeenCalledWith("top");
  });

  it("syncs cube orientation from the main camera each frame", async () => {
    render(<ViewCubeWidget mainCamera={mainCamera} onSelectRegion={() => {}} />);
    await vi.waitFor(() => {
      expect(viewCubeMock.syncCalls).toBeGreaterThan(0);
    });
  });

  it("wires Home and compass raycast snap", () => {
    viewCubeMock.raycastFace.mockReturnValue(null);
    viewCubeMock.raycastCompass.mockReturnValue("n");
    const onHome = vi.fn();
    const onCompassSnap = vi.fn();
    render(
      <ViewCubeWidget
        mainCamera={mainCamera}
        onSelectRegion={() => {}}
        onHome={onHome}
        onCompassSnap={onCompassSnap}
      />,
    );
    fireEvent.click(screen.getByTestId("bim-viewport-viewcube-home"));
    fireEvent.click(screen.getByTestId("bim-viewport-viewcube-canvas-wrap"));
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onCompassSnap).toHaveBeenCalledWith("n");
  });
});
