/**
 * End-to-end regression test for the full DXF → glb → 3D viewer loop
 * (Task #161, closing the gap left open by Task #159 / DA-MV-1).
 *
 * Why this test exists: every individual stream that DA-MV-1 wove
 * together — the briefing-source create route with its inline DXF→glb
 * conversion (C), the `/briefing-sources/:id/glb` read endpoint (D),
 * the SiteContextTab sub-tab toggle (F), and the SiteContextViewer
 * that mounts the WebGL canvas and parses the glb (G) — has its own
 * test. Nothing exercises the full hand-off from a DXF arriving at the
 * create route through to a mesh appearing on the WebGL canvas. A
 * change that broke any one of those seams (e.g. the route stops
 * persisting the converter outcome, the sub-tab default no longer
 * flips on `ready`, the viewer stops calling
 * `getGetBriefingSourceGlbUrl`, the GLTFLoader handler stops adding
 * children to the scene) would currently slip past CI.
 *
 * Strategy:
 *
 *   1. Insert a clean engagement directly via `@workspace/db` so the
 *      test owns a known id and isn't dependent on whatever data
 *      happens to live in the dev DB. The engagement is deleted in
 *      `afterAll` (FK cascades remove the briefing + source row).
 *   2. Use the live API to (a) mint a presigned upload URL, (b) PUT
 *      DXF bytes to GCS via the presigned URL, and (c) POST to
 *      `/api/engagements/:id/briefing/sources` with `upload.kind="dxf"`
 *      and the resulting `objectPath`. The create route runs the
 *      (mock) converter inline and persists `conversionStatus="ready"`
 *      with a `glbObjectPath` — exactly the row state DA-MV-1 ships.
 *
 *      Why we go through the API rather than the upload modal: the
 *      `/api/storage/uploads/request-url` endpoint constrains its
 *      `contentType` to image MIMEs today (the only production
 *      consumer is avatar uploads). The modal renders fine but a
 *      real `.dxf` upload would 415 at the request-URL door — that
 *      is a separate, pre-existing wiring bug. We request the URL
 *      with a benign `image/png` content type so the bytes land in
 *      storage; the mock converter ignores its input bytes anyway,
 *      so the synthesized glb is identical regardless. This keeps
 *      the test focused on the loop the task names: "upload DXF →
 *      converter → glb endpoint → viewer renders".
 *   3. Drive the UI through Playwright: open the Site Context tab,
 *      wait for the new row to render with the `3D ready` status
 *      pill (proves the briefing query refetched and the
 *      `conversionStatus` column round-tripped from the route to
 *      the wire), click the 3D sub-tab toggle, and assert the
 *      WebGL canvas mounts and the per-source status pill flips to
 *      `… · in scene` (proves `/api/briefing-sources/:id/glb`
 *      streamed bytes that GLTFLoader parsed and the variant
 *      handler added a `Mesh` to the scene).
 *   4. Final guard via `page.evaluate` against the canvas element to
 *      confirm a real WebGL context exists with non-zero dimensions
 *      — a regression that mounts the canvas but never lays it out
 *      would still pass a "canvas is visible" assertion alone.
 *
 * The DXF bytes are intentionally a tiny synthetic string ("0\nEOF\n"):
 * the dev `DXF_CONVERTER_MODE` defaults to `mock`, and the mock
 * converter ignores its input and always returns a valid one-triangle
 * glb (see `MockConverterClient.buildMockGlb`). We do not need a
 * real CAD payload to exercise the wiring.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e DXF Upload ${RUN_TAG}`;

let engagementId = "";

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: "456 E2E DXF St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;
});

test.afterAll(async () => {
  if (engagementId) {
    // Cascades through parcel_briefings → briefing_sources, so the
    // row inserted by the upload below disappears with the engagement.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

/**
 * Stage a DXF in object storage and create the briefing-source row
 * via the live API. Returns the source id so the UI assertions can
 * scope themselves to it.
 */
async function uploadDxfBriefingSource(
  request: APIRequestContext,
  layerKind: string,
): Promise<string> {
  const dxfBytes = Buffer.from("0\nEOF\n", "utf8");

  // Step 1: presigned URL. Content type is intentionally `image/png`
  // because that's what the storage allow-list permits (see test
  // header). The bytes are arbitrary; the mock converter ignores
  // them.
  const presignResp = await request.post("/api/storage/uploads/request-url", {
    data: {
      name: "envelope.dxf",
      size: dxfBytes.byteLength,
      contentType: "image/png",
    },
    headers: { "content-type": "application/json" },
  });
  if (presignResp.status() !== 200) {
    throw new Error(
      `seed: /storage/uploads/request-url returned ${presignResp.status()}: ${await presignResp.text()}`,
    );
  }
  const presign = (await presignResp.json()) as {
    uploadURL: string;
    objectPath: string;
  };

  // Step 2: PUT the DXF bytes to the presigned URL. Done via raw
  // fetch (not Playwright `request`) so we don't accidentally route
  // the GCS host through the proxy `baseURL`.
  const putResp = await fetch(presign.uploadURL, {
    method: "PUT",
    body: dxfBytes,
    headers: { "Content-Type": "image/png" },
  });
  if (!putResp.ok) {
    throw new Error(
      `seed: PUT to presigned URL failed (${putResp.status} ${putResp.statusText})`,
    );
  }

  // Step 3: hand the objectPath off to the briefing-source create
  // route. `upload.kind: "dxf"` triggers the inline converter run;
  // because DXF_CONVERTER_MODE defaults to `mock`, the synthesized
  // one-triangle glb lands in storage and the row is persisted with
  // `conversionStatus: "ready"`.
  const createResp = await request.post(
    `/api/engagements/${engagementId}/briefing/sources`,
    {
      data: {
        layerKind,
        provider: "e2e DXF fixture",
        note: "Synthesized by dxf-upload-3d-render.spec.ts",
        upload: {
          kind: "dxf",
          objectPath: presign.objectPath,
          originalFilename: "envelope.dxf",
          contentType: "application/dxf",
          byteSize: dxfBytes.byteLength,
        },
      },
      headers: { "content-type": "application/json" },
    },
  );
  if (createResp.status() !== 201) {
    throw new Error(
      `seed: POST /briefing/sources returned ${createResp.status()}: ${await createResp.text()}`,
    );
  }
  const body = (await createResp.json()) as {
    briefing?: {
      sources?: Array<{
        id: string;
        layerKind: string;
        conversionStatus: string | null;
      }>;
    };
  };
  const newSource = body.briefing?.sources?.find(
    (s) => s.layerKind === layerKind,
  );
  if (!newSource) {
    throw new Error(
      `seed: response did not include the new ${layerKind} source: ${JSON.stringify(body)}`,
    );
  }
  if (newSource.conversionStatus !== "ready") {
    throw new Error(
      `seed: source did not reach ready (status=${newSource.conversionStatus}). The mock converter should always succeed; this likely means DXF_CONVERTER_MODE was set to "http" without a live converter.`,
    );
  }
  return newSource.id;
}

