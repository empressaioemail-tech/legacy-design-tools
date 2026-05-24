import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MaskCanvas } from "../MaskCanvas";

const mockImageData = {
  data: new Uint8ClampedArray(4),
  width: 100,
  height: 100,
};

function mockCanvasContext() {
  return {
    fillStyle: "",
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    getImageData: vi.fn(() => mockImageData),
    putImageData: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => mockCanvasContext() as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    function (this: HTMLCanvasElement, cb) {
      cb?.(new Blob(["mask"], { type: "image/png" }));
    },
  );

  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin = "";
    width = 200;
    height = 100;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", MockImage);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MaskCanvas", () => {
  it("renders brush controls and exports an initial mask after the image loads", async () => {
    const onMaskChange = vi.fn();
    render(
      <MaskCanvas
        imageUrl="/api/test.png"
        onMaskChange={onMaskChange}
        testId="mask-test"
      />,
    );

    await waitFor(() => {
      expect(onMaskChange).toHaveBeenCalled();
    });

    expect(screen.getByTestId("mask-test")).toBeInTheDocument();
    expect(screen.getByTestId("mask-test-surface")).toBeInTheDocument();
    expect(screen.getByTestId("mask-test-brush-size")).toBeInTheDocument();
    expect(screen.getByTestId("mask-test-clear")).toBeInTheDocument();
  });

  it("clears the mask when Clear mask is clicked", async () => {
    const onMaskChange = vi.fn();
    render(
      <MaskCanvas
        imageUrl="/api/test.png"
        onMaskChange={onMaskChange}
        testId="mask-test"
      />,
    );

    await waitFor(() => {
      expect(onMaskChange).toHaveBeenCalled();
    });

    onMaskChange.mockClear();
    fireEvent.click(screen.getByTestId("mask-test-clear"));
    expect(onMaskChange).toHaveBeenCalled();
  });

  it("disables controls when disabled is true", async () => {
    render(
      <MaskCanvas
        imageUrl="/api/test.png"
        onMaskChange={vi.fn()}
        disabled
        testId="mask-test"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("mask-test-clear")).toBeDisabled();
    });
    expect(screen.getByTestId("mask-test-brush-size")).toBeDisabled();
  });
});
