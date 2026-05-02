/**
 * Unit tests for {@link captureBimViewport} and {@link buildCaptureHtml}.
 *
 * Puppeteer is mocked at the module level — no real Chromium, no
 * network. Tests cover:
 *   1. Happy path — capture returns PNG buffer + expected dimensions
 *   2. setContent timeout → BimViewportCaptureError("load_timeout")
 *   3. waitForFunction timeout → BimViewportCaptureError("load_timeout")
 *   4. window.__captureError set → BimViewportCaptureError("render_failed")
 *   5. screenshot throws → BimViewportCaptureError("screenshot_failed")
 *   6. puppeteer.launch throws → BimViewportCaptureError("browser_unavailable")
 *   7. buildCaptureHtml is pure-string, embeds camera params + glbUrl,
 *      uses three.js r128 from CDN, defines the ready/error markers
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────
// Puppeteer mock — vi.hoisted() so the shared mocks exist by the
// time vi.mock's factory runs. Without hoisting, vi.mock fires
// before the const declarations and the factory sees an
// uninitialized binding ("Cannot access 'mockLaunch' before
// initialization").
// ─────────────────────────────────────────────────────────────────────

const { mockPage, mockBrowser, mockLaunch } = vi.hoisted(() => {
  const mockPage = {
    setViewport: vi.fn(),
    on: vi.fn(),
    setContent: vi.fn(),
    waitForFunction: vi.fn(),
    evaluate: vi.fn(),
    screenshot: vi.fn(),
    close: vi.fn(),
  };
  const mockBrowser = {
    connected: true,
    newPage: vi.fn(async () => mockPage),
    close: vi.fn(),
  };
  const mockLaunch = vi.fn(async () => mockBrowser as unknown as object);
  return { mockPage, mockBrowser, mockLaunch };
});

vi.mock("puppeteer", () => ({
  default: { launch: mockLaunch },
}));

// Import after vi.mock so the mocked puppeteer is captured.
import {
  BimViewportCaptureError,
  buildCaptureHtml,
  captureBimViewport,
  closeBimViewportBrowserForTests,
} from "../lib/bimViewportCapture";

const VALID_INPUT = {
  glbUrl: "https://storage.example.test/models/abc.glb",
  cameraPosition: { x: 10, y: 5, z: 10 },
  cameraTarget: { x: 0, y: 0, z: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path responses — individual tests override.
  mockBrowser.connected = true;
  mockLaunch.mockResolvedValue(mockBrowser as unknown as object);
  mockBrowser.newPage.mockResolvedValue(mockPage);
  mockPage.setContent.mockResolvedValue(undefined);
  mockPage.waitForFunction.mockResolvedValue(undefined);
  mockPage.evaluate.mockResolvedValue(null); // no in-page error
  mockPage.screenshot.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(async () => {
  await closeBimViewportBrowserForTests();
});

describe("captureBimViewport — happy path", () => {
  it("returns a PNG buffer at the requested dimensions", async () => {
    const result = await captureBimViewport({ ...VALID_INPUT, width: 1344, height: 896 });
    expect(result.pngBuffer).toBeInstanceOf(Buffer);
    expect(result.pngBuffer.length).toBeGreaterThan(0);
    expect(result.width).toBe(1344);
    expect(result.height).toBe(896);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockPage.setViewport).toHaveBeenCalledWith({
      width: 1344,
      height: 896,
      deviceScaleFactor: 1,
    });
  });

  it("defaults width/height to 1344x896 (Spec 54 v2 §2.1 archdiff width)", async () => {
    const result = await captureBimViewport(VALID_INPUT);
    expect(result.width).toBe(1344);
    expect(result.height).toBe(896);
  });

  it("closes the page after the screenshot (browser singleton survives)", async () => {
    await captureBimViewport(VALID_INPUT);
    expect(mockPage.close).toHaveBeenCalledTimes(1);
    expect(mockBrowser.close).not.toHaveBeenCalled();
  });
});

describe("captureBimViewport — error mapping", () => {
  it("maps puppeteer.launch failure to browser_unavailable", async () => {
    mockLaunch.mockRejectedValueOnce(new Error("chrome binary missing"));
    await expect(captureBimViewport(VALID_INPUT)).rejects.toMatchObject({
      name: "BimViewportCaptureError",
      code: "browser_unavailable",
    });
  });

  it("maps setContent timeout to load_timeout", async () => {
    mockPage.setContent.mockRejectedValueOnce(new Error("Navigation timeout of 10000 ms exceeded"));
    await expect(captureBimViewport(VALID_INPUT)).rejects.toMatchObject({
      name: "BimViewportCaptureError",
      code: "load_timeout",
    });
    // Page is closed even on the failure path (finally block).
    expect(mockPage.close).toHaveBeenCalled();
  });

  it("maps waitForFunction timeout to load_timeout", async () => {
    mockPage.waitForFunction.mockRejectedValueOnce(new Error("waitForFunction: Timeout 30000ms exceeded"));
    await expect(captureBimViewport(VALID_INPUT)).rejects.toMatchObject({
      code: "load_timeout",
    });
  });

  it("maps in-page __captureError to render_failed (verbatim message)", async () => {
    mockPage.evaluate.mockResolvedValueOnce("GLTFLoader: Could not parse glTF JSON");
    await expect(captureBimViewport(VALID_INPUT)).rejects.toMatchObject({
      name: "BimViewportCaptureError",
      code: "render_failed",
      message: expect.stringContaining("Could not parse glTF JSON"),
    });
  });

  it("maps screenshot failure to screenshot_failed", async () => {
    mockPage.screenshot.mockRejectedValueOnce(new Error("Target closed"));
    await expect(captureBimViewport(VALID_INPUT)).rejects.toMatchObject({
      code: "screenshot_failed",
    });
  });

  it("BimViewportCaptureError survives instanceof + name + code shape", () => {
    const err = new BimViewportCaptureError("load_timeout", "x");
    expect(err).toBeInstanceOf(BimViewportCaptureError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BimViewportCaptureError");
    expect(err.code).toBe("load_timeout");
    expect(err.message).toBe("x");
  });
});

describe("buildCaptureHtml", () => {
  const INPUT = {
    glbUrl: "https://gcs.example/abc.glb?signed=1&exp=2026",
    cameraPosition: { x: 1.5, y: -2.0, z: 7 },
    cameraTarget: { x: 0, y: 0, z: 0 },
    fov: 50,
    width: 1344,
    height: 896,
    backgroundColor: "#eeeeee",
  };

  it("embeds the glbUrl as a JSON-escaped string literal", () => {
    const html = buildCaptureHtml(INPUT);
    // The URL has & in it — must be escaped or JSON-quoted, never
    // raw-interpolated into HTML attribute / unquoted JS context.
    expect(html).toContain(JSON.stringify(INPUT.glbUrl));
  });

  it("embeds the camera position + target as numeric JS literals", () => {
    const html = buildCaptureHtml(INPUT);
    expect(html).toContain("camera.position.set(1.5, -2, 7)");
    expect(html).toContain("camera.lookAt(new THREE.Vector3(0, 0, 0))");
  });

  it("embeds fov + dimensions in the PerspectiveCamera ctor", () => {
    const html = buildCaptureHtml(INPUT);
    expect(html).toContain("new THREE.PerspectiveCamera(50, 1344 / 896,");
    expect(html).toContain("renderer.setSize(1344, 896)");
  });

  it("loads three.js r128 from jsdelivr CDN (matches workspace catalog)", () => {
    const html = buildCaptureHtml(INPUT);
    expect(html).toContain(
      "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js",
    );
    expect(html).toContain(
      "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js",
    );
  });

  it("defines the __captureReady + __captureError window markers", () => {
    const html = buildCaptureHtml(INPUT);
    expect(html).toContain("window.__captureReady = true");
    expect(html).toContain("window.__captureError =");
  });

  it("uses preserveDrawingBuffer so screenshots can read the WebGL canvas", () => {
    const html = buildCaptureHtml(INPUT);
    expect(html).toContain("preserveDrawingBuffer: true");
  });

  it("defers the ready signal by two rAFs after the first render call", () => {
    const html = buildCaptureHtml(INPUT);
    // Two nested requestAnimationFrame calls — the helper waits one
    // frame for the WebGL draw to commit and a second for any
    // post-paint compositor work before signaling ready.
    const rafCount = (html.match(/requestAnimationFrame/g) ?? []).length;
    expect(rafCount).toBe(2);
  });
});
