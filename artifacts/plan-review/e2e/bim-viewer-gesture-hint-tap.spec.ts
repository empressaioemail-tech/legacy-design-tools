/**
 * End-to-end coverage for the tablet-friendly tap-to-toggle gesture
 * hint added in Task #408 — the small "?" affordance the
 * BimModelViewport collapses the gesture legend down into after the
 * reviewer demonstrates they know the pan/zoom/rotate gestures
 * (Task #405). Tablet reviewers (no hover, no Tab navigation) must
 * be able to tap the "?" to re-summon the legend, tap it again to
 * close it, and have a subsequent canvas pan also clear the
 * tap-opened legend.
 *
 * Why this test exists: Task #408's behaviour is already exhaustively
 * covered at the unit level inside `BimModelViewport.test.tsx` —
 * those tests synthesize click / pointerdown / wheel events under
 * happy-dom against a stubbed three.js. What no test currently
 * exercises is the same behaviour through the real touch-event
 * pipeline a tablet reviewer triggers, where:
 *
 *   - the browser dispatches `pointerdown` events with
 *     `pointerType === "touch"` from `page.touchscreen.tap(...)`
 *     rather than synthetic `pointerdown` from `fireEvent`;
 *   - the legend's `pointer-events: none` style has to keep working
 *     under a real layout / hit-testing pipeline so the "?" stays
 *     reachable through the visually-overlapping legend (a
 *     regression that lets a parent component intercept the tap, or
 *     a stylesheet that flips the legend's pointer-events back to
 *     `auto`, would break the affordance in production but slip past
 *     the unit tests);
 *   - the canvas's pointerdown listener (Task #405's dismiss seam)
 *     fires from a real touch event on a real WebGL canvas, not from
 *     a synthetic `fireEvent.pointerDown` against a stubbed renderer
 *     dom element — a refactor that drops the listener registration
 *     or moves it to a non-passive option that browsers reject would
 *     surface here as the canvas tap no longer clearing the sticky
 *     tap-opened state.
 *
 * Strategy mirrors `bim-viewer-pan-zoom-reset.spec.ts`:
 *
 *   1. Insert a clean engagement directly via `@workspace/db` so the
 *      test owns a known id and `afterAll`'s cascade-delete leaves
 *      the dev DB pristine.
 *
 *   2. Insert a `parcel_briefings` row directly so the bim-model
 *      push has an `activeBriefingId` to point at, and so we can
 *      attach a hand-seeded `materializable_elements` row with an
 *      inline polygon ring — that's all the viewport needs to
 *      compute a `cameraFit` and render the gesture legend.
 *
 *   3. Create a submission and push to bim-model via the real
 *      routes so the BIM Model tab lands in its non-empty branch
 *      and the BimModelViewport actually mounts.
 *
 *   4. Drive the UI through a touch-emulated browser context
 *      (`test.use({ hasTouch: true })` enables `page.touchscreen`
 *      and turns `Locator.tap()` into real touch events): open the
 *      modal, switch to the BIM Model tab, assert the initial
 *      legend is visible, tap the canvas to dismiss it, tap the "?"
 *      to re-summon, tap "?" again to collapse, then re-tap the "?"
 *      and tap the canvas to confirm a canvas gesture also clears
 *      the sticky tap-opened state.
 *
 *   5. `afterAll` deletes the seeded engagement; FK cascades on
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
const TEST_PROJECT_NAME = `e2e BIM Hint Tap Toggle ${RUN_TAG}`;
const TEST_NOTE = `e2e-bim-hint-tap-toggle ${RUN_TAG}`;

let engagementId = "";
let submissionId = "";

// `hasTouch: true` is the minimal context flag that turns on
// `page.touchscreen` and makes `Locator.tap()` dispatch real
// touchstart/touchend events (Chromium then synthesises
// `pointerdown` with `pointerType === "touch"`, which is what the
// canvas dismiss listener and the "?" toggle's `onClick` are
// designed to consume). We deliberately don't set `isMobile` —
// that would shrink the viewport into a phone shape and the
// submission detail modal lays out differently in that mode, which
// is a separate concern and not the regression surface we're
// trying to pin down here.
test.use({ hasTouch: true });

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
      address: "987 Hint Tap St, Moab, UT 84532",
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

  // A single inline-ring materializable element is enough to give
  // the viewport a non-null `cameraFit` (the legend is gated on
  // `webGlOk && cameraFit`), so the gesture-hint surface is live
  // the moment the BIM Model tab mounts. We don't need a label
  // matcher target here — the test never drives the "Show in 3D
  // viewer" cross-tab jump, just lands on the BIM Model tab and
  // exercises the on-canvas hint affordance.
  await db.insert(materializableElements).values({
    briefingId: briefing.id,
    elementKind: "buildable-envelope",
    label: `e2e-hint-tap-element-${RUN_TAG}`,
    geometry: {
      ring: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    },
    locked: false,
  });

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
  // the BIM Model tab lands in its non-empty branch. The dev-only
  // `x-audience: internal` header is the same workaround the
  // sibling specs use (Playwright's APIRequestContext does not
  // inherit the browser's session, so the architect-audience guard
  // would otherwise reject this push).
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
 * Plays back a touch tap inside the live canvas via Playwright's
 * `touchscreen.tap` API. The dismiss seam (Task #405) listens for
 * `pointerdown` on the renderer's canvas; Chromium synthesises a
 * `pointerdown` with `pointerType === "touch"` from a real OS-level
 * touch input, which is exactly what `page.touchscreen.tap` injects
 * (a synthetic `TouchEvent` dispatched via `dispatchEvent` would
 * NOT fire the pointer-event compatibility pipeline, so the
 * listener would never see it — that's why we go through the
 * touchscreen API instead of `page.evaluate` here). The tap point
 * is anchored off-centre so the touch lands on the canvas rather
 * than on the top-left "?" affordance or the top-right Reset view
 * button, both of which sit inside the same testid wrapper.
 */
