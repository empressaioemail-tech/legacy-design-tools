/**
 * End-to-end coverage for the reviewer-facing BIM-viewer interaction
 * model added in Task #380 — free-form panning, cursor-anchored
 * wheel zoom, and the "Reset view" button (Task #401).
 *
 * Why this test exists: Task #380's behaviour is exhaustively
 * covered at the unit level (`BimModelViewport.test.tsx` asserts
 * the OrbitControls config, mouse-button binding, and the
 * `data-camera-fit-applied-count` semantics under a stubbed
 * three.js + happy-dom). What no test currently exercises is the
 * combined production path: a real WebGL renderer, real
 * OrbitControls listeners attached to a live canvas, the
 * cursor-anchored wheel-zoom polyfill firing in capture phase
 * before OrbitControls' bubble-phase listener, and the Reset view
 * button clicking through to `applyCameraFit()` on a real camera.
 *
 * A regression in any one of those would slip past the unit
 * coverage but break the reviewer UX in the browser:
 *
 *   - bumping `three` past 0.128 and inheriting an OrbitControls
 *     that ships its own (incompatible) `zoomToCursor` would
 *     shadow our capture-phase polyfill;
 *   - a refactor that drops the Reset view button's `onClick`
 *     wiring (or moves it behind a different testid) would still
 *     pass the unit test against `fireEvent.click` on the same
 *     testid but render the button inert in the real DOM if a
 *     CSS rule covered it;
 *   - a regression in the rAF render loop (e.g. an effect cleanup
 *     that re-tears it down on every prop change) would stop
 *     `data-camera-live-target` from updating in the browser even
 *     though OrbitControls' internal state advanced.
 *
 * Strategy mirrors `findings-bim-model-jump.spec.ts`:
 *
 *   1. Insert a clean engagement directly via `@workspace/db` so
 *      the test owns a known id and `afterAll`'s cascade-delete
 *      leaves the dev DB pristine.
 *
 *   2. Insert a `parcel_briefings` row directly so the bim-model
 *      push has an `activeBriefingId` to point at, and so we can
 *      attach two hand-seeded `materializable_elements` rows
 *      whose `label`s exactly match the AI fixture findings'
 *      `elementRef`s (`wall:north-side-l2` for the blocker,
 *      `window:bedroom-2-egress` for the concern). Each element
 *      ships an inline polygon ring positioned at very different
 *      coordinates so the auto-fit centre changes detectably
 *      when the reviewer jumps between findings.
 *
 *   3. Create a submission and push to bim-model via the real
 *      routes so the BIM Model tab lands in its non-empty branch
 *      with both seeded elements rendered.
 *
 *   4. Drive the UI through Playwright: open the modal, switch
 *      to Findings, generate the deterministic fixture findings,
 *      drill into the blocker, and click "Show in 3D viewer" to
 *      land on the BIM Model tab with the camera framed onto the
 *      blocker's element.
 *
 *   5. Wheel-scroll inside the canvas — the cursor-anchored
 *      polyfill must move the OrbitControls target away from the
 *      auto-fit centre. We assert `data-camera-live-target`
 *      drifts off `data-camera-target` and that
 *      `data-camera-fit-applied-count` is unchanged (the manual
 *      gesture must NOT trigger a re-frame).
 *
 *   6. Click "Reset view" — the count must increment and the
 *      live target must snap back onto the auto-fit centre.
 *
 *   7. Drag-pan inside the canvas — OrbitControls' real pointer
 *      listeners must move the target again, again without
 *      bumping the fit-applied count.
 *
 *   8. Re-open Findings, drill into the second finding, and click
 *      "Show in 3D viewer" — the auto-fit must re-fire onto the
 *      second element's centre (the count goes up and the
 *      auto-fit centre changes, since the two seeded elements'
 *      polygons are at very different coordinates).
 *
 *   9. `afterAll` deletes the seeded engagement; FK cascades on
 *      `parcel_briefings.engagement_id` and
 *      `materializable_elements.briefing_id` clean everything up.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  engagements,
  materializableElements,
  parcelBriefings,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e BIM Pan/Zoom/Reset ${RUN_TAG}`;
const TEST_NOTE = `e2e-bim-viewer-pan-zoom-reset ${RUN_TAG}`;

/**
 * Pinned to the AI fixture's blocker `elementRef`. The seeded
 * element with this label is the one the first "Show in 3D
 * viewer" click jumps to — the camera frames its inline ring's
 * centre, which is what we assert the live target drifts off
 * after a wheel/drag and snaps back to after Reset view.
 */
