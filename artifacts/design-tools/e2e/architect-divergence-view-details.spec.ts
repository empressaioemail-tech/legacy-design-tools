/**
 * End-to-end regression test for the architect-side per-divergence
 * "View details" drill-in inside the design-tools EngagementDetail
 * Site Context tab (Task #346).
 *
 * Why this test exists: design-tools' architect surface adopted the
 * shared {@link BriefingDivergenceDetailDialog} from portal-ui (Task
 * #320) so the architect can inspect the recorded `before`/`after`
 * geometry diff for a divergence before resolving it without
 * leaving the engagement page. The component-level test in
 * `__tests__/BriefingDivergencesPanel.test.tsx` confirms the row's
 * "View details" button hands the row to the panel-owned dialog
 * state, but no test currently exercises the full browser round
 * trip from a real `geometry-edited` row in the dev DB → architect
 * audience GET → row click → dialog mount → close → in-place
 * Resolve. Without this pin, a regression that:
 *
 *   - dropped the `briefing-divergence-detail-dialog` testid,
 *   - removed the diff table when both `before` and `after` are
 *     present in the row's `detail` jsonb,
 *   - or wired Resolve through a full page reload instead of a
 *     React-Query cache invalidation,
 *
 * would slip through the unit suite undetected.
 *
 * Strategy:
 *
 *   1. Seed an engagement directly via `@workspace/db` so the test
 *      owns a known engagement id (mirrors the seeding pattern in
 *      `recent-runs-deep-link.spec.ts` and
 *      `briefing-citation-pills.spec.ts`). Compose the full read-
 *      side dependency chain the BriefingDivergencesPanel needs:
 *      `parcel_briefings → materializable_elements (locked
 *      buildable-envelope) → bim_models (with activeBriefingId) →
 *      briefing_divergences (reason: geometry-edited, detail:
 *      { before, after, revitElementId })`. Inserting through
 *      drizzle (rather than the `POST /api/bim-models/:id/divergence`
 *      route) lets the test stay independent of the
 *      `BIM_MODEL_SHARED_SECRET` connector contract.
 *
 *   2. Plant a `pr_session` cookie that promotes the browser to
 *      `internal` audience so the architect-gated
 *      `GET /api/bim-models/:id/divergences` endpoint returns 200
 *      instead of 403. The dev `sessionMiddleware` honors a
 *      JSON-encoded `audience` claim in this cookie; production is
 *      fail-closed and unaffected. Mirrors the cookie shape used
 *      by the plan-review BIM Model tab e2e and chat.test.ts's
 *      "session cookie carries audience" coverage.
 *
 *   3. Drive the UI through Playwright:
 *        a. Visit `/engagements/<id>?tab=site-context` and locate
 *           the seeded divergence row by its
 *           `data-divergence-id="<id>"` attribute.
 *        b. Click the row's "View details" button and assert the
 *           shared dialog mounts with the `geometry-edited` diff
 *           table populated (rows derived from the seeded
 *           `before`/`after` envelope).
 *        c. Close the dialog via its close button and confirm it
 *           unmounts cleanly (the panel-owned `activeDivergence`
 *           state resets to `null`).
 *        d. Stamp a sentinel on `window`, click Resolve, and
 *           assert (i) the open row count drops to 0 (the row
 *           moved into the collapsed Resolved section), and
 *           (ii) the sentinel is still present on `window` —
 *           proves the Resolve mutation invalidated the React
 *           Query cache without a full page reload.
 *
 *   4. `afterAll` deletes the seeded engagement so the dev DB stays
 *      pristine. FK cascades (`bim_models.engagement_id`,
 *      `briefing_divergences.bim_model_id`,
 *      `materializable_elements.briefing_id`,
 *      `parcel_briefings.engagement_id`) tear the rest of the
 *      chain down with it.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  engagements,
  parcelBriefings,
  materializableElements,
  bimModels,
  briefingDivergences,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Architect Divergence Drill-In ${RUN_TAG}`;

let engagementId = "";
let bimModelId = "";
let divergenceId = "";

test.beforeAll(async () => {
  // Engagement — outermost row everything else cascades from.
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: "456 Drill-In Ave, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Parcel briefing — the bim-model row needs an `activeBriefingId`
  // for the panel's `useGetEngagementBimModel` query to surface a
  // bim-model id (and the materializable element + divergence rows
  // both reference the briefing through their FK).
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  if (!briefing) throw new Error("seed: briefing insert returned no row");
  const briefingId = briefing.id;

  // Materializable element — the divergence row points at this via
  // its `materializableElementId` FK. A locked `buildable-envelope`
  // is the canonical case the C# Revit add-in records geometry
  // edits against in Spec 51a §2.4.
  const [element] = await db
    .insert(materializableElements)
    .values({
      briefingId,
      elementKind: "buildable-envelope",
      label: `e2e Buildable Envelope ${RUN_TAG}`,
      geometry: {
        polygon: [
          [0, 0, 0],
          [10, 0, 0],
          [10, 10, 0],
          [0, 10, 0],
        ],
      },
      locked: true,
    })
    .returning();
  if (!element) throw new Error("seed: materializable element insert returned no row");

  // Bim-model — keyed by engagementId, sets activeBriefingId so the
  // panel resolves a bim-model id and issues the divergences GET.
  const [model] = await db
    .insert(bimModels)
    .values({
      engagementId,
      activeBriefingId: briefingId,
      briefingVersion: 1,
      revitDocumentPath: `e2e:${RUN_TAG}.rvt`,
      materializedAt: new Date(),
    })
    .returning();
  if (!model) throw new Error("seed: bim-model insert returned no row");
  bimModelId = model.id;

  // Divergence — the row the test exists to drive. `geometry-edited`
  // with a `before`/`after` envelope is exactly the shape the
  // shared dialog's `extractDetailViews` peels apart into the
  // 3-column "Field / Briefing locked / Architect actual" diff
  // table. We include a couple of distinguishable fields so the
  // diff table renders multiple rows (defends against a regression
  // that collapsed the table to a single row).
  const [div] = await db
    .insert(briefingDivergences)
    .values({
      bimModelId,
      materializableElementId: element.id,
      briefingId,
      reason: "geometry-edited",
      note: `e2e architect drill-in ${RUN_TAG}`,
      detail: {
        revitElementId: 4242,
        before: { height: 30, footprintArea: 100 },
        after: { height: 35, footprintArea: 105 },
      },
    })
    .returning();
  if (!div) throw new Error("seed: divergence insert returned no row");
  divergenceId = div.id;
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascades chain through bim_models → briefing_divergences,
    // and parcel_briefings → materializable_elements → divergences,
    // so a single engagement delete clears the whole seed graph.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("View details opens the divergence dialog with a diff table; Resolve still works after closing without a page reload", async ({
  page,
}) => {
  // Promote the browser to `internal` audience so the architect-
  // gated `GET /api/bim-models/:id/divergences` endpoint succeeds.
  // The dev sessionMiddleware decodes a JSON-encoded `audience`
  // claim from this cookie; production is fail-closed.
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

  // Land directly on the Site Context tab — `readTabFromUrl` in
  // EngagementDetail.tsx allow-lists `site-context`.
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // The divergences panel renders the seeded `geometry-edited` row.
  // The row carries `data-divergence-id="<id>"` so we can scope
  // every subsequent locator to *this* row even if a future test
  // (or a previously-seeded leftover) added a sibling row to the
  // same bim-model.
  const row = page.locator(
    `[data-testid="briefing-divergences-row"][data-divergence-id="${divergenceId}"]`,
  );
  await expect(row).toBeVisible();
  // Sanity check: the row landed in the Open partition (resolved
  // attr is "false") — the Resolve assertion at the end is only
  // meaningful if it starts here.
  await expect(row).toHaveAttribute("data-divergence-resolved", "false");

  // Click "View details" on this specific row. Scoping by the
  // button's `data-divergence-id` keeps the locator stable if the
  // open list ever grows past one row.
  const viewDetailsButton = page.locator(
    `[data-testid="briefing-divergences-view-details-button"][data-divergence-id="${divergenceId}"]`,
  );
  await expect(viewDetailsButton).toBeVisible();
  await viewDetailsButton.click();

  // Dialog mounts. The shared portal-ui component carries the
  // `briefing-divergence-detail-dialog` testid on its backdrop
  // wrapper.
  const dialog = page.getByTestId("briefing-divergence-detail-dialog");
  await expect(dialog).toBeVisible();

  // The diff table renders because the seeded `detail` carries a
  // matching `before`/`after` object pair. We assert both the
  // table itself and at least the row count we seeded (two
  // distinguishable fields → two diff rows). Scoping inside the
  // dialog defends against a stray future panel that might also
  // surface diff cells.
  const diffTable = dialog.getByTestId("briefing-divergence-detail-diff-table");
  await expect(diffTable).toBeVisible();
  const diffRows = dialog.getByTestId("briefing-divergence-detail-diff-row");
  await expect(diffRows).toHaveCount(2);

  // Close the dialog via its dedicated close button (rather than
  // the backdrop click-out) — proves the explicit close affordance
  // is wired to the panel's `setActiveDivergence(null)` reset.
  await dialog.getByTestId("briefing-divergence-detail-close").click();
  await expect(dialog).toHaveCount(0);

  // Stamp a sentinel on `window` so a subsequent full navigation
  // would blow it away. Used by `recent-runs-deep-link.spec.ts` for
  // the same purpose: a hard reload destroys the document and
  // wipes the sentinel, while a React-Query cache invalidation
  // leaves it intact.
  await page.evaluate(() => {
    (window as unknown as { __divergenceNavSentinel: string })
      .__divergenceNavSentinel = "still-here";
  });

  // Resolve the divergence. The architect-side mutation invalidates
  // the divergences list query, so the row physically moves out of
  // the Open section into the (collapsed-by-default) Resolved
  // section — the Open row for this divergenceId disappears.
  const resolveButton = page.locator(
    `[data-testid="briefing-divergences-row"][data-divergence-id="${divergenceId}"] [data-testid="briefing-divergences-resolve-button"]`,
  );
  await expect(resolveButton).toBeVisible();
  await resolveButton.click();

  // The Open row for this divergence is gone (the panel's open
  // partition filters out resolved rows, and the resolved section
  // starts collapsed so the row is not re-rendered into the open
  // list). The Resolved section's toggle now reflects the new
  // resolved-row count, which proves the row moved rather than
  // simply disappeared.
  await expect(row).toHaveCount(0);
  const resolvedToggle = page.getByTestId(
    "briefing-divergences-resolved-toggle",
  );
  await expect(resolvedToggle).toContainText("Resolved (1)");

  // Sentinel still present on `window` — proves the Resolve flow
  // was a React-Query cache invalidation, not a full page reload
  // that would have torn the document down and cleared
  // `window.__divergenceNavSentinel`.
  const sentinelAfterResolve = await page.evaluate(
    () =>
      (window as unknown as { __divergenceNavSentinel?: string })
        .__divergenceNavSentinel,
  );
  expect(sentinelAfterResolve).toBe("still-here");
});
