/**
 * End-to-end regression test for the reviewer-facing BIM Model tab
 * inside plan-review's submission detail modal (Wave 2 Sprint B /
 * Task #306).
 *
 * Why this test exists: the BIM Model tab is composed from several
 * seams — the click-to-open SubmissionRow in
 * `EngagementDetail.tsx`, the Radix Dialog + Tabs shell in
 * `SubmissionDetailModal.tsx`, the BIM Model summary card +
 * grouped materializable-element list + portal-ui divergences
 * panel in `BimModelTab.tsx`, and the `/api/engagements/:id/bim-model`
 * GET that backs all of them. Each of those has a fast component test,
 * but no test currently exercises the full round-trip from a submission
 * row click to the BIM Model tab rendering live API data.
 *
 * Strategy:
 *
 *   1. Insert a clean engagement directly via `@workspace/db` so the
 *      test owns a known id and doesn't depend on whatever rows
 *      happen to live in the dev DB. The engagement is deleted in
 *      `afterAll` (FK cascades remove the bim-model + submission rows).
 *
 *   2. Create a submission against that engagement through the *real*
 *      `POST /api/engagements/:id/submissions` route so the
 *      `submission-row-<id>` button targeting in
 *      `EngagementDetail.tsx` has a row to click.
 *
 *   3. Push to bim-model through the *real*
 *      `POST /api/engagements/:id/bim-model` route so a bim-model row
 *      exists and the BIM Model tab is in its non-empty branch
 *      (summary card + materializable-element list visible).
 *
 *   4. Drive the UI through Playwright: open the engagement page on
 *      the Submissions tab, click the seeded row to open the
 *      detail modal, click the BIM Model tab, and assert the
 *      summary card + element list render. Switch back to the
 *      Engagement Context placeholder tab to prove the Tabs shell
 *      preserves both the panes (Sprint A's Engagement Context tab
 *      will land alongside this one).
 *
 *   5. `afterAll` deletes the seeded engagement so we leave the dev
 *      DB exactly as we found it.
 *
 * The bim-model push contract requires an active briefing on the
 * engagement to mint materializable elements. We don't gate the
 * assertions on element rows existing — the briefing engine may or
 * may not have produced any in the dev DB during the push — but we
 * always assert the BIM model summary card surfaces, which proves
 * the full plumbing is wired end-to-end.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, parcelBriefings } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e BIM Model Tab ${RUN_TAG}`;
const TEST_NOTE = `e2e-bim-model-tab ${RUN_TAG}`;

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
      address: "123 BIM Test St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Bim-model push requires the engagement to have a parcel briefing
  // (it becomes the bim-model's `activeBriefingId`). The bim-model
  // route looks up the engagement's briefing row by engagementId; the
  // briefing's narrative columns are optional, so an empty shell is
  // enough to satisfy the route. The row cascades on engagement
  // delete, so afterAll's cleanup still leaves the DB pristine.
  await db
    .insert(parcelBriefings)
    .values({ engagementId })
    .onConflictDoNothing();

  // Submission gives us a row to click in the Submissions tab.
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

  // Push to bim-model so the BIM Model tab is in its non-empty branch.
  // The route is gated by the architect-audience guard (which also
  // accepts plan-review reviewers — both surfaces are `internal`
  // audience). Playwright's APIRequestContext does not inherit the
  // browser's session, so we send the dev-only `x-audience: internal`
  // header that `sessionMiddleware` honors in development. The
  // browser-side GET that the BIM Model tab makes still picks up the
  // internal audience naturally via the dev preview.
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
    // FK cascades remove submissions, bim_models, and any
    // materializable_elements / briefing_divergences chained off it.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("opens the submission detail modal and renders the BIM Model tab end-to-end", async ({
  page,
}) => {
  // Plant a `pr_session` cookie that promotes the browser to the
  // `internal` audience so the bim-model GET endpoint (gated by the
  // architect-audience guard, which also accepts plan-review reviewers
  // — both are `internal`) returns 200 instead of 403. The dev
  // sessionMiddleware honors a JSON-encoded `audience` claim in this
  // cookie; production is fail-closed and will not be affected. Mirrors
  // the cookie shape exercised in `chat.test.ts`'s "session cookie
  // carries audience" coverage.
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
  // playwright.config.ts's `…/plan-review/` baseURL — an absolute
  // `/engagements/...` would land on the proxy root and miss the
  // plan-review base path.
  await page.goto(`engagements/${engagementId}?tab=submissions`);

  // Click the submission row to open the detail modal — this is the
  // entry-point Sprint B added (Task #306).
  const row = page.getByTestId(`submission-row-${submissionId}`);
  await expect(row).toBeVisible();
  await row.click();

  const modal = page.getByTestId("submission-detail-modal");
  await expect(modal).toBeVisible();

  // The modal opens on the BIM Model tab by default — assert the
  // tab content is visible without an extra click.
  const bimTab = modal.getByTestId("bim-model-tab");
  await expect(bimTab).toBeVisible();

  // Summary card always renders when a bim-model exists. This is
  // the single most important read-side proof that the
  // `/api/engagements/:id/bim-model` GET round-tripped through the
  // reviewer-flavored internal-audience guard.
  await expect(modal.getByTestId("bim-model-summary-card")).toBeVisible();
  await expect(
    modal.getByTestId("bim-model-summary-refresh-status"),
  ).toBeVisible();

  // Materializable-elements list renders even when the briefing has
  // not produced any elements yet (it falls through to the empty
  // hint), so we just assert the list shell is present rather than
  // gating on row counts that depend on dev-DB briefing state.
  await expect(modal.getByTestId("bim-model-elements-list")).toBeVisible();

  // The Engagement Context tab is a placeholder pane today (Sprint A
  // will fill it). Switching to it proves the Tabs shell preserves
  // both panes — a regression that collapses the modal to a single
  // tab would surface here.
  await modal.getByTestId("submission-detail-modal-tab-engagement-context").click();
  await expect(
    modal.getByTestId("submission-detail-modal-engagement-context-pane"),
  ).toBeVisible();

  // Switch back to BIM Model and confirm the tab content remounts.
  await modal.getByTestId("submission-detail-modal-tab-bim-model").click();
  await expect(modal.getByTestId("bim-model-summary-card")).toBeVisible();

  // Close the modal via the Escape key (Radix Dialog's keyboard
  // close affordance) and prove the parent's selection-state reset
  // by re-opening the same row — the row must stay a re-entrant
  // trigger.
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  await row.click();
  await expect(page.getByTestId("submission-detail-modal")).toBeVisible();
  await expect(
    page.getByTestId("submission-detail-modal").getByTestId(
      "bim-model-summary-card",
    ),
  ).toBeVisible();
});
