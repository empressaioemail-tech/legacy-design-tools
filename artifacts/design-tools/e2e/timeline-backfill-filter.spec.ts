/**
 * End-to-end regression test for the engagement-timeline backfill
 * filter's `?reply=…` URL deep link (Task #137, pinning the round
 * trip introduced in Task #124).
 *
 * Why this test exists: the URL <-> chip-state plumbing is already
 * unit-tested at the helper layer (`submissionBackfill.ts`'s
 * `parseBackfillFilter` etc.), but the full browser-level round trip
 * — URL → chip pre-selected → URL rewritten on chip change → list
 * filtered accordingly — is only enforced by the page itself. Without
 * a browser test, a future refactor that swaps the routing library
 * (e.g. wouter → something that swallows query params) or that
 * accidentally drops the `replaceState` call would silently break
 * deep links and the regression would not surface until a user
 * complained.
 *
 * Strategy:
 *
 *   1. Insert a fresh engagement directly via `@workspace/db` so the
 *      test owns a known engagement id (mirrors the seeding pattern
 *      already used in `submission-detail.spec.ts`).
 *   2. POST two submissions through the real API. For the row that
 *      should render as a backfill, directly UPDATE the
 *      `respondedAt` / `responseRecordedAt` columns to two timestamps
 *      whose gap clears the `SUBMISSION_BACKFILL_THRESHOLD_MS`
 *      window — we cannot achieve that gap purely through the
 *      response route because it (correctly) refuses to record a
 *      `respondedAt` earlier than the row's `submittedAt`, and the
 *      row was just submitted. The other row gets a live reply via
 *      the real response route (omit `respondedAt`, server stamps
 *      both timestamps to "now" → ~0 gap → reads as live). Direct
 *      UPDATE is a deliberate seeding-only escape hatch, scoped to
 *      a single row in a test-owned engagement; the *production*
 *      write path is still exercised by the live submission and by
 *      `submission-detail.spec.ts`.
 *   3. Drive the UI through Playwright:
 *        - Land on `?tab=submissions&reply=backfilled`, assert the
 *          Backfilled chip is pre-selected and only the backfilled
 *          row is visible.
 *        - Click "Live", assert the URL is rewritten to
 *          `?tab=submissions&reply=live` (the `tab` param survives)
 *          and only the live row is visible.
 *        - Click "All", assert the `reply` param is dropped from the
 *          URL entirely (canonical URL stays clean) and both rows
 *          render.
 *   4. `afterAll` deletes the seeded engagement; the FK on the
 *      submissions table cascades the submission rows away with it,
 *      so we leave the dev DB exactly as we found it.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, submissions } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Backfill Filter ${RUN_TAG}`;
const BACKFILLED_NOTE = `e2e-backfilled-note ${RUN_TAG}`;
const LIVE_NOTE = `e2e-live-note ${RUN_TAG}`;

/**
 * 7 days is comfortably past `SUBMISSION_BACKFILL_THRESHOLD_MS`
 * (1 hour) so a few seconds of clock skew between the test process
 * and the API server cannot accidentally tip the row into the "live"
 * bucket.
 */
const BACKFILL_GAP_MS = 7 * 24 * 60 * 60 * 1000;

let engagementId = "";
let backfilledSubmissionId = "";
let liveSubmissionId = "";

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
      address: "123 E2E Backfill Filter St, Moab, UT 84532",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // Submission #1 — will be marked as a backfilled reply. We POST
  // it through the real route so the row + audit event look
  // production-shaped, then directly UPDATE the response columns to
  // a (respondedAt, responseRecordedAt) pair whose gap clears the
  // backfill threshold. See the file header for why we don't go
  // through the response route here.
  backfilledSubmissionId = await postSubmission(
    request,
    engagementId,
    BACKFILLED_NOTE,
  );
  const respondedAt = new Date();
  const responseRecordedAt = new Date(respondedAt.getTime() + BACKFILL_GAP_MS);
  await db
    .update(submissions)
    .set({
      status: "approved",
      respondedAt,
      responseRecordedAt,
    })
    .where(eq(submissions.id, backfilledSubmissionId));

  // Submission #2 — receives a live reply via the real route.
  // Omitting `respondedAt` makes the server stamp both timestamps to
  // "now", so the gap is ~0 and the row reads as a live reply.
  liveSubmissionId = await postSubmission(request, engagementId, LIVE_NOTE);
  await postResponse(request, engagementId, liveSubmissionId, {
    status: "approved",
  });
});

