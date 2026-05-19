/**
 * End-to-end regression test for the cross-tab "Show in 3D viewer"
 * jump from a real Findings drill-in into the BIM Model tab inside
 * plan-review's submission detail modal (Wave 2 / Task #343, e2e
 * coverage tracked under Task #372).
 *
 * Why this test exists: Task #343 landed the cross-tab jump with
 * three layers of Vitest coverage that mock seams the real wiring
 * crosses end-to-end:
 *
 *   - `FindingsTab.test.tsx` proves the drill-in fires
 *     `onShowInViewer(elementRef)` against a stub host.
 *   - `BimModelTab.test.tsx` proves the materializable-elements
 *     list highlights, scrolls to, and announces the matched row
 *     given a `highlightElementRef` prop.
 *   - `SubmissionDetailModal.test.tsx` proves the modal forwards
 *     the `elementRef` between mocked tab children and switches
 *     to the BIM Model tab in both controlled + uncontrolled mode.
 *
 * Each of those is fast and focused, but none of them exercise the
 * combined production path: the real Findings fixture, the live
 * `/api/engagements/:id/bim-model` GET, the EngagementDetail
 * controlled-tab + URL-sync wiring, and the real DOM
 * `scrollIntoView` + auto-clear `setTimeout` lifecycle. A regression
 * in any one of those (e.g. a refactor that drops the modal's
 * `handleShowInViewer` plumbing, or a tab-controlled-state
 * regression in EngagementDetail that swallows the tab switch)
 * would slip past the component-level mocks but be caught here.
 *
 * Strategy mirrors `bim-model-tab.spec.ts`:
 *
 *   1. Insert a clean engagement directly via `@workspace/db` so the
 *      test owns a known id and `afterAll`'s cascade-delete leaves
 *      the dev DB pristine.
 *
 *   2. Insert a `parcel_briefings` row directly so the bim-model
 *      push has an `activeBriefingId` to point at, and so we can
 *      attach a hand-seeded `materializable_elements` row whose
 *      `label` exactly matches the seeded finding's `elementRef`
 *      (`wall:north-side-l2`). The `MaterializableElementsList`
 *      resolver picks that label up via its `exactLabel` matcher,
 *      which is the most explicit and stable of the four matchers
 *      it tries.
 *
 *   3. Create a submission via the real
 *      `POST /api/engagements/:id/submissions` route so the
 *      submission row in the engagement page is a real one.
 *
 *   4. Push to bim-model via the real
 *      `POST /api/engagements/:id/bim-model` route so the BIM Model
 *      tab is in its non-empty branch and the elements list mounts
 *      with our seeded row.
 *
 *   5. Drive the UI through Playwright: open the engagement page on
 *      the Submissions tab, click the seeded row to open the
 *      detail modal, switch to the Findings tab, click the seeded
 *      blocker finding row to open its drill-in, click "Show in 3D
 *      viewer", and assert that:
 *        - the BIM Model tab is now active,
 *        - the row whose `data-element-id` matches our seeded
 *          element has `data-highlighted="true"`,
 *        - the screen-reader announcer
 *          (`bim-model-elements-announcer`) carries the element
 *          label so AT users hear what the sighted user is
 *          seeing scroll into view.
 *
 *   6. `afterAll` deletes the seeded engagement; FK cascades on
 *      `parcel_briefings.engagement_id` and
 *      `materializable_elements.briefing_id` clean up the
 *      seeded element + briefing rows along with the submission.
 *
 * The Findings module talks to the real api-server. Rather than
 * driving "Generate findings" (which kicks off the async finding
 * engine and would produce non-deterministic output), the seed pass
 * POSTs a single manual finding via
 * `POST /api/submissions/:id/findings` with the exact `elementRef`
 * we want to jump to. That gives us a single, predictable row to
 * click without coupling the cross-tab-jump assertion to the
 * engine's output.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  engagements,
  materializableElements,
  parcelBriefings,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Findings BIM Jump ${RUN_TAG}`;
const TEST_NOTE = `e2e-findings-bim-jump ${RUN_TAG}`;

/**
 * The label we seed on a materializable_elements row AND the
 * `elementRef` we POST onto a manual finding. The
 * `MaterializableElementsList`'s `exactLabel` matcher resolves the
 * finding's ref to this exact row — no fuzzy matching, no chance of
 * the test passing for the wrong reason.
 */
