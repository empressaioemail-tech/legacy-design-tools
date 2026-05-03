/**
 * Track 1 Pass B — triage-strip rendering on the Inbox.
 *
 * Pins the per-row triage chip group on the reviewer Inbox queue
 * (artifacts/plan-review/src/components/ReviewerQueueTriageStrip.tsx).
 * Four assertion blocks:
 *
 *   1. Project-type chip carries the seeded `projectType` text.
 *   2. One discipline chip per `classification.disciplines` value.
 *   3. Severity-rollup pill carries the right counts on its
 *      `data-rollup-{total,blockers,concerns,advisory}` attributes
 *      (the test seeds 2 blocker + 5 concern + 4 advisory = 11 total).
 *   4. Applicant-history pill renders `data-total-prior="3"` (matching
 *      the 3 seeded prior submissions for the same applicantFirm) and
 *      its hovercard expands to reveal a list of those priors with
 *      verdict labels. The list size honors the
 *      APPLICANT_HISTORY_MAX_PRIOR=5 cap (3 seeded ≤ cap, so 3 rows).
 */

import { test, expect } from "@playwright/test";
import {
  promoteToInternalAudience,
  seedTrack1Scenario,
  type SeedTrack1Result,
} from "./fixtures/seedTrack1";

let seed: SeedTrack1Result;

test.beforeAll(async ({ request }) => {
  seed = await seedTrack1Scenario({ scenario: "triage-strip", request });
});

test.afterAll(async () => {
  if (seed) await seed.cleanup();
});

test.describe("triage-strip — Track 1 Pass B", () => {
  test("Inbox row renders classification chips + severity rollup + applicant-history pill with hovercard expansion", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context(), {
      requestorId: seed.reviewer.id,
    });
    await page.goto("/");

    const row = page.getByTestId(
      `reviewer-queue-row-${seed.primary.submissionId}`,
    );
    await expect(row).toBeVisible();

    const triagePrefix = `reviewer-queue-row-${seed.primary.submissionId}-triage`;

    // (1) Project-type chip carries the seeded text verbatim.
    const projectTypeChip = page.getByTestId(`${triagePrefix}-project-type`);
    await expect(projectTypeChip).toBeVisible();
    await expect(projectTypeChip).toHaveText(
      seed.primary.classification.projectType,
    );

    // (2) One ReviewerDisciplineBadge per discipline. Seeded set is
    // ['building', 'electrical', 'fire-life-safety']; assert each
    // chip is present.
    for (const d of seed.primary.classification.disciplines) {
      await expect(
        page.getByTestId(`${triagePrefix}-discipline-${d}`),
      ).toBeVisible();
    }

    // (3) Severity rollup. Seeder inserted 2 blocker + 5 concern + 4
    // advisory = 11 total. The rollup pill carries each count on a
    // `data-rollup-*` attribute and renders the human-readable label.
    const severityPill = page.getByTestId(`${triagePrefix}-severity`);
    await expect(severityPill).toBeVisible();
    await expect(severityPill).toHaveAttribute("data-rollup-total", "11");
    await expect(severityPill).toHaveAttribute("data-rollup-blockers", "2");
    await expect(severityPill).toHaveAttribute("data-rollup-concerns", "5");
    await expect(severityPill).toHaveAttribute("data-rollup-advisory", "4");
    await expect(severityPill).toHaveText(
      /^11 findings: 2 blockers, 5 concerns, 4 advisory$/,
    );

    // (4) Applicant-history pill carries the prior count. Seeder
    // inserted 3 priors for the same applicantFirm; the live row's
    // own submission is excluded by the route, so totalPrior = 3.
    const historyPill = page.getByTestId(`${triagePrefix}-applicant-history`);
    await expect(historyPill).toBeVisible();
    await expect(historyPill).toHaveAttribute("data-total-prior", "3");
    await expect(historyPill).toHaveText(/^3 prior · 2 approved · 1 returned$/);

    // Hover the pill to mount the Hovercard. The card shows the
    // most-recent priors (≤5) with engagement names + verdict
    // pills; assert the list size matches what we seeded (3).
    await historyPill.hover();
    const hovercardList = page.getByTestId(
      `${triagePrefix}-applicant-history-list`,
    );
    await expect(hovercardList).toBeVisible();
    const priorRows = hovercardList.locator('li[data-testid^="' + triagePrefix + '-applicant-history-row-"]');
    await expect(priorRows).toHaveCount(3);

    // Each seeded prior surfaces by its submissionId as the row
    // testid suffix. Spot-check that the 'returned' prior renders
    // with a verdict pill containing the literal "returned" label.
    const returnedPrior = seed.priors.find((p) => p.verdict === "returned");
    if (returnedPrior) {
      const returnedRow = page.getByTestId(
        `${triagePrefix}-applicant-history-row-${returnedPrior.submissionId}`,
      );
      await expect(returnedRow).toBeVisible();
      await expect(returnedRow).toContainText("returned");
    }
  });
});
