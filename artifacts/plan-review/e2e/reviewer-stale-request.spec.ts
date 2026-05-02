/**
 * Reviewer-stale-request — Wave 2 Sprint D / V1-2 e2e.
 *
 * Wire-smoke e2e for the reviewer-request surface. Exercises the
 * actual `/api/engagements/:id/reviewer-requests` + `/dismiss`
 * routes through the real server (audience gates, route handlers,
 * atom-event emission, implicit-resolve helper), plus the
 * Playwright UI assertion that the architect's
 * `ReviewerRequestsStrip` lights up when a reviewer files a request.
 *
 * Why an API-first shape rather than a full reviewer-side UI walk:
 * the V1-2 affordance gate inside `BriefingSourceRow` requires a
 * stale briefing-source row whose `layerKind` matches one of the
 * adapter freshness evaluators' tier maps — seeding a row that's
 * provably "stale" through every tier's threshold is brittle and
 * environment-coupled. The route-level wire test exercises the
 * same code paths the affordance triggers (POST create + GET list +
 * POST dismiss + atom_events emission) without the UI fragility,
 * and the Playwright leg verifies the architect strip renders the
 * pending row through the real React Query → API server round-trip.
 *
 * Mirrors `engagement-context-tab.spec.ts`'s seeding strategy: a
 * direct `@workspace/db` insert for the engagement (afterAll deletes
 * it and FK cascades clean up the reviewer-requests + atom events),
 * then real HTTP for the reviewer-request lifecycle.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, reviewerRequests, atomEvents } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Reviewer Stale Request ${RUN_TAG}`;
const TEST_BRIEFING_SOURCE_ID = `e2e-source-${RUN_TAG}`;

let engagementId = "";

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Moab, UT",
      address: "1 Reviewer Way",
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

test.describe("reviewer-request wire smoke", () => {
  test("reviewer files request → architect lists it → dismiss closes the loop", async ({
    request,
  }) => {
    // Reviewer creates the request.
    const create = await request.post(
      `/api/engagements/${engagementId}/reviewer-requests`,
      {
        data: {
          requestKind: "refresh-briefing-source",
          targetEntityType: "briefing-source",
          targetEntityId: TEST_BRIEFING_SOURCE_ID,
          reason: "Source PDF appears outdated.",
        },
        headers: {
          "x-audience": "internal",
          "x-requestor": "user:e2e-reviewer",
        },
      },
    );
    expect(create.status()).toBe(201);
    const createBody = await create.json();
    expect(createBody.request.engagementId).toBe(engagementId);
    expect(createBody.request.status).toBe("pending");
    const requestId = createBody.request.id as string;

    // The .requested event landed on the atom-events chain.
    const events = await db
      .select({ eventType: atomEvents.eventType })
      .from(atomEvents)
      .where(eq(atomEvents.entityId, requestId));
    expect(events.map((e) => e.eventType)).toContain(
      "reviewer-request.refresh-briefing-source.requested",
    );

    // Architect lists the engagement's pending requests and finds it.
    const list = await request.get(
      `/api/engagements/${engagementId}/reviewer-requests?status=pending`,
      {
        headers: {
          "x-audience": "user",
          "x-requestor": "user:e2e-architect",
        },
      },
    );
    expect(list.status()).toBe(200);
    const listBody = await list.json();
    const found = listBody.requests.find(
      (r: { id: string }) => r.id === requestId,
    );
    expect(found).toBeDefined();
    expect(found.reason).toBe("Source PDF appears outdated.");

    // Architect dismisses the request with a reason.
    const dismiss = await request.post(
      `/api/reviewer-requests/${requestId}/dismiss`,
      {
        data: { dismissalReason: "Source is current — verified upstream." },
        headers: {
          "x-audience": "user",
          "x-requestor": "user:e2e-architect",
        },
      },
    );
    expect(dismiss.status()).toBe(200);
    const dismissBody = await dismiss.json();
    expect(dismissBody.request.status).toBe("dismissed");
    expect(dismissBody.request.dismissalReason).toBe(
      "Source is current — verified upstream.",
    );

    // The .dismissed event landed on the chain.
    const eventsAfter = await db
      .select({ eventType: atomEvents.eventType })
      .from(atomEvents)
      .where(eq(atomEvents.entityId, requestId));
    expect(eventsAfter.map((e) => e.eventType)).toContain(
      "reviewer-request.refresh-briefing-source.dismissed",
    );

    // Pending list is now empty for this engagement.
    const listAfter = await request.get(
      `/api/engagements/${engagementId}/reviewer-requests?status=pending`,
      {
        headers: {
          "x-audience": "user",
          "x-requestor": "user:e2e-architect",
        },
      },
    );
    const listAfterBody = await listAfter.json();
    expect(
      listAfterBody.requests.find(
        (r: { id: string }) => r.id === requestId,
      ),
    ).toBeUndefined();
  });

  test("architect-side ReviewerRequestsStrip renders pending row in design-tools", async ({
    page,
  }) => {
    // Seed a pending request directly so the strip has something to
    // render on first paint — bypasses the UI affordance flow that
    // would otherwise need a stale briefing-source seed.
    const [seeded] = await db
      .insert(reviewerRequests)
      .values({
        engagementId,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: TEST_BRIEFING_SOURCE_ID,
        reason: "e2e-strip-render-check",
        status: "pending",
        requestedBy: {
          kind: "user",
          id: "e2e-reviewer-2",
          displayName: "E2E Reviewer Two",
        },
      })
      .returning({ id: reviewerRequests.id });
    const seededRequestId = seeded.id;

    // Set audience override so the architect-audience GET resolves.
    // Mirrors the dev-only header injection path the other e2e
    // specs use (see `recent-runs-deep-link.spec.ts` for precedent).
    await page.context().addCookies([
      {
        name: "pr_session_audience",
        value: "user",
        url: "http://localhost:5173",
      },
    ]);
    // Visit the architect's engagement detail. The strip is mounted
    // above the TabBar so it's visible regardless of the active tab.
    await page.goto(`/engagements/${engagementId}`);
    const strip = page.getByTestId("reviewer-requests-strip");
    await expect(strip).toBeVisible();
    await expect(
      page.getByTestId(`reviewer-request-row-${seededRequestId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`reviewer-request-reason-${seededRequestId}`),
    ).toContainText("e2e-strip-render-check");
  });
});
