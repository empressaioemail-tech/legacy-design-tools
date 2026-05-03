/**
 * Track 1 Pass B — AI-badge persistence flow.
 *
 * Pins the "frozen at first acceptance" semantics of the Track 1
 * AIBadge surface (lib/portal-ui/src/components/AIBadge.tsx). The
 * label and `data-state` attribute MUST move as a unit when an
 * AI-generated finding is accepted, AND must NOT move when the
 * finding is rejected — a rejected AI finding stays
 * `data-state="ai-unaccepted"` with the bare "AI generated" label.
 *
 * Two tests:
 *   1. accept → reload → badge reads
 *      "AI generated · reviewer confirmed ({Name}, {date})" with
 *      `data-state="ai-accepted"`. Server-side proof: the
 *      `findings.accepted_by_reviewer_id` and `accepted_at` columns
 *      are populated on the row.
 *   2. reject → reload → badge stays "AI generated" with
 *      `data-state="ai-unaccepted"`. Server-side proof: acceptance
 *      columns remain null. Pins the freeze semantic — accept fields
 *      do not get scribbled by a reject path.
 *
 * Reviewer-authored findings are also seeded so the third badge branch
 * ("Authored by reviewer (Name)") is exercised at first paint.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, findings } from "@workspace/db";
import {
  promoteToInternalAudience,
  seedTrack1Scenario,
  type SeedTrack1Result,
} from "./fixtures/seedTrack1";

let seed: SeedTrack1Result;

test.beforeAll(async ({ request }) => {
  seed = await seedTrack1Scenario({
    scenario: "ai-badge-persistence",
    request,
  });
});

test.afterAll(async () => {
  if (seed) await seed.cleanup();
});

function findingsTabUrl(seed: SeedTrack1Result): string {
  return `engagements/${seed.primary.engagementId}?submission=${seed.primary.submissionId}&tab=findings`;
}

test.describe("ai-badge-persistence — Track 1 Pass B", () => {
  test("accepting an AI finding persists the confirming reviewer + date across reload", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context(), {
      requestorId: seed.reviewer.id,
    });

    const aiUnacceptedFinding = seed.primary.findings[0]!;
    const reviewerAuthoredFinding = seed.primary.findings[1]!;

    await page.goto(findingsTabUrl(seed));

    // First paint — both badge branches render off the initial wire
    // shape: AI-unaccepted reads "AI generated", reviewer-authored
    // reads "Authored by reviewer (...)".
    const aiBadge = page.getByTestId(
      `finding-row-author-${aiUnacceptedFinding.id}`,
    );
    await expect(aiBadge).toBeVisible();
    await expect(aiBadge).toHaveAttribute("data-state", "ai-unaccepted");
    await expect(aiBadge).toHaveText("AI generated");

    const reviewerAuthoredBadge = page.getByTestId(
      `finding-row-author-${reviewerAuthoredFinding.id}`,
    );
    await expect(reviewerAuthoredBadge).toHaveAttribute(
      "data-state",
      "reviewer-authored",
    );
    await expect(reviewerAuthoredBadge).toHaveText(/^Authored by reviewer \(/);

    // Click Accept on the AI finding. The status pill flips to
    // "ACCEPTED" once the mutation lands; this is the load-bearing
    // wait before reload (the reload assertion will fail flaky if the
    // mutation hasn't committed).
    await page
      .getByTestId(`finding-row-accept-${aiUnacceptedFinding.id}`)
      .click();
    await expect(
      page.getByTestId(`finding-row-status-${aiUnacceptedFinding.id}`),
    ).toHaveText(/accepted/i);

    // Reload to prove the badge is reading from the persisted
    // `accepted_by_reviewer_id` / `accepted_at` columns and not from
    // optimistic in-memory state.
    await page.reload();
    await page.waitForURL(new RegExp(`tab=findings`));

    const aiBadgeAfterReload = page.getByTestId(
      `finding-row-author-${aiUnacceptedFinding.id}`,
    );
    await expect(aiBadgeAfterReload).toBeVisible();
    await expect(aiBadgeAfterReload).toHaveAttribute(
      "data-state",
      "ai-accepted",
    );
    // Label format from AIBadge: "AI generated · reviewer confirmed
    // ({displayName}, {date})". `formatAcceptanceDate` uses
    // `toLocaleDateString()`, so the date portion is locale-dependent;
    // assert the prefix + reviewer name + a generic date-ish trailing
    // segment via regex rather than pinning the exact string.
    await expect(aiBadgeAfterReload).toHaveText(
      new RegExp(
        `^AI generated · reviewer confirmed \\(${escapeRegex(
          seed.reviewer.displayName,
        )}, .+\\)$`,
      ),
    );

    // Server-side proof — the persistence is in the DB columns, not
    // just the badge label.
    const dbRow = await db
      .select({
        acceptedByReviewerId: findings.acceptedByReviewerId,
        acceptedAt: findings.acceptedAt,
      })
      .from(findings)
      .where(eq(findings.id, aiUnacceptedFinding.id))
      .limit(1);
    expect(dbRow[0]?.acceptedByReviewerId).toBe(seed.reviewer.id);
    expect(dbRow[0]?.acceptedAt).not.toBeNull();
  });

  test("rejecting an AI finding does NOT populate acceptance fields", async ({
    page,
  }) => {
    await promoteToInternalAudience(page.context(), {
      requestorId: seed.reviewer.id,
    });

    const aiRejectFinding = seed.primary.findings[2]!;

    await page.goto(findingsTabUrl(seed));

    const aiBadge = page.getByTestId(
      `finding-row-author-${aiRejectFinding.id}`,
    );
    await expect(aiBadge).toBeVisible();
    await expect(aiBadge).toHaveAttribute("data-state", "ai-unaccepted");
    await expect(aiBadge).toHaveText("AI generated");

    // Click Reject on the second AI finding. Status pill flips to
    // "REJECTED"; the badge MUST stay on the unaccepted branch
    // because reject does not touch the accept-tracking columns.
    await page.getByTestId(`finding-row-reject-${aiRejectFinding.id}`).click();
    await expect(
      page.getByTestId(`finding-row-status-${aiRejectFinding.id}`),
    ).toHaveText(/rejected/i);

    // Reload to confirm the badge reads from the persisted state, not
    // optimistic in-memory state.
    await page.reload();
    await page.waitForURL(new RegExp(`tab=findings`));

    const aiBadgeAfterReload = page.getByTestId(
      `finding-row-author-${aiRejectFinding.id}`,
    );
    await expect(aiBadgeAfterReload).toBeVisible();
    // Critical: the badge stays on the unaccepted branch even though
    // the reviewer has now-acted on the row. The accept-tracking
    // semantic is "first acceptance only" — a reject must not promote
    // the badge into the "ai-accepted" branch.
    await expect(aiBadgeAfterReload).toHaveAttribute(
      "data-state",
      "ai-unaccepted",
    );
    await expect(aiBadgeAfterReload).toHaveText("AI generated");

    // Server-side proof — acceptance columns stay null on reject.
    const dbRow = await db
      .select({
        acceptedByReviewerId: findings.acceptedByReviewerId,
        acceptedAt: findings.acceptedAt,
        status: findings.status,
      })
      .from(findings)
      .where(eq(findings.id, aiRejectFinding.id))
      .limit(1);
    expect(dbRow[0]?.acceptedByReviewerId).toBeNull();
    expect(dbRow[0]?.acceptedAt).toBeNull();
    expect(dbRow[0]?.status).toBe("rejected");
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
