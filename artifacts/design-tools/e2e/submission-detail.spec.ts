/**
 * End-to-end regression test for the per-submission detail modal opened
 * from an engagement's Submissions tab.
 *
 * Why this test exists (Task #94): the modal already has a fast component
 * test (`SubmissionDetailModal.test.tsx`) but the full round-trip — row
 * click target → atom-summary fetch → engagement-history hydration of
 * the matched `engagement.submitted` event — has only been verified by
 * one-off manual exercise. This spec pins that round-trip so a future
 * regression in any of:
 *
 *   - the `submission-row-*` button targeting in `EngagementDetail.tsx`,
 *   - the `submission` atom registration / summary endpoint,
 *   - the engagement audit-history hydration that powers the related
 *     event panel,
 *
 * causes a real CI failure instead of a silent UX regression.
 *
 * Strategy:
 *
 *   1. Insert a fresh engagement directly via `@workspace/db` so the
 *      test has a known id to navigate to (we don't rely on whatever
 *      engagements happen to live in the dev DB — that would be flaky
 *      across machines / branches).
 *   2. Create a submission against that engagement through the *real*
 *      `POST /api/engagements/:id/submissions` route so the
 *      `engagement.submitted` audit event fires exactly the way it
 *      would in production. (Direct-inserting the row would skip the
 *      event and the related-event panel assertion would degenerate
 *      into the "no recorded event" fallback path.)
 *   3. Drive the UI through Playwright: open the engagement detail
 *      page on the Submissions tab, click the seeded row, assert the
 *      modal renders the full note, the jurisdiction header, and the
 *      hydrated event panel. Close, then re-open to confirm the row
 *      remains a re-entrant trigger.
 *   4. `afterAll` deletes the seeded engagement; the FK on the
 *      submissions table cascades the submission row away with it, so
 *      we leave the dev DB exactly as we found it.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Submission Detail ${RUN_TAG}`;
const TEST_NOTE = `e2e-test-note ${RUN_TAG}`;

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
      address: "123 E2E Test St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // POST through the real API so the `engagement.submitted` audit
  // event is appended to atom_events. The detail modal's related
  // event panel reads that event back via the engagement's atom
  // history endpoint.
  const resp = await request.post(
    `/api/engagements/${engagementId}/submissions`,
    {
      data: { note: TEST_NOTE },
      headers: { "content-type": "application/json" },
    },
  );
  if (resp.status() !== 201) {
    throw new Error(
      `seed: POST /api/engagements/${engagementId}/submissions returned ` +
        `${resp.status()}: ${await resp.text()}`,
    );
  }
  const body = (await resp.json()) as { submissionId?: string };
  if (!body.submissionId) {
    throw new Error("seed: response did not include submissionId");
  }
  submissionId = body.submissionId;
});

test.afterAll(async () => {
  if (engagementId) {
    // Cascades to the submission row (see lib/db/src/schema/submissions.ts).
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("opens, displays, closes, and re-opens the submission detail modal", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=submissions`);

  const row = page.getByTestId(`submission-row-${submissionId}`);
  await expect(row).toBeVisible();

  await row.click();

  const modal = page.getByTestId("submission-detail-modal");
  await expect(modal).toBeVisible();

  // The modal renders inside a fixed-position backdrop — scope every
  // subsequent assertion to that inner card so a stray match in the
  // background page (e.g. the row we just clicked) cannot satisfy it.
  const dialog = modal.getByRole("dialog");

  // Full note text round-trips from POST body → submissions.note → atom
  // summary → modal body. The `pre-wrap` formatting preserves it
  // verbatim, so a strict equality check is safe.
  await expect(modal.getByTestId("submission-detail-note")).toHaveText(
    TEST_NOTE,
  );

  // Header surfaces the engagement's resolved jurisdiction snapshot.
  // `Moab, UT` is what we seeded as `engagements.jurisdiction`.
  await expect(dialog).toContainText("Submitted to Moab, UT");

  // Related event panel — proves the engagement-history hydration
  // matched the submission atom's `historyProvenance.latestEventId`.
  // If hydration breaks we'd fall through to
  // `submission-detail-event-missing` instead.
  const eventPanel = page.getByTestId("submission-detail-event");
  await expect(eventPanel).toBeVisible();
  await expect(eventPanel).toContainText("engagement.submitted");
  await expect(eventPanel).toContainText(`event id: `);
  await expect(
    page.getByTestId("submission-detail-event-missing"),
  ).toHaveCount(0);

  // Close round-trip — close button hides the modal, and clicking the
  // same row re-opens it. This pins the parent's selection-state
  // reset so a future refactor doesn't accidentally make the row a
  // one-shot trigger.
  await page.getByTestId("submission-detail-close").click();
  await expect(modal).toBeHidden();

  await row.click();
  await expect(page.getByTestId("submission-detail-modal")).toBeVisible();
  await expect(
    page.getByTestId("submission-detail-modal").getByTestId(
      "submission-detail-note",
    ),
  ).toHaveText(TEST_NOTE);
});
