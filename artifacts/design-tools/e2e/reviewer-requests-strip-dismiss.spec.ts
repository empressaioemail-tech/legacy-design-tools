/**
 * End-to-end coverage for the architect-side reviewer-requests strip
 * dismiss flow and the implicit-resolve "Resolved by your refresh"
 * pill (Task #442).
 *
 * Why this test exists: the optimistic dismiss path in
 * `DismissReviewerRequestDialog` and the implicit-resolve diff in
 * `ReviewerRequestsStrip` are covered by component tests
 * (`__tests__/ReviewerRequestsStrip.test.tsx`,
 * `__tests__/DismissReviewerRequestDialog.test.tsx`), but no spec
 * drives a real browser through the engagement detail page, opens
 * the dismiss dialog, posts to the live API, and watches the strip
 * update against a real `GET .../reviewer-requests?status=pending`
 * response. The wire-smoke at
 * `artifacts/plan-review/e2e/reviewer-stale-request.spec.ts` proves
 * the route handlers work end-to-end and that the strip mounts on
 * a seeded row, but it stops short of the dismiss UX and never
 * exercises the "Resolved by your refresh" pill at all. This spec
 * closes that regression gap.
 *
 * Strategy mirrors the seeding pattern used by the other
 * design-tools e2e specs: insert an engagement directly via
 * `@workspace/db` (afterAll deletes it; the FK on
 * `reviewer_requests.engagement_id` cascades the seeded rows away
 * with it), then drive the architect surface entirely through
 * Playwright using the default anonymous session — the
 * `sessionMiddleware`'s `ANONYMOUS_APPLICANT` already carries
 * `audience: "user"`, which is what the architect-only dismiss
 * route requires.
 *
 * Two scenarios:
 *
 *   1. Dismiss via the dialog. Seeds one pending row, opens the
 *      strip, clicks Dismiss, fills the reason, confirms, and
 *      asserts (a) the row disappears, (b) the inline
 *      "Request dismissed" pill renders, and (c) the row's status
 *      flipped to `dismissed` in the DB so we know the dialog
 *      actually round-tripped through the live mutation rather
 *      than just doing the optimistic local removal.
 *
 *   2. Implicit-resolve via DB UPDATE → window-focus refetch.
 *      Seeds a fresh pending row so the strip's diff baseline is
 *      a single-row pending list, then flips the row to
 *      `resolved` directly in the DB to simulate what the
 *      `resolveMatchingReviewerRequests` hook does after a domain
 *      action (regenerate-briefing / refresh-bim-model /
 *      refresh-briefing-source). The strip's React Query is
 *      configured with `refetchOnWindowFocus: true` and no
 *      polling interval, so we dispatch a `focus` event on
 *      `window` to nudge it into a refetch. The architect did
 *      NOT dismiss this row through the dialog (the
 *      `recentlyDismissedRef` map stays empty), so the
 *      `useEffect` diff classifies the vanished row as a backend
 *      resolve and renders the green
 *      "1 request resolved by your refresh" pill — exactly the
 *      surface a user would see after their own refresh action
 *      cleared a reviewer's stale-source ping.
 */

