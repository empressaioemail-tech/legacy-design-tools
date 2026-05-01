/**
 * End-to-end regression test for the reviewer-facing Engagement
 * Context tab inside plan-review's submission detail modal (Wave 2
 * Sprint A / Task #319, e2e coverage tracked under Task #347).
 *
 * Why this test exists: Task #319 landed the Engagement Context tab
 * with a Vitest unit test that mocks `@workspace/api-client-react`'s
 * `useGetEngagement` and `useGetEngagementBriefing` hooks. That suite
 * proves the tab body renders correctly given known query results
 * but cannot catch wiring regressions across the seams the tab
 * actually crosses in production:
 *
 *   - the Radix Tabs activation that mounts the pane on click,
 *   - the Tanstack Query keys + customFetch URL builder used by
 *     `useGetEngagement` / `useGetEngagementBriefing`,
 *   - the BASE_PATH-relative `/api/...` resolution that has to land
 *     on the API server through the shared workspace proxy,
 *   - the `EngagementBriefingResponse` envelope unwrap (`.briefing
 *     .narrative`) the tab does on the live response.
 *
 * Mirrors the seeding strategy from `bim-model-tab.spec.ts` so the
 * test owns its data:
 *
 *   1. Insert a clean engagement with its full site-context column
 *      set (jurisdiction, address, project type, zoning code, lot
 *      area) directly via `@workspace/db`. `afterAll` deletes it
 *      and FK cascades clean up the briefing + submission rows.
 *
 *   2. Insert a `parcel_briefings` row directly with a known
 *      `sectionA` body + `generatedAt` provenance. We bypass the
 *      live `/briefing/generate` route on purpose — that path runs
 *      the briefing engine (LLM call), which would make the test
 *      slow, non-deterministic, and dependent on dev-environment
 *      LLM credentials. The Engagement Context tab only reads
 *      from `GET /api/engagements/:id/briefing`, which returns
 *      whatever is in the row, so a direct insert is the
 *      narrowest seed that exercises every read-side seam.
 *
 *   3. Create a submission against the engagement through the
 *      *real* `POST /api/engagements/:id/submissions` route so the
 *      `submission-row-<id>` button in `EngagementDetail.tsx` has
 *      a row to click.
 *
 *   4. Drive the UI through Playwright: open the engagement page
 *      on the Submissions tab, click the seeded row to open the
 *      detail modal, switch to the Engagement Context tab, and
 *      assert both the parcel-info card and the briefing-summary
 *      card render with the seeded values (real server round
 *      trip, not mocked).
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, parcelBriefings } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Engagement Context Tab ${RUN_TAG}`;
const TEST_NOTE = `e2e-engagement-context-tab ${RUN_TAG}`;
const TEST_ADDRESS = `742 Context Ln, Boulder, CO 80302`;
const TEST_JURISDICTION = "Boulder, CO";
const TEST_ZONING_CODE = "MU-3";
const TEST_LOT_AREA_SQFT = 7250;
const TEST_SECTION_A =
  `e2e-section-a-${RUN_TAG}: Three-story mixed-use infill with ` +
  `ground-floor retail, two stories of residential above, and a ` +
  `tight rear-yard setback driven by the floodway boundary.`;
const TEST_GENERATED_BY = "user:e2e-architect";

let engagementId = "";
let submissionId = "";

test.beforeAll(async ({ request }) => {
  // Seed an engagement with a fully-populated site-context column
  // set so the parcel-info card has a non-"—" value to render in
  // every row. `lotAreaSqft` is a numeric column — drizzle accepts
  // a string at insert time and emits the canonical numeric back
  // to the API server's `toNum` projector.
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: TEST_JURISDICTION,
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
      jurisdictionFips: "08013",
      address: TEST_ADDRESS,
      projectType: "new_build",
      zoningCode: TEST_ZONING_CODE,
      lotAreaSqft: String(TEST_LOT_AREA_SQFT),
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Insert the briefing row directly with a known section-A body +
  // generation provenance. The engagement-context tab only reads
  // `GET /api/engagements/:id/briefing` (which returns the row's
  // `sectionA` / `generatedAt` verbatim), so a direct insert is
  // sufficient to exercise the read-side seam end-to-end without
  // pulling in the briefing-engine / LLM dependency tree.
  await db.insert(parcelBriefings).values({
    engagementId,
    sectionA: TEST_SECTION_A,
    generatedAt: new Date("2026-04-01T10:00:00.000Z"),
    generatedBy: TEST_GENERATED_BY,
  });

  // Submission gives us a row to click in the Submissions tab so
  // the modal's open-flow is the same as the reviewer's.
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
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascades remove the parcel_briefings row + the submission
    // row chained off the engagement, so a single delete leaves the
    // dev DB exactly as we found it.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("renders the Engagement Context tab with live parcel info + briefing summary", async ({
  page,
}) => {
  // Relative path (no leading slash) so the URL constructor preserves
  // playwright.config.ts's `…/plan-review/` baseURL — an absolute
  // `/engagements/...` would land on the proxy root and miss the
  // plan-review base path.
  await page.goto(`engagements/${engagementId}?tab=submissions`);

  // Click the submission row to open the detail modal.
  const row = page.getByTestId(`submission-row-${submissionId}`);
  await expect(row).toBeVisible();
  await row.click();

  const modal = page.getByTestId("submission-detail-modal");
  await expect(modal).toBeVisible();

  // The modal opens on the BIM Model tab by default — switch to
  // Engagement Context. Playwright's locator click maps onto a
  // pointerdown event which is what Radix Tabs activates on, so
  // the pane mounts after this call.
  await modal
    .getByTestId("submission-detail-modal-tab-engagement-context")
    .click();
  const pane = modal.getByTestId(
    "submission-detail-modal-engagement-context-pane",
  );
  await expect(pane).toBeVisible();

  // The tab itself renders inside the pane — wait for it to leave
  // the loading state before we assert on card contents (the two
  // queries are fired on mount so the cards are guaranteed to land
  // in a single render once the engagement query resolves).
  const tab = pane.getByTestId("engagement-context-tab");
  await expect(tab).toBeVisible();
  await expect(
    pane.getByTestId("engagement-context-tab-loading"),
  ).toBeHidden();

  // Parcel-info card pulls every column from the engagement we
  // seeded. Each row asserts the *seeded* value (rather than just
  // "non-empty") so a regression in the engagement detail
  // projection (e.g. `buildSite` dropping `projectType`) would
  // surface as a mismatch instead of slipping through.
  const parcelCard = pane.getByTestId("engagement-context-parcel-card");
  await expect(parcelCard).toBeVisible();
  await expect(
    parcelCard.getByTestId("engagement-context-jurisdiction"),
  ).toHaveText(TEST_JURISDICTION);
  await expect(
    parcelCard.getByTestId("engagement-context-address"),
  ).toHaveText(TEST_ADDRESS);
  await expect(
    parcelCard.getByTestId("engagement-context-project-type"),
  ).toHaveText("New build");
  await expect(
    parcelCard.getByTestId("engagement-context-zoning-code"),
  ).toHaveText(TEST_ZONING_CODE);
  await expect(parcelCard.getByTestId("engagement-context-lot-area")).toHaveText(
    `${TEST_LOT_AREA_SQFT.toLocaleString("en-US")} sqft`,
  );

  // Briefing-summary card surfaces Section A verbatim + the
  // "Generated …" provenance line. Asserting on the full Section
  // A string proves the `EngagementBriefingResponse` envelope
  // unwrap (`.briefing.narrative.sectionA`) survived end-to-end —
  // a regression that returned the whole envelope as the body
  // would render `[object Object]` and fail this assertion.
  const briefingCard = pane.getByTestId("engagement-context-briefing-card");
  await expect(briefingCard).toBeVisible();
  await expect(
    briefingCard.getByTestId("engagement-context-briefing-section-a"),
  ).toHaveText(TEST_SECTION_A);
  await expect(
    briefingCard.getByTestId("engagement-context-briefing-generated-at"),
  ).toContainText("Generated ");
  // The empty-state hint must NOT render when a narrative is
  // present — the tab branches between the two on `sectionA`
  // truthiness, so this guards the branch from inverting.
  await expect(
    briefingCard.getByTestId("engagement-context-briefing-empty"),
  ).toHaveCount(0);

  // Switch back to the BIM Model tab and prove the Engagement
  // Context pane unmounts (Radix Tabs only renders the active
  // pane). A regression that left both panes mounted would
  // surface here as the parcel card still being visible.
  await modal
    .getByTestId("submission-detail-modal-tab-bim-model")
    .click();
  await expect(pane).toBeHidden();

  // And switch *back* to Engagement Context — the cards must
  // re-render with the same seeded values, proving Tanstack
  // Query's cache is keyed correctly per engagement (a cache-key
  // regression that mixed engagement ids would surface as either
  // a flash of the wrong content or an unexpected loading state).
  await modal
    .getByTestId("submission-detail-modal-tab-engagement-context")
    .click();
  await expect(
    pane.getByTestId("engagement-context-jurisdiction"),
  ).toHaveText(TEST_JURISDICTION);
  await expect(
    pane.getByTestId("engagement-context-briefing-section-a"),
  ).toHaveText(TEST_SECTION_A);
});
