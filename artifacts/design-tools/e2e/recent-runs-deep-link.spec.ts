/**
 * End-to-end regression test for the briefing recent-runs disclosure
 * URL deep link (Task #275, pinned by Task #290).
 *
 * Why this test exists: Task #275 added `?recentRunsOpen=1` and
 * `?recentRunsFilter=failed|invalid` to the engagement-detail URL so
 * an auditor who finds a suspicious failed-then-rerun pattern can
 * drop a Slack link that lands a teammate on the same already-open,
 * already-filtered view. The component-level unit test in
 * `BriefingRecentRunsPanel.test.tsx` confirms the React component
 * reads from and writes to the URL, but it does NOT pin the *full*
 * deep-link round trip the way `timeline-backfill-filter.spec.ts`
 * pins the `?reply=` chip — Playwright loads the URL, the
 * disclosure paints already-open + filtered on first paint, and the
 * filter chips rewrite the query string in place (no full
 * navigation). Without this browser-level pin, a router or proxy
 * regression that strips query params on the engagement route would
 * silently break the Slack-link share path.
 *
 * Strategy:
 *
 *   1. Insert a fresh engagement directly via `@workspace/db` so the
 *      test owns a known engagement id (mirrors the seeding pattern
 *      already used by `timeline-backfill-filter.spec.ts` and
 *      `briefing-citation-pills.spec.ts`).
 *   2. Insert two `briefing_generation_jobs` rows for that
 *      engagement — one `failed`, one `completed` with a non-zero
 *      `invalidCitationCount` — so each of the three filter buckets
 *      ("All", "Failed", "Has invalid citations") has a distinct,
 *      non-overlapping membership the test can assert against.
 *      We bypass the kickoff route here because the engine actually
 *      runs OpenAI on a real kickoff; seeding the table directly
 *      lets us pin the deep-link plumbing without dragging the
 *      generation pipeline into the test.
 *   3. Drive the UI through Playwright:
 *        - Visit
 *          `/engagements/<id>?tab=site-context&recentRunsOpen=1&recentRunsFilter=failed`
 *          and assert the Recent runs disclosure paints already
 *          open and pre-filtered to Failed on first paint (the
 *          failed row is visible, the completed row is filtered
 *          out, the Failed chip reads `aria-pressed="true"`).
 *        - Stamp a sentinel on `window` so a subsequent full
 *          navigation would blow it away; click the All chip and
 *          assert the URL's `recentRunsFilter` param is dropped
 *          (the `tab` and `recentRunsOpen` params survive), both
 *          rows render, AND the sentinel is still present on
 *          `window` — proves the chip swap was a `replaceState`
 *          rewrite, not a real navigation.
 *        - Click Failed again and assert the URL re-acquires
 *          `recentRunsFilter=failed` (and the sentinel still
 *          survives) — the round trip is fully bidirectional.
 *   4. `afterAll` deletes the seeded engagement; the
 *      `briefing_generation_jobs.engagement_id` FK is `ON DELETE
 *      CASCADE` (see `lib/db/src/schema/briefingGenerationJobs.ts`)
 *      so the seeded job rows disappear with the engagement.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  engagements,
  briefingGenerationJobs,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Recent Runs Deep Link ${RUN_TAG}`;

let engagementId = "";
let failedRunId = "";
let completedRunId = "";

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Boulder, CO",
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
      jurisdictionFips: "08013",
      address: "456 E2E Recent Runs Way, Boulder, CO 80301",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Two terminal rows in the retained-runs window: one failed, one
  // completed with a non-zero invalid-citation count. Distinct
  // start times so the route's `ORDER BY started_at DESC` returns
  // them in a deterministic order; spaced far enough apart that a
  // few seconds of clock skew between the test process and the API
  // can't reorder them.
  const failedStartedAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  const failedCompletedAt = new Date(failedStartedAt.getTime() + 5_000);
  const completedStartedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
  const completedCompletedAt = new Date(completedStartedAt.getTime() + 5_000);

  const [failedRow] = await db
    .insert(briefingGenerationJobs)
    .values({
      engagementId,
      state: "failed",
      startedAt: failedStartedAt,
      completedAt: failedCompletedAt,
      error: "OpenAI 503 — upstream unavailable (e2e fixture)",
      invalidCitationCount: null,
    })
    .returning({ id: briefingGenerationJobs.id });
  if (!failedRow) throw new Error("seed: failed run insert returned no row");
  failedRunId = failedRow.id;

  const [completedRow] = await db
    .insert(briefingGenerationJobs)
    .values({
      engagementId,
      state: "completed",
      startedAt: completedStartedAt,
      completedAt: completedCompletedAt,
      error: null,
      invalidCitationCount: 2,
    })
    .returning({ id: briefingGenerationJobs.id });
  if (!completedRow) {
    throw new Error("seed: completed run insert returned no row");
  }
  completedRunId = completedRow.id;
});

test.afterAll(async () => {
  if (engagementId) {
    // FK on briefing_generation_jobs(engagement_id) is ON DELETE
    // CASCADE, so the seeded job rows disappear with the engagement.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("?recentRunsOpen + ?recentRunsFilter deep link round-trips through the disclosure", async ({
  page,
}) => {
  // Deep-link straight into the open + Failed-filtered view. This
  // is the canary the test exists for: the panel must read both
  // params on initial mount (not just after a click), so pasting
  // this URL into a Slack thread lands the recipient on the same
  // already-open + already-filtered view.
  await page.goto(
    `/engagements/${engagementId}?tab=site-context&recentRunsOpen=1&recentRunsFilter=failed`,
  );

  const disclosure = page.getByTestId("briefing-recent-runs");
  await expect(disclosure).toBeVisible();

  // The disclosure body is mounted on first paint (no toggle click
  // required) — proves `recentRunsOpen=1` was honoured by the
  // component's lazy `useState` initializer.
  const body = page.getByTestId("briefing-recent-runs-body");
  await expect(body).toBeVisible();

  const allChip = page.getByTestId("briefing-recent-runs-filter-all");
  const failedChip = page.getByTestId("briefing-recent-runs-filter-failed");
  const invalidChip = page.getByTestId("briefing-recent-runs-filter-invalid");
  const failedRow = page.getByTestId(`briefing-run-${failedRunId}`);
  const completedRow = page.getByTestId(`briefing-run-${completedRunId}`);

  // The Failed chip is pre-selected (proves `recentRunsFilter=failed`
  // was honoured), the other two report the unselected state.
  await expect(failedChip).toHaveAttribute("aria-pressed", "true");
  await expect(allChip).toHaveAttribute("aria-pressed", "false");
  await expect(invalidChip).toHaveAttribute("aria-pressed", "false");
  // Only the failed row is visible — the completed-with-invalid row
  // is filtered out by the chip even though it lives in the same
  // retained window.
  await expect(failedRow).toBeVisible();
  await expect(completedRow).toHaveCount(0);

  // Stamp a sentinel on `window` so a subsequent full navigation
  // would blow it away. We reach for this rather than counting
  // `framenavigated` events because wouter's `replaceState`-based
  // updates do not always fire that event in Chromium, but a hard
  // navigation always destroys the window object and clears the
  // sentinel — checking for the sentinel after each click is the
  // most direct way to assert "no full navigation happened".
  await page.evaluate(() => {
    (window as unknown as { __recentRunsNavSentinel: string }).__recentRunsNavSentinel =
      "still-here";
  });

  // Click the All chip — the URL's `recentRunsFilter` param must be
  // dropped entirely (canonical URL stays bare when "all" is the
  // active filter), but `tab` and `recentRunsOpen` must survive so
  // the disclosure remains in the same shareable open state.
  await allChip.click();
  await expect(page).not.toHaveURL(/[?&]recentRunsFilter=/);
  await expect(page).toHaveURL(/[?&]tab=site-context(&|$)/);
  await expect(page).toHaveURL(/[?&]recentRunsOpen=1(&|$)/);
  await expect(allChip).toHaveAttribute("aria-pressed", "true");
  await expect(failedChip).toHaveAttribute("aria-pressed", "false");
  // Both rows render again now that the filter is cleared.
  await expect(failedRow).toBeVisible();
  await expect(completedRow).toBeVisible();
  // The sentinel must still be present on `window` — proves the
  // chip click was a `replaceState` query-string rewrite, not a
  // full page reload that would have torn the document down.
  const sentinelAfterAll = await page.evaluate(
    () =>
      (window as unknown as { __recentRunsNavSentinel?: string })
        .__recentRunsNavSentinel,
  );
  expect(sentinelAfterAll).toBe("still-here");

  // Click Failed again — the URL must re-acquire
  // `recentRunsFilter=failed`, and the sentinel must still be
  // present (the second click is the same in-place rewrite).
  await failedChip.click();
  await expect(page).toHaveURL(/[?&]recentRunsFilter=failed(&|$)/);
  await expect(page).toHaveURL(/[?&]tab=site-context(&|$)/);
  await expect(page).toHaveURL(/[?&]recentRunsOpen=1(&|$)/);
  await expect(failedChip).toHaveAttribute("aria-pressed", "true");
  await expect(failedRow).toBeVisible();
  await expect(completedRow).toHaveCount(0);
  const sentinelAfterFailed = await page.evaluate(
    () =>
      (window as unknown as { __recentRunsNavSentinel?: string })
        .__recentRunsNavSentinel,
  );
  expect(sentinelAfterFailed).toBe("still-here");
});