const FIRST_FINDING_ELEMENT_REF = "wall:north-side-l2";

/**
 * Pinned to the AI fixture's concern `elementRef`. The seeded
 * element with this label sits at a deliberately different
 * (~110, ~110) location vs. the first element (~5, ~5) so the
 * "re-jump to a different finding still re-frames the camera"
 * assertion can compare the auto-fit centres and tell them
 * apart — and so the per-element auto-fit camera move is large
 * enough that any drift detection threshold can't false-pass.
 */
const SECOND_FINDING_ELEMENT_REF = "window:bedroom-2-egress";

let engagementId = "";
let submissionId = "";

test.beforeAll(async ({ request }) => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: "789 Pan/Zoom Test St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  const [briefing] = await db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  if (!briefing) {
    throw new Error("seed: parcel_briefings insert returned no row");
  }

  // Two materializable elements with inline polygon rings at very
  // different XY locations. Inline rings get extruded into scene
  // slabs by the viewport so the auto-fit centre is the polygon
  // centre — meaning a jump to element #1 fits at (~5, ~5, ~0.25)
  // and a jump to element #2 fits at (~110, ~110, ~0.25). The
  // 100-unit gap between centres is comfortably larger than any
  // reasonable drift threshold a wheel/drag could put on the live
  // target, so the assertions can compare centres without floating-
  // point fuzz.
  await db.insert(materializableElements).values([
    {
      briefingId: briefing.id,
      elementKind: "buildable-envelope",
      label: FIRST_FINDING_ELEMENT_REF,
      geometry: {
        ring: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      },
      locked: false,
    },
    {
      briefingId: briefing.id,
      elementKind: "property-line",
      label: SECOND_FINDING_ELEMENT_REF,
      geometry: {
        ring: [
          [100, 100],
          [120, 100],
          [120, 120],
          [100, 120],
        ],
      },
      locked: false,
    },
  ]);

  const submissionResp = await request.post(
    `/api/engagements/${engagementId}/submissions`,
    {
      data: { note: TEST_NOTE },
      headers: { "content-type": "application/json" },
    },
  );
  if (submissionResp.status() !== 201) {
    throw new Error(
      `seed: POST /api/engagements/${engagementId}/submissions returned ` +
        `${submissionResp.status()}: ${await submissionResp.text()}`,
    );
  }
  const submissionBody = (await submissionResp.json()) as {
    submissionId?: string;
  };
  if (!submissionBody.submissionId) {
    throw new Error("seed: submissions response did not include submissionId");
  }
  submissionId = submissionBody.submissionId;

  // Push to bim-model so the GET returns a non-null `bimModel` and
  // the BIM Model tab lands in its non-empty branch with our seeded
  // elements rendered. Mirrors the dev-only `x-audience: internal`
  // header workaround the sibling specs use (Playwright's
  // APIRequestContext does not inherit the browser's session).
  const pushResp = await request.post(
    `/api/engagements/${engagementId}/bim-model`,
    {
      data: { revitDocumentPath: `e2e:${RUN_TAG}.rvt` },
      headers: {
        "content-type": "application/json",
        "x-audience": "internal",
      },
    },
  );
  if (pushResp.status() !== 200) {
    throw new Error(
      `seed: POST /api/engagements/${engagementId}/bim-model returned ` +
        `${pushResp.status()}: ${await pushResp.text()}`,
    );
  }
});

