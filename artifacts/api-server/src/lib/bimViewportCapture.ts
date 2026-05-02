/**
 * V1-4 / DA-RP-1 — bim-model viewport capture pipeline.
 *
 * mnml.ai's archDiffusion-v43 endpoint accepts only 2D images (Spec 54
 * v2 §2.1, §6.4); the bim-model lives as 3D glTF/GLB. The route at
 * `POST /api/engagements/:id/renders` calls this helper with a glb
 * URL + camera spec to produce a PNG buffer suitable for upload to
 * mnml as the `image` multipart field.
 *
 * Implementation is a self-contained HTML string with three.js
 * (r128, matching the workspace catalog version the FE BimViewer
 * uses) loaded from a CDN, rendered headlessly via puppeteer. The
 * page sets `window.__captureReady = true` once the GLB has loaded
 * and a frame has been drawn; we wait on that signal before taking
 * the screenshot. A separate `window.__captureError` marker
 * surfaces GLTFLoader failures.
 *
 * Why fresh implementation rather than reusing briefingPdf.ts: the
 * PDF pipeline produces print-style markup via `renderBriefingHtml`
 * — no WebGL canvas. The BimViewer React component lives in
 * `lib/portal-ui` and is Vite-bundled for the FE; loading it inside
 * puppeteer from the api-server's test boundary would require
 * either a built JS bundle or a frontend dev server. The
 * self-contained CDN-three.js HTML is the smaller-blast-radius
 * choice for V1-4. Tech debt: a shared `puppeteerBrowser.ts`
 * extracted from briefingPdf would let both modules amortize the
 * Chromium cold start; deferred to V1-5.
 *
 * Tests mock puppeteer at the module level (vi.mock) — no real
 * Chromium and no CDN network in the unit-test path. End-to-end
 * coverage of the actual rendered output lives in the V1-4 e2e
 * suite (Step 10 of the implementation plan).
 */

import puppeteer, { type Browser } from "puppeteer";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** XYZ vector in world coordinates — scoped local to avoid coupling to mnml-client. */
export interface CaptureVec3 {
  x: number;
  y: number;
  z: number;
}

export interface BimViewportCaptureInput {
  /**
   * Absolute URL the headless browser fetches the GLB from. The route
   * is responsible for resolving the bim-model row to a fetchable URL
   * (signed GCS URL, public path, or `data:` URL for tests). The
   * helper does NOT touch the database — the GLB resolution is
   * Step 6's concern.
   */
  glbUrl: string;
  /** Camera position in world coordinates. */
  cameraPosition: CaptureVec3;
  /** Camera look-at target in world coordinates. */
  cameraTarget: CaptureVec3;
  /** Field of view in degrees. Default 50 — matches the FE BimViewer's default. */
  fov?: number;
  /**
   * Pixel width. Default 1344 — matches Spec 54 v2 §2.1's
   * archDiffusion-v43 auto-resize width so the round trip avoids a
   * server-side resize step.
   */
  width?: number;
  /** Pixel height. Default 896 (3:2 aspect at 1344 wide). */
  height?: number;
  /**
   * Per-capture wall-clock cap. Default 30s — matches the GCS upload
   * + GLB load + WebGL paint budget Spec 54 v2 §6.4 names. The
   * outer route's polling timer is a separate concern.
   */
  timeoutMs?: number;
  /** Background color CSS for the canvas. Default `#eeeeee`. */
  backgroundColor?: string;
}

export interface BimViewportCaptureResult {
  /** PNG buffer of the rendered scene. */
  pngBuffer: Buffer;
  /** Pixel dimensions of the buffer. */
  width: number;
  height: number;
  /** Wall-clock elapsed in the capture call; surfaced for SLO observability. */
  durationMs: number;
}

/**
 * Capture-side failure bucket. The route maps these onto
 * `viewpoint_renders.error_code` values; the FE surfaces a
 * "regenerate" / "report" affordance based on which bucket fired.
 */
export type BimViewportCaptureErrorCode =
  | "load_timeout"
  | "render_failed"
  | "screenshot_failed"
  | "browser_unavailable";