import { test, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, reviewerRequests } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Reviewer Requests Strip ${RUN_TAG}`;

let engagementId = "";

/**
 * Plant a `pr_session` cookie that gives the architect-audience
 * default session an explicit `requestor` claim. The dismiss route
 * (`POST /api/reviewer-requests/:id/dismiss`) calls
 * `actorEnvelopeFromRequest`, which 400s when `req.session.requestor`
 * is missing — the dev sessionMiddleware's `ANONYMOUS_APPLICANT`
 * carries `audience: "user"` (which is what we want — architects are
 * the user audience) but does NOT stamp a requestor by default. In a
 * real architect session the requestor would be hydrated from auth;
 * for the e2e we plant it via the JSON cookie shape the dev
 * middleware already decodes (mirrors `chat.test.ts`'s
 * "session cookie carries audience" precedent).
 */
async function setArchitectSession(page: Page): Promise<void> {
  const proxyOrigin = new URL(
    process.env["E2E_BASE_URL"] ?? "http://localhost:80",
  );
  await page.context().addCookies([
    {
      name: "pr_session",
      value: encodeURIComponent(
        JSON.stringify({
          audience: "user",
          requestor: { kind: "user", id: "e2e-architect" },
        }),
      ),
      domain: proxyOrigin.hostname,
      path: "/",
      httpOnly: false,
      secure: false,
    },
  ]);
}

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Moab, UT",
      address: "1 Reviewer Strip Way",
      status: "active",
    })
    .returning({ id: engagements.id });
  engagementId = eng.id;
});

test.afterAll(async () => {
  if (engagementId) {
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

/**
 * Seed a single `pending` reviewer-request against the test
 * engagement and return its id. The reason text is tagged with the
 * caller's `label` so concurrent test rows are easy to spot in a
 * failing-trace screenshot.
 */
async function seedPendingRequest(label: string): Promise<string> {
  const [row] = await db
    .insert(reviewerRequests)
    .values({
      engagementId,
      requestKind: "refresh-briefing-source",
      targetEntityType: "briefing-source",
      targetEntityId: `e2e-source-${label}-${RUN_TAG}`,
      reason: `e2e ${label} — ${RUN_TAG}`,
      status: "pending",
      requestedBy: {
        kind: "user",
        id: "e2e-reviewer",
        displayName: "E2E Reviewer",
      },
    })
    .returning({ id: reviewerRequests.id });
  return row.id;
}

/**
 * Wait for the strip to mount with the given seeded row visible.
 * Used by both scenarios so the implicit-resolve diff has its
 * `previousIdsRef` baseline established before we start mutating
 * the backing row.
 */
async function waitForStripWithRow(
  page: Page,
  requestId: string,
): Promise<void> {
  await expect(page.getByTestId("reviewer-requests-strip")).toBeVisible();
  await expect(
    page.getByTestId(`reviewer-request-row-${requestId}`),
  ).toBeVisible();
}

test.describe("ReviewerRequestsStrip e2e", () => {
  test("architect dismisses a request via the dialog → row disappears with inline 'Request dismissed' pill", async ({
    page,
  }) => {
    const requestId = await seedPendingRequest("dismiss");

    await setArchitectSession(page);
    await page.goto(`/engagements/${engagementId}`);
    await waitForStripWithRow(page, requestId);

    // Open the dismiss dialog from the row's per-request button.
    await page
      .getByTestId(`reviewer-request-dismiss-${requestId}`)
      .click();

    const dialog = page.getByTestId("dismiss-reviewer-request-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-request-id", requestId);

    // Confirm is disabled until a non-empty reason is provided —
    // pin that contract so a regression to "auto-submit on click"
    // surfaces here rather than letting an empty reason hit the
    // 400-guarded backend.
    const confirm = page.getByTestId("dismiss-reviewer-request-confirm");
    await expect(confirm).toBeDisabled();

    const reason = "Source verified upstream — no refresh needed.";
    await page
      .getByTestId("dismiss-reviewer-request-reason")
      .fill(reason);
    await expect(confirm).toBeEnabled();

    await confirm.click();

    // The mutation closes the dialog onSuccess.
    await expect(dialog).toBeHidden();

    // The dismissed row is gone from the strip.
    await expect(
      page.getByTestId(`reviewer-request-row-${requestId}`),
    ).toHaveCount(0);

    // The inline "Request dismissed" pill rendered. The pill auto-
    // hides after PILL_VISIBLE_MS (5s); we just need to catch it
    // before it expires.
    await expect(
      page.getByTestId("reviewer-requests-strip-pill-dismissed"),
    ).toBeVisible();
    await expect(
      page.getByTestId("reviewer-requests-strip-pill-dismissed"),
    ).toHaveText("Request dismissed");

    // Confirm the dismiss actually round-tripped through the live
    // mutation rather than just running the optimistic local
    // removal — the row's status should be `dismissed` and the
    // reason we typed should be preserved verbatim.
    const dbRows = await db
      .select({
        status: reviewerRequests.status,
        dismissalReason: reviewerRequests.dismissalReason,
      })
      .from(reviewerRequests)
      .where(eq(reviewerRequests.id, requestId));
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0].status).toBe("dismissed");
    expect(dbRows[0].dismissalReason).toBe(reason);
  });

  test("backend implicit-resolve → strip's next poll renders the green 'Resolved by your refresh' pill", async ({
    page,
  }) => {
    const requestId = await seedPendingRequest("implicit-resolve");

    await setArchitectSession(page);
    await page.goto(`/engagements/${engagementId}`);
    await waitForStripWithRow(page, requestId);

    // Simulate the implicit-resolve hook firing: the matching
    // domain action (e.g. briefing-source refresh) flips the row
    // to `resolved` via `resolveMatchingReviewerRequests`. Doing
    // this directly in the DB avoids the heavy ceremony of
    // wiring a real domain action through the API while
    // exercising the exact post-condition the strip's diff
    // observes — the row vanishes from the pending list without
    // an architect dismiss.
    await db
      .update(reviewerRequests)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
      })
      .where(eq(reviewerRequests.id, requestId));

    // The strip's `useListEngagementReviewerRequests` is
    // configured with `refetchOnWindowFocus: true` and no
    // polling interval, so we nudge React Query into a refetch
    // by firing the event its `focusManager` listens for.
    // `@tanstack/query-core`'s default focus setup adds a
    // `visibilitychange` listener on `window` (not `document`);
    // dispatching on the wrong target is a silent no-op, so we
    // mirror the registration target exactly. `document.visibilityState`
    // is `"visible"` in headless Chromium by default, so the
    // handler's `isFocused()` check passes and the listeners fire.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    // The pending list shrinks to zero, no architect dismiss
    // happened, so the diff effect classifies the removed row as
    // a backend resolve and renders the green pill.
    const pill = page.getByTestId(
      "reviewer-requests-strip-pill-implicit-resolved",
    );
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText("1 request resolved by your refresh");

    // The seeded row is gone from the strip.
    await expect(
      page.getByTestId(`reviewer-request-row-${requestId}`),
    ).toHaveCount(0);
  });
});