async function tapInsideCanvas(
  page: Page,
  canvas: Locator,
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("tapInsideCanvas: canvas has no bounding box");
  // Tap below-and-right of centre to comfortably miss both corner
  // affordances (top-left "?" and top-right Reset view button).
  await page.touchscreen.tap(
    box.x + box.width * 0.6,
    box.y + box.height * 0.7,
  );
}

test("BIM viewer gesture hint can be re-summoned and dismissed by touch on a tablet-shaped browser context", async ({
  page,
}) => {
  // Plant a `pr_session` cookie that promotes the browser to the
  // `internal` audience so the bim-model GET returns 200 instead
  // of 403. Same shape as the sibling specs.
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

  // Land on the BIM Model tab via the explicit tab button —
  // mirrors the production navigation a reviewer takes when they
  // open a submission and want to inspect its 3D model directly,
  // without going through the Findings cross-tab jump.
  await modal.getByTestId("submission-detail-modal-tab-bim-model").click();
  const bimTab = modal.getByTestId("bim-model-tab");
  await expect(bimTab).toBeVisible();
  await expect(modal.getByTestId("bim-model-tab-loading")).toHaveCount(0);

  const viewport = modal.getByTestId("bim-model-viewport");
  await expect(viewport).toBeVisible();
  // The viewer must be running its real WebGL pipeline — the
  // gesture legend is gated on `webGlOk`, so a regression in
  // `detectWebGl()` would silently null out everything we're
  // about to assert on.
  await expect(viewport).toHaveAttribute("data-webgl-available", "true");

  const canvas = modal.getByTestId("bim-model-viewport-canvas");
  await expect(canvas).toBeVisible();

  // ---- Step 1: initial legend is visible (no interaction yet) ----
  const legend = modal.getByTestId("bim-model-viewport-gesture-hint");
  await expect(legend).toBeVisible();
  // The "initial" data-hint-source distinguishes the never-dismissed
  // legend from the on-demand one a hover/focus/tap re-summons. A
  // regression that flipped the initial render into the dismissed
  // branch (e.g. seeded `hintDismissed=true`) would surface here.
  await expect(legend).toHaveAttribute("data-hint-source", "initial");
  // The "?" affordance must NOT be on screen yet — it only takes
  // the legend's place once the legend has been dismissed.
  await expect(
    modal.getByTestId("bim-model-viewport-gesture-hint-toggle"),
  ).toHaveCount(0);

  // ---- Step 2: pan the canvas to dismiss the legend ----
  await tapInsideCanvas(page, canvas);

  await expect(
    modal.getByTestId("bim-model-viewport-gesture-hint"),
  ).toHaveCount(0);
  const toggle = modal.getByTestId("bim-model-viewport-gesture-hint-toggle");
  await expect(toggle).toBeVisible();
  // The latched tap-open state is off — the canvas pan dismissed
  // the legend, it did not open it. `aria-pressed` is the read-side
  // contract for the sticky state.
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // ---- Step 3: tap the "?" — legend re-appears, sticky-open ----
  await toggle.tap();

  const reopened = modal.getByTestId("bim-model-viewport-gesture-hint");
  await expect(reopened).toBeVisible();
  // The on-demand reveal source distinguishes the tap-summoned
  // legend from the never-dismissed initial one — proves the
  // legend's render came through the `hintDismissed && (...)`
  // branch rather than reverting to the never-dismissed state.
  await expect(reopened).toHaveAttribute("data-hint-source", "revealed");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // ---- Step 4: tap the "?" again — legend collapses back ----
  await toggle.tap();

  await expect(
    modal.getByTestId("bim-model-viewport-gesture-hint"),
  ).toHaveCount(0);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // ---- Step 5: tap "?" once more, then pan the canvas ----
  // Re-summon the legend with another tap, then prove the canvas
  // dismiss path also clears the *tap-opened* sticky state (not
  // just the never-dismissed initial state). This is the half of
  // Task #408's contract that says "a canvas gesture is the
  // reviewer's signal they're done reading the legend".
  await toggle.tap();
  await expect(
    modal.getByTestId("bim-model-viewport-gesture-hint"),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await tapInsideCanvas(page, canvas);

  await expect(
    modal.getByTestId("bim-model-viewport-gesture-hint"),
  ).toHaveCount(0);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
