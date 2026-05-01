/**
 * End-to-end regression test for the "Submit to jurisdiction" flow on
 * the engagement detail page (`SubmitToJurisdictionDialog`, mounted
 * inside `EngagementDetail.tsx`).
 *
 * Why this test exists (Task #135): the dialog has fast component
 * tests but the full round-trip — header trigger → dialog open → note
 * entry → POST /api/engagements/:id/submissions → query invalidation
 * that surfaces both the success banner above the header *and* the
 * newly-created row in the Submissions tab — has only been verified
 * by hand. This spec pins that round-trip so a regression in any of:
 *
 *   - the `submit-jurisdiction-trigger` button on the page header,
 *   - the dialog's note-textarea / confirm wiring,
 *   - the create-submission React Query mutation + invalidation, or
 *   - the post-submit success banner / submissions-list refresh,
 *
 * fails CI instead of degrading silently in the live UI.
 *
 * Strategy mirrors `submission-detail.spec.ts`:
 *
 *   1. Insert a fresh engagement directly via `@workspace/db` so the
 *      page has a known id to navigate to (and so the test never
 *      depends on whatever engagements happen to live in the dev DB).
 *      We deliberately do NOT pre-seed a submission — the assertion
 *      is that the dialog's POST creates one and the page refetches.
 *   2. Drive the UI through Playwright: click the header trigger,
 *      type a note that's unique to this test run, confirm, and assert
 *      that the success banner renders, the dialog closes, and the
 *      Submissions tab now contains exactly one row whose id matches
 *      the submission the page received from the server.
 *   3. `afterAll` deletes the seeded engagement; the FK on the
 *      submissions table cascades the row away with it (see
 *      `lib/db/src/schema/submissions.ts`).
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, submissions } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Submit Dialog ${RUN_TAG}`;
const TEST_NOTE = `e2e-submit-note ${RUN_TAG}`;
const TEST_JURISDICTION = "Moab, UT";

let engagementId = "";

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
      // Address is set so the page does NOT auto-open the intake
      // modal on first load (which would steal focus from the
      // submit-jurisdiction trigger).
      address: "123 E2E Submit St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;
});

test.afterAll(async () => {
  if (engagementId) {
    // Cascades to any submission row the test created.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("submits a package via the SubmitToJurisdictionDialog", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=submissions`);

  // Sanity check: there should be no submission rows on the empty
  // listing yet — proves the row that appears after submit really
  // came from this test's POST and not a leftover row.
  await expect(page.getByTestId("submissions-empty")).toBeVisible();

  // Open the dialog from the page header trigger.
  await page.getByTestId("submit-jurisdiction-trigger").click();
  const dialog = page.getByTestId("submit-jurisdiction-dialog");
  await expect(dialog).toBeVisible();

  // The character counter starts at 0 / max — confirms the textarea
  // is wired to the dialog state and not just visually present.
  await expect(
    page.getByTestId("submit-jurisdiction-note-count"),
  ).toContainText("0 /");

  // Fill the note. Using `fill` (rather than `type`) is intentional:
  // the dialog's controlled textarea reflects the value via React
  // state, and `fill` issues a single change event that mirrors a
  // user paste — which is the observable contract.
  await page.getByTestId("submit-jurisdiction-note").fill(TEST_NOTE);

  // Submit. The mutation invalidates the engagement, atom-history,
  // and submissions-list query keys (see lib/portal-ui/src/components/
  // SubmitToJurisdictionDialog.tsx) and then closes the dialog.
  await page.getByTestId("submit-jurisdiction-confirm").click();

  // Dialog disappears (close fires after invalidations resolve).
  await expect(dialog).toBeHidden();

  // Success banner appears above the header carrying the captured
  // jurisdiction string. The dialog's `onSubmitted` callback is what
  // populates the parent page's `lastSubmission` state.
  const banner = page.getByTestId("submit-jurisdiction-success-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(TEST_JURISDICTION);

  // The submissions list refetched and now shows exactly one row.
  // The DB carries the canonical id; we look it up to assert the row
  // testid (and the note text it surfaces) round-trips end-to-end.
  const created = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.engagementId, engagementId));
  expect(created).toHaveLength(1);
  const submissionId = created[0]!.id;

  await expect(
    page.getByTestId(`submission-row-${submissionId}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`submission-note-${submissionId}`),
  ).toHaveText(TEST_NOTE);
  // A brand-new submission has no recorded reply yet.
  await expect(
    page.getByTestId(`submission-status-${submissionId}`),
  ).toContainText(/pending/i);
});