test.afterAll(async () => {
  if (engagementId) {
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

/**
 * Switches the modal into the Findings tab, generates the
 * deterministic fixture findings if the empty state is visible,
 * drills into the row whose `data-testid` lives under the named
 * severity group, and clicks its "Show in 3D viewer" button. The
 * helper is async-safe across re-entry (the second invocation
 * hits the populated list straight away — no empty-state click).
 */
async function jumpToViewerForFinding(
  modal: Locator,
  severityGroup: "blocker" | "concern",
): Promise<void> {
  await modal.getByTestId("submission-tab-findings").click();
  const findingsTab = modal.getByTestId("findings-tab");
  await expect(findingsTab).toBeVisible();

  // First entry into Findings hits the empty state and needs the
  // "Generate findings" click to seed the fixture; later entries
  // already have findings in the in-memory store and skip straight
  // to the populated list.
  const empty = modal.getByTestId("findings-empty-generate");
  if (await empty.isVisible().catch(() => false)) {
    await empty.click();
    await expect(modal.getByTestId("findings-empty-state")).toHaveCount(0);
  }

  const group = modal.getByTestId(`findings-group-${severityGroup}`);
  await expect(group).toBeVisible();
  const row = group.locator('[data-testid^="finding-row-finding:"]').first();
  await expect(row).toBeVisible();
  await row.click();

  const viewerJump = modal.getByTestId("finding-drill-in-viewer-jump");
  await expect(viewerJump).toBeEnabled();
  await viewerJump.click();

  // The modal switches to the BIM Model tab synchronously inside
  // `handleShowInViewer`, so the BIM tab body mounts on the next
  // render. Wait for it before letting the caller assert on the
  // viewport's data attributes.
  const bimTab = modal.getByTestId("bim-model-tab");
  await expect(bimTab).toBeVisible();
  await expect(modal.getByTestId("bim-model-tab-loading")).toHaveCount(0);
}

/**
 * Plays back a series of `<dx,dy>` pan deltas as a drag gesture
 * inside the live canvas. We anchor the down-stroke at the
 * canvas centre so OrbitControls' pointer-down → pointer-move →
 * pointer-up listeners always see real on-canvas coordinates,
 * and we step the move in increments so the controller observes
 * monotonic motion (a single jump-to-final move can be coalesced
 * by the browser into "no movement" depending on timing).
 */
async function dragInsideCanvas(
  page: Page,
  canvas: Locator,
  totalDx: number,
  totalDy: number,
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("dragInsideCanvas: canvas has no bounding box");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "left" });
  // 12 small steps — enough that OrbitControls' damping + its
  // pointer-move handler always observe motion between frames.
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      startX + (totalDx * i) / steps,
      startY + (totalDy * i) / steps,
    );
  }
  await page.mouse.up({ button: "left" });
}

/**
 * Reads `data-camera-live-target` and parses the comma-separated
 * components — null when the attribute hasn't been written yet
 * (the rAF loop only writes once OrbitControls' target has
 * finite numeric x/y/z, which is always the case once the
 * viewport mounts WebGL but may briefly lag a navigation).
 */
async function readLiveTarget(
  viewport: Locator,
): Promise<[number, number, number] | null> {
  const raw = await viewport.getAttribute("data-camera-live-target");
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number(s));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/**
 * `data-camera-target` is a 3-tuple "<x>,<y>,<z>" derived from the
 * auto-fit React state — never empty when there's a renderable
 * scene. Mirrored here because it shares the same parsing as the
 * live target.
 */
async function readFitTarget(
  viewport: Locator,
): Promise<[number, number, number]> {
  const raw = await viewport.getAttribute("data-camera-target");
  if (!raw) throw new Error("readFitTarget: data-camera-target is empty");
  const parts = raw.split(",").map((s) => Number(s));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`readFitTarget: malformed data-camera-target=${raw}`);
  }
  return [parts[0], parts[1], parts[2]];
}