const FINDING_ELEMENT_REF = "wall:north-side-l2";

let engagementId = "";
let submissionId = "";
let seededElementId = "";

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
      address: "456 Findings Test St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Bim-model push needs an active briefing to point its
  // `activeBriefingId` at. The narrative columns are optional, so an
  // empty shell is enough — we keep the row deliberately minimal so
  // the test isn't coupled to briefing-engine output. The briefing's
  // `id` is what `materializable_elements.briefing_id` references,
  // and what the bim-model GET joins on to surface elements.
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  if (!briefing) throw new Error("seed: parcel_briefings insert returned no row");

  // Hand-seed the materializable element the cross-tab jump must
  // resolve to. The `label` matches the AI blocker fixture's
  // `elementRef` exactly so the `exactLabel` resolver hits before
  // the looser trailing-segment fallback even comes into play —
  // making this assertion the strictest read-side proof that the
  // finding -> element wiring round-tripped.
  const [el] = await db
    .insert(materializableElements)
    .values({
      briefingId: briefing.id,
      elementKind: "setback-plane",
      label: FINDING_ELEMENT_REF,
      geometry: {},
      locked: false,
    })
    .returning();
  if (!el) throw new Error("seed: materializable_elements insert returned no row");
  seededElementId = el.id;

  // Submission gives us a row to click in the Submissions tab so
  // the modal-open path mirrors what the reviewer does in production.
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
  // element rendered in the materializable-elements list. Mirrors
  // the dev-only `x-audience: internal` header workaround the
  // sibling spec uses (Playwright's APIRequestContext does not
  // inherit the browser's session, so the architect-audience guard
  // would otherwise reject this).
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

  // Seed a single manual finding via the reviewer create endpoint so
  // the Findings tab has exactly one row whose `elementRef` lines up
  // with the seeded materializable_element. The route's audience
  // guard requires `internal` — same `x-audience` header workaround
  // as the bim-model push.
  const createFindingResp = await request.post(
    `/api/submissions/${submissionId}/findings`,
    {
      data: {
        title: "Setback violation (e2e seed)",
        description: "Cross-tab jump seed — anchored to the seeded element.",
        severity: "blocker",
        category: "setback",
        elementRef: FINDING_ELEMENT_REF,
      },
      headers: {
        "content-type": "application/json",
        "x-audience": "internal",
      },
    },
  );
  if (createFindingResp.status() !== 201) {
    throw new Error(
      `seed: POST /api/submissions/${submissionId}/findings returned ` +
        `${createFindingResp.status()}: ${await createFindingResp.text()}`,
    );
  }
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascades remove the parcel_briefings row + the
    // materializable_elements row chained off it + the submission
    // row + the bim_models row, so a single delete leaves the dev
    // DB exactly as we found it.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("clicking 'Show in 3D viewer' on a Findings drill-in jumps to the BIM Model tab and highlights the matching element", async ({
  page,
}) => {
  // Plant a `pr_session` cookie that promotes the browser to the
  // `internal` audience so the bim-model GET returns 200 instead of
  // 403. Mirrors the cookie shape used in the sibling spec.
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

  // Relative path (no leading slash) so the URL constructor preserves
  // playwright.config.ts's `…/plan-review/` baseURL.
  await page.goto(`engagements/${engagementId}?tab=submissions`);

  // Open the modal by clicking the seeded submission row — the
  // production entry point.
  const row = page.getByTestId(`submission-row-${submissionId}`);
  await expect(row).toBeVisible();
  await row.click();

  const modal = page.getByTestId("submission-detail-modal");
  await expect(modal).toBeVisible();

  // Switch to the Findings tab. EngagementDetail mounts the modal
  // in *controlled* mode (parent-driven `tab` prop, URL-synced via
  // `writeSubmissionTabToUrl`), so this click also has to round-trip
  // through `handleTabChange` and re-render with `tab="findings"`
  // before the FindingsTab body mounts.
  await modal.getByTestId("submission-tab-findings").click();
  const findingsTab = modal.getByTestId("findings-tab");
  await expect(findingsTab).toBeVisible();

  // The Findings module talks to the real api-server. The seed pass
  // POSTed a single manual finding tagged with our `elementRef`, so
  // the empty-state should NOT be visible — instead, the row is
  // already rendered under the blocker severity group.
  await expect(modal.getByTestId("findings-empty-state")).toHaveCount(0);

  // Pick the seeded blocker row. Severity grouping puts blockers in
  // their own testid'd container, so picking the first row inside
  // that container is the most stable selector — finding atom ids
  // are ULID-based and not predictable from the test side.
  const blockerGroup = modal.getByTestId("findings-group-blocker");
  await expect(blockerGroup).toBeVisible();
  const blockerRow = blockerGroup
    .locator('[data-testid^="finding-row-finding:"]')
    .first();
  await expect(blockerRow).toBeVisible();
  await blockerRow.click();

  // Drill-in opens with the "Show in 3D viewer" button enabled
  // (the finding has an `elementRef` AND the modal wires up
  // `onShowInViewer`). The aria-label captures the elementRef
  // verbatim so we can assert the right finding's ref is what's
  // about to be jumped to.
  const viewerJump = modal.getByTestId("finding-drill-in-viewer-jump");
  await expect(viewerJump).toBeEnabled();
  await expect(viewerJump).toHaveAttribute("data-viewer-attached", "true");
  await expect(viewerJump).toHaveAttribute(
    "aria-label",
    `Show ${FINDING_ELEMENT_REF} in the BIM Model tab`,
  );
  await viewerJump.click();

  // Tab switch happens synchronously in the modal's
  // `handleShowInViewer`, so the BIM Model tab content mounts on
  // the next render. We wait for the tab body before asserting on
  // the elements list so we don't race the bim-model query.
  const bimModelTab = modal.getByTestId("bim-model-tab");
  await expect(bimModelTab).toBeVisible();
  await expect(modal.getByTestId("bim-model-tab-loading")).toHaveCount(0);

  // The seeded element renders as a row keyed by its server-side
  // UUID. The cross-tab jump must mark exactly that row as
  // highlighted — anything else (no row, the wrong row, or no
  // highlight at all) is a regression in either the modal's
  // `highlightedElementRef` thread or the BimModelTab's resolver.
  const highlightedRow = bimModelTab.locator(
    `[data-testid="bim-model-elements-row"][data-element-id="${seededElementId}"]`,
  );
  await expect(highlightedRow).toHaveAttribute("data-highlighted", "true");

  // No-match warning must NOT render — its presence would mean the
  // resolver fell through every matcher (an `elementRef` -> label
  // wiring regression).
  await expect(
    bimModelTab.getByTestId("bim-model-elements-no-match"),
  ).toHaveCount(0);

  // Sibling rows (any other elements the dev DB happens to render
  // for this briefing) must not be highlighted — guards against a
  // bug that paints every row with `data-highlighted="true"`. The
  // selector intentionally combines both attributes in a single CSS
  // expression so we match peer rows, not descendants of the
  // highlighted row (a chained `.locator(':not(...)')` would
  // descend into the row's child spans, which carry no
  // `data-element-id` and so spuriously satisfy the negation).
  const otherRows = bimModelTab.locator(
    `[data-testid="bim-model-elements-row"]:not([data-element-id="${seededElementId}"])`,
  );
  const otherCount = await otherRows.count();
  for (let i = 0; i < otherCount; i++) {
    await expect(otherRows.nth(i)).toHaveAttribute(
      "data-highlighted",
      "false",
    );
  }

  // Screen-reader announcer carries the resolved element label so
  // AT users hear which element the sighted user is now looking at
  // in the BIM viewer. We seeded `label = FINDING_ELEMENT_REF`, so
  // the announcement reads "Showing wall:north-side-l2 in the BIM
  // model viewer." Asserting on the label substring (rather than
  // the full sentence) keeps the test resilient to the surrounding
  // copy being tweaked.
  const announcer = bimModelTab.getByTestId("bim-model-elements-announcer");
  await expect(announcer).toContainText(FINDING_ELEMENT_REF);
  await expect(announcer).toHaveAttribute("aria-live", "polite");
  await expect(announcer).toHaveAttribute("role", "status");
});
