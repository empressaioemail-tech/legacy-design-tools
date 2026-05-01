/**
 * End-to-end regression test for the engagement detail page's
 * snapshot timeline + KPI strip — the Snapshots tab on
 * `EngagementDetail.tsx` that lists every snapshot ingested for the
 * engagement and surfaces the selected snapshot's counts in the
 * SHEETS / ROOMS / LEVELS / WALLS tile row.
 *
 * Why this test exists (Task #135): the page composes a few moving
 * parts (the engagement detail query, the snapshots-by-engagement
 * subquery rolled into that response, the per-snapshot detail query
 * that powers the KPI strip, and the Zustand-backed auto-selection
 * of the most recent row) and a regression in any one would silently
 * blank out the post-ingest user experience. This spec pins:
 *
 *   - the snapshot row is rendered into `engagement-snapshot-timeline`
 *     and is auto-selected on first load (`data-selected="true"`),
 *   - each KPI tile renders the count from the seeded snapshot
 *     payload (not the placeholder `—`),
 *   - clicking a second seeded row flips the selection and re-drives
 *     the KPI strip from the newly-fetched snapshot detail.
 *
 * Strategy:
 *
 *   1. Insert a fresh engagement and *two* snapshots directly via
 *      `@workspace/db`. Two snapshots — at distinct `receivedAt`
 *      times and with distinct counts — let us prove both the
 *      auto-select-most-recent behavior *and* the click-to-switch
 *      behavior in one spec.
 *   2. Drive the UI through Playwright: navigate to the engagement
 *      with `?tab=snapshots`, assert the auto-selected row's counts
 *      land in the KPI strip, click the older row, and assert the
 *      strip re-renders with the older snapshot's counts.
 *   3. `afterAll` deletes the seeded engagement; the FK cascade on
 *      `snapshots` removes both snapshot rows alongside it (see
 *      `lib/db/src/schema/snapshots.ts`).
 *
 * We use direct DB inserts (rather than POST /api/snapshots) on
 * purpose: the snapshot ingest endpoint requires an x-snapshot-secret
 * header that's environment-scoped and outside this spec's
 * responsibility — the assertions here are about the *page render
 * after a snapshot exists*, not about the ingest path itself, which
 * is covered by the api-server's own tests.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, snapshots } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Snapshot Timeline ${RUN_TAG}`;

// Two distinct count profiles so the "which snapshot is selected"
// assertion is unambiguous — every tile differs across rows.
const NEWER_COUNTS = {
  sheetCount: 42,
  roomCount: 13,
  levelCount: 5,
  wallCount: 287,
};
const OLDER_COUNTS = {
  sheetCount: 19,
  roomCount: 7,
  levelCount: 3,
  wallCount: 154,
};

let engagementId = "";
let newerSnapshotId = "";
let olderSnapshotId = "";

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
      // Address is set so the page does NOT auto-open the intake
      // modal on first load and steal focus from the snapshot list.
      address: "789 E2E Snapshot St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Insert the older row first with a backdated `receivedAt` so the
  // newer row truly has the larger timestamp regardless of insert
  // ordering or clock granularity. The page sorts snapshots
  // newest-first and auto-selects the first row.
  const olderReceivedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  const newerReceivedAt = new Date();

  const [older] = await db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: TEST_PROJECT_NAME,
      payload: { __seed: "older", ...OLDER_COUNTS },
      receivedAt: olderReceivedAt,
      ...OLDER_COUNTS,
    })
    .returning();
  if (!older) throw new Error("seed: older snapshot insert returned no row");
  olderSnapshotId = older.id;

  const [newer] = await db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: TEST_PROJECT_NAME,
      payload: { __seed: "newer", ...NEWER_COUNTS },
      receivedAt: newerReceivedAt,
      ...NEWER_COUNTS,
    })
    .returning();
  if (!newer) throw new Error("seed: newer snapshot insert returned no row");
  newerSnapshotId = newer.id;
});

test.afterAll(async () => {
  if (engagementId) {
    // Cascades to both seeded snapshot rows.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("renders the snapshot timeline + KPI strip after snapshots are ingested", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=snapshots`);

  // The timeline list wrapper is rendered by the Snapshots tab; the
  // two seeded rows show up inside it.
  const timeline = page.getByTestId("engagement-snapshot-timeline");
  await expect(timeline).toBeVisible();

  const newerRow = page.getByTestId(`snapshot-row-${newerSnapshotId}`);
  const olderRow = page.getByTestId(`snapshot-row-${olderSnapshotId}`);
  await expect(newerRow).toBeVisible();
  await expect(olderRow).toBeVisible();

  // Auto-select-most-recent behavior: with no prior selection in the
  // Zustand store for this engagement, the first (newest) row should
  // be the selected one on initial render.
  await expect(newerRow).toHaveAttribute("data-selected", "true");
  await expect(olderRow).toHaveAttribute("data-selected", "false");

  // KPI strip values land from the per-snapshot detail query keyed
  // by the auto-selected row id. Each tile's `*-value` testid carries
  // the visible count (not the placeholder dash).
  await expect(page.getByTestId("engagement-kpi-sheets-value")).toHaveText(
    String(NEWER_COUNTS.sheetCount),
  );
  await expect(page.getByTestId("engagement-kpi-rooms-value")).toHaveText(
    String(NEWER_COUNTS.roomCount),
  );
  await expect(page.getByTestId("engagement-kpi-levels-value")).toHaveText(
    String(NEWER_COUNTS.levelCount),
  );
  await expect(page.getByTestId("engagement-kpi-walls-value")).toHaveText(
    String(NEWER_COUNTS.wallCount),
  );

  // Click the older row to flip the selection. The KPI strip must
  // re-render against the newly-fetched snapshot detail; if a future
  // refactor breaks the selection wiring (e.g. forgets to invalidate
  // / refetch on click) the strip would stay pinned to the previous
  // counts and this assertion catches it.
  await olderRow.click();
  await expect(olderRow).toHaveAttribute("data-selected", "true");
  await expect(newerRow).toHaveAttribute("data-selected", "false");

  await expect(page.getByTestId("engagement-kpi-sheets-value")).toHaveText(
    String(OLDER_COUNTS.sheetCount),
  );
  await expect(page.getByTestId("engagement-kpi-rooms-value")).toHaveText(
    String(OLDER_COUNTS.roomCount),
  );
  await expect(page.getByTestId("engagement-kpi-levels-value")).toHaveText(
    String(OLDER_COUNTS.levelCount),
  );
  await expect(page.getByTestId("engagement-kpi-walls-value")).toHaveText(
    String(OLDER_COUNTS.wallCount),
  );
});