function distance(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

test("BIM viewer responds to wheel-zoom + drag-pan and Reset view snaps back to the auto-frame", async ({
  page,
}) => {
  const proxyOrigin = new URL(
    process.env["E2E_BASE_URL"] ?? "http://localhost:80",
  );
  await page.context().addCookies([
    {
      name: "pr_session",
      value: encodeURIComponent(JSON.stringify({ audience: "internal" })),
      domain: proxyOrigin.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
    },
  ]);

  await page.goto(`engagements/${engagementId}?tab=submissions`);

  const row = page.getByTestId(`submission-row-${submissionId}`);
  await expect(row).toBeVisible();
  await row.click();

  const modal = page.getByTestId("submission-detail-modal");
  await expect(modal).toBeVisible();

  // ---- Step 1: jump to the blocker finding's element ----
  await jumpToViewerForFinding(modal, "blocker");

  const viewport = modal.getByTestId("bim-model-viewport");
  await expect(viewport).toBeVisible();
  // The viewer must be running its real WebGL pipeline — Chromium
  // in this Playwright config exposes WebGL, so anything else is
  // a regression in `detectWebGl()` (e.g. a refactor that flipped
  // the conditional).
  await expect(viewport).toHaveAttribute("data-webgl-available", "true");

  // The blocker finding's elementRef must have resolved to our
  // first seeded element via the exact-label matcher, with the
  // ring source path picked.
  await expect(viewport).toHaveAttribute(
    "data-selected-element-source",
    "ring",
  );

  // First selection-driven fit landed exactly once.
  await expect(viewport).toHaveAttribute(
    "data-camera-fit-applied-count",
    "1",
  );

  const blockerFitTarget = await readFitTarget(viewport);
  // Sanity-check the auto-fit centre matches the polygon centre
  // (~5, 5, 0.25 — `padBounds` doesn't shift the centre, only
  // expands the bounds, so the framed centre stays put).
  expect(blockerFitTarget[0]).toBeCloseTo(5, 0);
  expect(blockerFitTarget[1]).toBeCloseTo(5, 0);

  // The rAF loop writes `data-camera-live-target` once the live
  // target has finite numerics — wait for it to populate before
  // capturing the baseline. It should agree with the auto-fit
  // centre right after the jump (no manual interaction yet).
  await expect
    .poll(async () => readLiveTarget(viewport), {
      message: "live target should populate after the jump",
      timeout: 5000,
    })
    .not.toBeNull();

  await expect
    .poll(
      async () => {
        const live = await readLiveTarget(viewport);
        if (!live) return Number.POSITIVE_INFINITY;
        return distance(live, blockerFitTarget);
      },
      {
        message:
          "live target should agree with the auto-fit centre after the initial jump",
        timeout: 5000,
      },
    )
    .toBeLessThan(0.5);

  // ---- Step 2: wheel-zoom inside the canvas ----
  const canvas = modal.getByTestId("bim-model-viewport-canvas");
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");
  // Anchor the cursor off-centre so the cursor-anchored zoom has a
  // non-trivial anchor — a centred wheel on a centred target would
  // leave the target in place even with the polyfill working
  // perfectly, so the assertion below could spuriously pass.
  const cursorX = canvasBox.x + canvasBox.width * 0.7;
  const cursorY = canvasBox.y + canvasBox.height * 0.4;
  await page.mouse.move(cursorX, cursorY);
  // A single -240 wheel delta is well above the polyfill's per-tick
  // clamp, but split into 6 ticks to mimic a real trackpad and let
  // the damping loop pick up motion between frames.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -40);
  }

  // The wheel polyfill moved the OrbitControls target — assert the
  // live target drifted at least a unit off the auto-fit centre.
  // (Cursor-anchored zoom on a non-centred cursor always moves the
  // target; if it didn't move, either the polyfill was shadowed or
  // OrbitControls' bubble-phase wheel listener won the race.)
  await expect
    .poll(
      async () => {
        const live = await readLiveTarget(viewport);
        if (!live) return 0;
        return distance(live, blockerFitTarget);
      },
      {
        message:
          "wheel-zoom should move the OrbitControls target off the auto-fit centre",
        timeout: 5000,
      },
    )
    .toBeGreaterThan(0.5);

  // The wheel gesture is a manual interaction — it must NOT
  // re-trigger the auto-frame (Task #380's whole point: don't
  // yank the camera back from the reviewer). The fit-applied
  // count is still 1.
  await expect(viewport).toHaveAttribute(
    "data-camera-fit-applied-count",
    "1",
  );
  // The React-derived auto-fit centre is unchanged either — a
  // wheel-zoom is camera state, not selection state.
  expect(await readFitTarget(viewport)).toEqual(blockerFitTarget);

  // ---- Step 3: click "Reset view" ----
  const resetButton = modal.getByTestId("bim-model-viewport-reset-view");
  await expect(resetButton).toBeVisible();
  await resetButton.click();

  // The fit-applied count goes up by exactly 1 (Reset view is the
  // only event that increments it without a selection change).
  await expect(viewport).toHaveAttribute(
    "data-camera-fit-applied-count",
    "2",
  );

  // And the live target snaps back onto the auto-fit centre.
  await expect
    .poll(
      async () => {
        const live = await readLiveTarget(viewport);
        if (!live) return Number.POSITIVE_INFINITY;
        return distance(live, blockerFitTarget);
      },
      {
        message:
          "Reset view should snap the OrbitControls target back onto the auto-fit centre",
        timeout: 5000,
      },
    )
    .toBeLessThan(0.5);

  // ---- Step 4: drag-pan inside the canvas ----
  await dragInsideCanvas(page, canvas, 120, -80);

  // The drag moved the OrbitControls target off the auto-fit
  // centre (screen-space pan with `screenSpacePanning = true`).
  await expect
    .poll(
      async () => {
        const live = await readLiveTarget(viewport);
        if (!live) return 0;
        return distance(live, blockerFitTarget);
      },
      {
        message:
          "drag-pan should move the OrbitControls target off the auto-fit centre",
        timeout: 5000,
      },
    )
    .toBeGreaterThan(0.5);

  // The drag is also a manual interaction — fit-applied count
  // is still 2 (the Reset view click) and the React-derived
  // auto-fit centre is unchanged.
  await expect(viewport).toHaveAttribute(
    "data-camera-fit-applied-count",
    "2",
  );

  // ---- Step 5: re-jump to the second finding ----
  await jumpToViewerForFinding(modal, "concern");

  // Note: Radix `<TabsContent>` unmounts inactive tab panes by
  // default, so switching Findings → BIM Model → Findings → BIM
  // Model tears the viewport down between visits and the
  // fit-applied counter (which lives in component state) restarts
  // at zero. That's an implementation detail of the modal, not a
  // BIM-viewport regression — we still get a deterministic
  // assertion that "the new visit auto-framed onto the new
  // element" because (a) the count is 1 (the fresh-mount auto-fit
  // fired exactly once), and (b) the auto-fit centre moved from
  // (~5, 5) to (~110, 110), which is what the next assertions
  // pin down.
  await expect(viewport).toHaveAttribute(
    "data-selected-element-source",
    "ring",
  );
  await expect(viewport).toHaveAttribute(
    "data-camera-fit-applied-count",
    "1",
  );

  const concernFitTarget = await readFitTarget(viewport);
  expect(concernFitTarget[0]).toBeCloseTo(110, 0);
  expect(concernFitTarget[1]).toBeCloseTo(110, 0);
  // Sanity: the two centres are far apart, so any "still showing
  // the blocker" regression would surface here as a fit-target
  // that didn't move.
  expect(distance(concernFitTarget, blockerFitTarget)).toBeGreaterThan(50);

  // And the live target now agrees with the new auto-fit centre,
  // confirming the re-jump's `applyCameraFit()` actually wrote
  // through to the live OrbitControls (not just the React state).
  await expect
    .poll(
      async () => {
        const live = await readLiveTarget(viewport);
        if (!live) return Number.POSITIVE_INFINITY;
        return distance(live, concernFitTarget);
      },
      {
        message:
          "re-jumping to a different finding should re-frame the camera onto its element",
        timeout: 5000,
      },
    )
    .toBeLessThan(0.5);
});
