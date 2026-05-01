/**
 * End-to-end regression test for the "Record jurisdiction response"
 * flow on a submission row (`RecordSubmissionResponseDialog`,
 * mounted inside `EngagementDetail.tsx`'s Submissions tab).
 *
 * Why this test exists (Task #135): the dialog has fast component
 * tests but the full round-trip — row "Record response" trigger →
 * dialog open → status pick → comment entry → POST
 * /api/engagements/:id/submissions/:submissionId/response → query
 * invalidation that refreshes the submission row inline (status
 * badge, reviewer-comment block, responded-at relative timestamp) —
 * has only been verified by hand. This spec pins it so a regression
 * in any of:
 *
 *   - the per-row `submission-record-response-*` button targeting,
 *   - the dialog's status-radio + comment-textarea + confirm wiring,
 *   - the record-response React Query mutation + invalidation, or
 *   - the inline row update that surfaces the recorded reply,
 *
 * fails CI instead of degrading silently in the live UI.
 *
 * Strategy mirrors `submit-to-jurisdiction.spec.ts`:
 *
 *   1. Insert a fresh engagement *and* a submission directly via
 *      `@workspace/db` so the row exists on the first render and
 *      we don't need to drive the prior step in this test (that step
 *      already has its own spec). Direct inserts are safe here
 *      because the dialog's React Query invalidations refetch from
 *      the server, so row state still has to round-trip end-to-end.
 *   2. Drive the UI through Playwright: open the dialog from the
 *      row's "Record response" trigger, select Corrections requested,
 *      type a comment unique to this run, confirm, and assert the
 *      row now renders the new status badge + the comment block.
 *   3. `afterAll` deletes the seeded engagement; the FK cascade on
 *      `submissions` removes the submission row alongside it.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, submissions } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Record Response ${RUN_TAG}`;
const TEST_NOTE = `e2e-original-note ${RUN_TAG}`;
const TEST_COMMENT = `e2e-reviewer-comment ${RUN_TAG}`;
const TEST_JURISDICTION = "Moab, UT";

let engagementId = "";
let submissionId = "";

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: TEST_JURISDICTION,
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: "456 E2E Response St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  const [sub] = await db
    .insert(submissions)
    .values({
      engagementId: eng.id,
      jurisdiction: eng.jurisdiction,
      jurisdictionCity: eng.jurisdictionCity,
      jurisdictionState: eng.jurisdictionState,
      jurisdictionFips: eng.jurisdictionFips,
      note: TEST_NOTE,
    })
    .returning();
  if (!sub) throw new Error("seed: submission insert returned no row");
  submissionId = sub.id;
});

test.afterAll(async () => {
  if (engagementId) {
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("records a jurisdiction reply via the RecordSubmissionResponseDialog", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=submissions`);

  // Pre-condition: row is rendered as `pending` (no recorded reply
  // yet) and there's no inline response block. Both flip after the
  // dialog confirms.
  const row = page.getByTestId(`submission-row-${submissionId}`);
  await expect(row).toBeVisible();
  await expect(
    page.getByTestId(`submission-status-${submissionId}`),
  ).toContainText(/pending/i);
  await expect(
    page.getByTestId(`submission-response-${submissionId}`),
  ).toHaveCount(0);

  // Open the dialog from the row's per-submission trigger.
  await page
    .getByTestId(`submission-record-response-${submissionId}`)
    .click();
  const dialog = page.getByTestId("record-response-dialog");
  await expect(dialog).toBeVisible();

  // Pick "Corrections requested" — exercising a non-default option
  // (default is "approved") proves the radio change is wired into
  // the request payload, not just into local component state.
  await page
    .getByTestId("record-response-status-corrections_requested")
    .click();
  await expect(
    page.getByTestId("record-response-status-corrections_requested")
      .getByRole("radio"),
  ).toBeChecked();

  // Fill the reviewer comment.
  await page
    .getByTestId("record-response-comment")
    .fill(TEST_COMMENT);

  // Confirm. The mutation invalidates the engagement, both atom-
  // history scopes, the submission's atom summary, and the
  // submissions-list query (see RecordSubmissionResponseDialog.tsx).
  await page.getByTestId("record-response-confirm").click();
  await expect(dialog).toBeHidden();

  // Inline row update: the status badge flips to "corrections
  // requested", the reviewer-comment block appears with the typed
  // text, and the response wrapper now exists.
  await expect(
    page.getByTestId(`submission-status-${submissionId}`),
  ).toContainText(/corrections/i);
  await expect(
    page.getByTestId(`submission-response-${submissionId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`submission-response-${submissionId}`),
  ).toContainText(TEST_COMMENT);
  // Responded-at relative timestamp surfaces the just-recorded reply.
  await expect(
    page.getByTestId(`submission-responded-at-${submissionId}`),
  ).toBeVisible();

  // The action button copy flips from "Record response" (pending) to
  // "Update response" (a recorded reply now exists), proving the row
  // re-rendered with the freshly-loaded status — not just the local
  // optimistic mirror.
  await expect(
    page.getByTestId(`submission-record-response-${submissionId}`),
  ).toContainText(/update response/i);

  // Belt-and-braces: confirm the database row also reflects the
  // recorded reply. Without this the test would still pass on a
  // pure-frontend hot-path bug that surfaced the local mirror but
  // never persisted the row.
  const persisted = await db
    .select({
      status: submissions.status,
      reviewerComment: submissions.reviewerComment,
      respondedAt: submissions.respondedAt,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  expect(persisted).toHaveLength(1);
  expect(persisted[0]!.status).toBe("corrections_requested");
  expect(persisted[0]!.reviewerComment).toBe(TEST_COMMENT);
  expect(persisted[0]!.respondedAt).not.toBeNull();
});