test.afterAll(async () => {
  if (engagementId) {
    // Cascades to the submission rows (see lib/db/src/schema/submissions.ts).
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("?reply= deep link round-trips through the backfill filter chips", async ({
  page,
}) => {
  // Deep-link straight into the backfilled view. This is the canary
  // the test exists for: the page must read `?reply=backfilled` on
  // initial mount (not just after a click).
  await page.goto(
    `/engagements/${engagementId}?tab=submissions&reply=backfilled`,
  );

  const filterGroup = page.getByTestId("submissions-backfill-filter");
  await expect(filterGroup).toBeVisible();

  const allChip = page.getByTestId("submissions-backfill-filter-all");
  const backfilledChip = page.getByTestId(
    "submissions-backfill-filter-backfilled",
  );
  const liveChip = page.getByTestId("submissions-backfill-filter-live");
  const backfilledRow = page.getByTestId(
    `submission-row-${backfilledSubmissionId}`,
  );
  const liveRow = page.getByTestId(`submission-row-${liveSubmissionId}`);

  // Initial state: Backfilled chip is pre-selected, only the
  // backfilled row renders, and the live row is filtered out.
  await expect(backfilledChip).toHaveAttribute("aria-checked", "true");
  await expect(allChip).toHaveAttribute("aria-checked", "false");
  await expect(liveChip).toHaveAttribute("aria-checked", "false");
  await expect(backfilledRow).toBeVisible();
  await expect(liveRow).toHaveCount(0);

  // Click the Live chip — URL must be rewritten so a refresh / share
  // lands on the same view, and the visible rows must flip.
  await liveChip.click();
  await expect(page).toHaveURL(/[?&]reply=live(&|$)/);
  await expect(page).toHaveURL(/[?&]tab=submissions(&|$)/);
  await expect(liveChip).toHaveAttribute("aria-checked", "true");
  await expect(backfilledChip).toHaveAttribute("aria-checked", "false");
  await expect(liveRow).toBeVisible();
  await expect(backfilledRow).toHaveCount(0);

  // Click the All chip — the `reply` param must be removed entirely
  // (canonical URL stays clean) while `tab` is preserved, and both
  // rows render again.
  await allChip.click();
  await expect(page).not.toHaveURL(/[?&]reply=/);
  await expect(page).toHaveURL(/[?&]tab=submissions(&|$)/);
  await expect(allChip).toHaveAttribute("aria-checked", "true");
  await expect(backfilledRow).toBeVisible();
  await expect(liveRow).toBeVisible();
});

/**
 * POST a submission via the real API and return its id. Throws on
 * any non-201 so a server-side regression in the seeding endpoint
 * surfaces as a clear seed failure rather than a confusing
 * "row-not-visible" assertion later.
 */
async function postSubmission(
  request: import("@playwright/test").APIRequestContext,
  engagementIdArg: string,
  note: string,
): Promise<string> {
  const resp = await request.post(
    `/api/engagements/${engagementIdArg}/submissions`,
    {
      data: { note },
      headers: { "content-type": "application/json" },
    },
  );
  if (resp.status() !== 201) {
    throw new Error(
      `seed: POST /api/engagements/${engagementIdArg}/submissions returned ` +
        `${resp.status()}: ${await resp.text()}`,
    );
  }
  const body = (await resp.json()) as { submissionId?: string };
  if (!body.submissionId) {
    throw new Error("seed: response did not include submissionId");
  }
  return body.submissionId;
}

/**
 * POST a jurisdiction response against an existing submission via
 * the real API. Same throw-on-non-200 contract as `postSubmission`.
 */
async function postResponse(
  request: import("@playwright/test").APIRequestContext,
  engagementIdArg: string,
  submissionIdArg: string,
  body: { status: "approved" | "corrections_requested" | "rejected"; respondedAt?: string },
): Promise<void> {
  const resp = await request.post(
    `/api/engagements/${engagementIdArg}/submissions/${submissionIdArg}/response`,
    {
      data: body,
      headers: { "content-type": "application/json" },
    },
  );
  if (resp.status() !== 200) {
    throw new Error(
      `seed: POST .../submissions/${submissionIdArg}/response returned ` +
        `${resp.status()}: ${await resp.text()}`,
    );
  }
}