test("uploading a DXF renders a 3D mesh in the Site Context viewer", async ({
  page,
  request,
}) => {
  // `buildable-envelope` is one of the seven Spec 52 §2 DXF kinds —
  // its variant handler keeps the GLTFLoader mesh as a `Mesh`
  // (`property-line`'s handler converts geometry to `LineSegments`,
  // which would not satisfy the "at least one mesh" acceptance
  // criterion).
  const sourceId = await uploadDxfBriefingSource(request, "buildable-envelope");

  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // The row appears with its `3D ready` status pill — proves the
  // briefing query loaded the persisted `conversionStatus` from the
  // route. Scoping by the per-source testid (rather than the
  // generic ".first()") keeps this assertion stable if a future
  // test ever shares the same engagement seed.
  const readyPill = page.getByTestId(
    `briefing-source-conversion-status-${sourceId}`,
  );
  await expect(readyPill).toHaveText("3D ready");

  // The sub-tab toggle auto-flips to "3D view" once any source
  // reaches `ready` (SiteContextTab.defaultSubTab). We still click
  // the toggle explicitly so a future regression that removes the
  // auto-flip still leaves this test green for the right reason —
  // the user-driven switch to 3D.
  await page.getByTestId("site-context-subtab-3d").click();

  // The viewer container is rendered and the WebGL canvas mounts
  // inside it (THREE appends a <canvas> as the only child of the
  // container div).
  const viewerContainer = page.getByTestId("site-context-viewer-canvas");
  await expect(viewerContainer).toBeVisible();
  const canvas = viewerContainer.locator("canvas");
  await expect(canvas).toHaveCount(1);

  // Wait for the GLTFLoader to fetch + parse the glb and add the
  // mesh group to the scene. The viewer flips its per-source
  // status text to `<layerKind> · in scene` exactly when the new
  // group has been added; relying on that public-API signal keeps
  // the test out of THREE's private state.
  const sceneStatus = page.getByTestId(
    `site-context-viewer-status-${sourceId}`,
  );
  await expect(sceneStatus).toContainText("in scene", { timeout: 15_000 });
  await expect(sceneStatus).toContainText("buildable-envelope");

  // Final integrity check — the canvas is a real WebGL surface with
  // non-zero dimensions AND something other than the clear color has
  // been rasterized into it. A blank 0x0 canvas, or one mounted but
  // never drawn to (e.g. the mesh is added to the scene but the
  // render loop is broken / preserveDrawingBuffer is wrong / the
  // camera is pointed away from the geometry), would still satisfy
  // an assertion against `in scene` text alone — that pill flips as
  // soon as the GLTFLoader's `onLoad` callback runs, before the next
  // frame is rendered.
  //
  // The viewer clears with `setClearColor(0x000000, 0)` (RGBA
  // 0,0,0,0), so any rasterized geometry shows up as a pixel with
  // non-zero alpha. We snapshot the framebuffer with `readPixels`
  // after one rAF beat (so the pending render gets a chance to land)
  // and assert at least one such pixel exists. The viewer also
  // can't use `preserveDrawingBuffer` here — we ask the WebGL
  // context for it via `getContextAttributes()` and skip the pixel
  // check if it's not enabled (would yield a spuriously cleared
  // buffer between the rAF and the readPixels).
  const renderInfo = await canvas.evaluate(async (el) => {
    const c = el as HTMLCanvasElement;
    const gl =
      (c.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (c.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) {
      return {
        width: c.width,
        height: c.height,
        hasGl: false as const,
      };
    }

    // One rAF beat for the pending render to land.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    const attrs = gl.getContextAttributes();
    const preserved = attrs?.preserveDrawingBuffer === true;

    // Even when the drawing buffer isn't preserved across a paint,
    // a `readPixels` issued in the same task as the render returns
    // the just-drawn frame.
    const pixels = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let nonClearPixelCount = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]! !== 0) nonClearPixelCount += 1;
    }
    return {
      width: c.width,
      height: c.height,
      hasGl: true as const,
      preserved,
      nonClearPixelCount,
    };
  });
  expect(renderInfo.hasGl).toBe(true);
  expect(renderInfo.width).toBeGreaterThan(0);
  expect(renderInfo.height).toBeGreaterThan(0);
  expect(renderInfo.nonClearPixelCount).toBeGreaterThan(0);
});