export class BimViewportCaptureError extends Error {
  constructor(
    public readonly code: BimViewportCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BimViewportCaptureError";
    Object.setPrototypeOf(this, BimViewportCaptureError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Browser singleton
// ─────────────────────────────────────────────────────────────────────

/**
 * Module-private headless browser singleton. Mirrors the briefingPdf
 * pattern: lazy launch on first use, reuse for subsequent captures.
 * NOT shared with briefingPdf's singleton — the two modules
 * independently launch Chromium today (acceptable RAM cost; cleanup
 * is a V1-5 refactor).
 */
let browserSingleton: Browser | null = null;
let browserStarting: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserSingleton && browserSingleton.connected) {
    return browserSingleton;
  }
  if (browserStarting) return browserStarting;
  browserStarting = puppeteer
    .launch({
      headless: true,
      // Same flags as briefingPdf (Replit container needs --no-sandbox).
      // We do NOT pass --disable-gpu — headless Chrome falls back to
      // SwiftShader for WebGL without one, which produces a correct
      // (if slow) software-rendered frame.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    })
    .then((b) => {
      browserSingleton = b;
      browserStarting = null;
      return b;
    })
    .catch((err) => {
      browserStarting = null;
      throw err;
    });
  return browserStarting;
}

/**
 * Tear the singleton down. Exposed so the test harness's `afterAll`
 * can hand control back to vitest cleanly without leaving a Chromium
 * child hanging around. Also called from app shutdown if we ever
 * wire SIGTERM handling explicitly.
 */
export async function closeBimViewportBrowserForTests(): Promise<void> {
  if (browserSingleton) {
    const b = browserSingleton;
    browserSingleton = null;
    try {
      await b.close();
    } catch {
      // The browser may have already crashed / been killed; that's
      // fine for a teardown helper, swallow rather than fail the
      // test run.
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Capture entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Render the bim-model GLB at the given camera angle and return a
 * PNG buffer. Throws {@link BimViewportCaptureError} on any failure
 * — the route catches and maps to a `viewpoint_renders.error_code =
 * 'capture_failed'` row state.
 */
export async function captureBimViewport(
  input: BimViewportCaptureInput,
): Promise<BimViewportCaptureResult> {
  const width = input.width ?? 1344;
  const height = input.height ?? 896;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw new BimViewportCaptureError(
      "browser_unavailable",
      `puppeteer.launch failed: ${(err as Error).message}`,
    );
  }

  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    // Reject any in-page dialogs (alert / confirm / prompt) — three.js
    // shouldn't open them, but a malformed GLB might.
    page.on("dialog", (d) => {
      void d.dismiss();
    });

    const html = buildCaptureHtml({
      ...input,
      width,
      height,
      fov: input.fov ?? 50,
      backgroundColor: input.backgroundColor ?? "#eeeeee",
    });

    // setContent with waitUntil: 'load' completes when the script
    // tags finish parsing, NOT when GLTFLoader finishes async work.
    // We wait on window.__captureReady (or __captureError) below.
    try {
      await page.setContent(html, {
        waitUntil: "load",
        timeout: Math.min(timeoutMs, 10_000),
      });
    } catch (err) {
      throw new BimViewportCaptureError(
        "load_timeout",
        `page.setContent timed out: ${(err as Error).message}`,
      );
    }

    // Wait for the in-page script to mark ready or error. The
    // script defers ready by two requestAnimationFrames after the
    // first render call to ensure the WebGL frame has actually
    // been committed to the framebuffer before we screenshot.
    try {
      await page.waitForFunction(
        () => {
          // Inside the browser page context `globalThis === window`,
          // but `globalThis` is in scope under Node lib so the api-
          // server tsconfig (which doesn't enable DOM lib) can
          // typecheck this callback. The script in
          // `buildCaptureHtml` writes to `window.__captureReady` —
          // same identity at runtime.
          const g = globalThis as unknown as {
            __captureReady?: boolean;
            __captureError?: string;
          };
          return g.__captureReady === true || typeof g.__captureError === "string";
        },
        { timeout: timeoutMs - (Date.now() - startedAt) - 1000 },
      );
    } catch (err) {
      throw new BimViewportCaptureError(
        "load_timeout",
        `GLB load + render did not signal ready within ${timeoutMs}ms: ${(err as Error).message}`,
      );
    }

    const errorOnPage = await page.evaluate(() => {
      const g = globalThis as unknown as { __captureError?: string };
      return typeof g.__captureError === "string" ? g.__captureError : null;
    });
    if (errorOnPage) {
      throw new BimViewportCaptureError(
        "render_failed",
        `in-page render error: ${errorOnPage}`,
      );
    }

    let pngBuffer: Buffer;
    try {
      const screenshot = await page.screenshot({
        type: "png",
        omitBackground: false,
      });
      pngBuffer = Buffer.isBuffer(screenshot)
        ? screenshot
        : Buffer.from(screenshot);
    } catch (err) {
      throw new BimViewportCaptureError(
        "screenshot_failed",
        `page.screenshot failed: ${(err as Error).message}`,
      );
    }

    return {
      pngBuffer,
      width,
      height,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try {
      await page.close();
    } catch {
      // Page may already be gone; harmless.
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// HTML builder (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the self-contained capture HTML. Pure function — no I/O, no
 * puppeteer. Exported so unit tests can assert the camera params,
 * the glbUrl, and the three.js script srcs without mocking the
 * entire capture pipeline.
 *
 * Three.js r128 (matches the workspace catalog version the FE
 * BimViewer uses); GLTFLoader exposed as a THREE global from the
 * `examples/js/loaders/GLTFLoader.js` script.
 *
 * The script:
 *   1. Sets up a scene with ambient + directional lighting
 *      (matches the FE viewer's lighting rig — neutral, no
 *      time-of-day effects; that's mnml.ai's job).
 *   2. Creates a perspective camera at the given position + look-at.
 *   3. Loads the GLB via GLTFLoader.
 *   4. Renders one frame.
 *   5. After two requestAnimationFrames (ensures the WebGL draw
 *      has flushed to the framebuffer), sets
 *      `window.__captureReady = true`.
 *   6. On GLTFLoader error, sets `window.__captureError = "<msg>"`.
 */
export function buildCaptureHtml(args: {
  glbUrl: string;
  cameraPosition: CaptureVec3;
  cameraTarget: CaptureVec3;
  fov: number;
  width: number;
  height: number;
  backgroundColor: string;
}): string {
  const { glbUrl, cameraPosition, cameraTarget, fov, width, height, backgroundColor } = args;
  // JSON.stringify each user-controlled value so it interpolates
  // safely into JS literals — defends against any " or \ in the
  // glbUrl (which can contain query params + signatures from GCS).
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>html, body { margin: 0; padding: 0; background: ${backgroundColor}; } canvas { display: block; }</style>
</head>
<body>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
<script>
(function() {
  try {
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(${JSON.stringify(backgroundColor)});

    var camera = new THREE.PerspectiveCamera(${fov}, ${width} / ${height}, 0.1, 100000);
    camera.position.set(${cameraPosition.x}, ${cameraPosition.y}, ${cameraPosition.z});
    camera.lookAt(new THREE.Vector3(${cameraTarget.x}, ${cameraTarget.y}, ${cameraTarget.z}));

    var renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(${width}, ${height});
    renderer.setPixelRatio(1);
    document.body.appendChild(renderer.domElement);

    // Neutral lighting. mnml.ai's render handles time-of-day /
    // weather; we just need the geometry to be visible.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    var dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 1, 0.5);
    scene.add(dir);

    var loader = new THREE.GLTFLoader();
    loader.load(
      ${JSON.stringify(glbUrl)},
      function(gltf) {
        scene.add(gltf.scene);
        renderer.render(scene, camera);
        // Two rAFs after the first render call to ensure the
        // WebGL draw has flushed to the framebuffer before we
        // signal ready — preserveDrawingBuffer guarantees the
        // pixels stay readable for the screenshot.
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            window.__captureReady = true;
          });
        });
      },
      undefined,
      function(err) {
        window.__captureError = "GLTFLoader: " + (err && err.message ? err.message : String(err));
      }
    );
  } catch (e) {
    window.__captureError = "scene-setup: " + (e && e.message ? e.message : String(e));
  }
})();
</script>
</body>
</html>`;
}
