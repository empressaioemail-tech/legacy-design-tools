/**
 * Track 1 Pass B — discipline-filter flow.
 *
 * NOTE: The Track 1 plan's "Findings tab defaults to their discipline,
 * with toggle" item was resolved-by-design during Pass B recon. The
 * Inbox chip-bar narrows submissions by classification.disciplines;
 * once a reviewer drills into a submission they review all findings
 * on it. Findings do not carry their own discipline atom field;
 * per-finding filtering is not in Track 1's surface area.
 *
 * This spec covers the Inbox-side flow only.
 *
 * Asserted flow:
 *   1. Reviewer is signed in with `users.disciplines = ['electrical']`.
 *      The session-route hydrates `Session.requestor.disciplines` from
 *      that column, and `useReviewerDisciplineFilter` seeds the
 *      chip-bar's selection from it on first paint.
 *   2. The Inbox chip-bar appears with `data-showing-all="false"` and
 *      the electrical chip selected (`data-selected="true"`,
 *      `data-mine="true"`); other chips render unselected.
 *   3. Of three seeded submissions (electrical-mechanical primary,
 *      plumbing-only, building-electrical-FLS mixed), only the two
 *      whose `classification.disciplines` overlap `electrical` show
 *      under the default narrowing. The plumbing-only row is hidden.
 *   4. Clicking "Show all" flips the chip-bar to
 *      `data-showing-all="true"` and the plumbing-only row appears.
 *   5. Clicking the primary row deep-links to
 *      `/engagements/{id}?submission={id}&tab=note` (the URL update is
 *      the load-bearing assertion; the post-click modal mount is
 *      covered by the existing reviewer-refresh-affordances spec).
 *
 * The Findings-tab discipline default is intentionally NOT asserted
 * here — see the closure note above.
 */

import { test, expect } from "@playwright/test";
import {
  promoteToInternalAudience,
  seedTrack1Scenario,
  type SeedTrack1Result,
} from "./fixtures/seedTrack1";

let seed: SeedTrack1Result;

test.beforeAll(async ({ request }) => {
  seed = await seedTrack1Scenario({
    scenario: "discipline-filter",
    request,
  });
});

test.afterAll(async () => {
  if (seed) await seed.cleanup();
});

test.describe("discipline-filter — Track 1 Pass B", () => {
  test("chip-bar narrows the Inbox to the reviewer's disciplines and 'Show all' restores the full feed", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context(), {
      requestorId: seed.reviewer.id,
    });
    await page.goto("/");

    // The chip-bar lives inside the queue card; await both the bar and
    // the queue to mount before reading data attributes.
    const chipBar = page.getByTestId("discipline-filter-chip-bar");
    await expect(chipBar).toBeVisible();
    await expect(chipBar).toHaveAttribute("data-showing-all", "false");

    // Seeded reviewer disciplines = ['electrical']. The chip-bar seeds
    // its selection from `Session.requestor.disciplines` on first
    // paint, so the electrical chip should be both `selected` and
    // `mine` while every other chip is unselected.
    const electricalChip = page.getByTestId("discipline-filter-chip-electrical");
    await expect(electricalChip).toHaveAttribute("data-selected", "true");
    await expect(electricalChip).toHaveAttribute("data-mine", "true");

    const plumbingChip = page.getByTestId("discipline-filter-chip-plumbing");
    await expect(plumbingChip).toHaveAttribute("data-selected", "false");

    // Pre-Show-all: primary (electrical-mechanical) and mixed
    // (building-electrical-fls) are visible — both intersect
    // 'electrical'. Plumbing-only is hidden.
    const primaryRow = page.getByTestId(
      `reviewer-queue-row-${seed.primary.submissionId}`,
    );
    const plumbingRow = page.getByTestId(
      `reviewer-queue-row-${seed.others[0]!.submissionId}`,
    );
    const mixedRow = page.getByTestId(
      `reviewer-queue-row-${seed.others[1]!.submissionId}`,
    );

    await expect(primaryRow).toBeVisible();
    await expect(mixedRow).toBeVisible();
    await expect(plumbingRow).toHaveCount(0);

    // "Show all" affordance reveals the plumbing-only row and flips the
    // chip-bar's `data-showing-all` attribute. Use the bar's bound
    // affordance (the empty-state's button only mounts when the
    // post-narrowing list is empty, which it isn't here).
    await page.getByTestId("discipline-filter-show-all").click();

    await expect(chipBar).toHaveAttribute("data-showing-all", "true");
    await expect(plumbingRow).toBeVisible();
    await expect(primaryRow).toBeVisible();
    await expect(mixedRow).toBeVisible();
  });

  test("clicking the primary Inbox row deep-links to the submission detail", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context(), {
      requestorId: seed.reviewer.id,
    });
    await page.goto("/");

    const primaryRow = page.getByTestId(
      `reviewer-queue-row-${seed.primary.submissionId}`,
    );
    await expect(primaryRow).toBeVisible();
    await primaryRow.click();

    // ReviewerQueueRow href is `/engagements/{id}?submission={id}&tab=note`.
    // The router updates the URL synchronously; assert the path landed
    // on the engagement and carries the deep-link query params.
    await expect(page).toHaveURL(
      new RegExp(
        `/engagements/${seed.primary.engagementId}\\?submission=${seed.primary.submissionId}&tab=note`,
      ),
    );
  });
});
