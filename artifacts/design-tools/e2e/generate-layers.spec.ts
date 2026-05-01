/**
 * End-to-end regression test for the Site Context tab's "Generate
 * Layers" button (Task #171, closing the FE coverage gap left by
 * DA-PI-4).
 *
 * Why this test exists: DA-PI-4 already has solid lower-level
 * coverage —
 *
 *   - per-adapter unit tests in `lib/adapters/src/__tests__/*` exercise
 *     the upstream HTTP shapes, the `appliesTo` jurisdiction gate, and
 *     the `AdapterRunError` translation;
 *   - `artifacts/api-server/src/__tests__/generate-layers.test.ts`
 *     exercises the route end-to-end with a mocked `@workspace/adapters`
 *     module, asserting the run → persist → supersede → emit-event
 *     contract;
 *
 * but nothing covers the FE/BE handshake the architect actually drives:
 *
 *     button click
 *        → `useGenerateEngagementLayers` mutation
 *        → POST /api/engagements/:id/generate-layers
 *        → onSuccess sets `lastOutcomes` + invalidates the briefing key
 *        → useGetEngagementBriefing refetches
 *        → SiteContextTab re-renders the per-adapter outcome panel
 *           and the tier-grouped briefing-source rows.
 *
 * Any one of those seams could regress silently — for example a future
 * refactor that drops `setLastOutcomes`, or that forgets to invalidate
 * the briefing query key after the mutation, would still pass every
 * existing test today. This spec pins the round-trip so a CI failure
 * lands instead of a quiet UX regression.
 *
 * Strategy:
 *
 *   1. Insert a clean Moab UT engagement directly via `@workspace/db`
 *      (the same seeding pattern used by `submission-detail.spec.ts`
 *      and `dxf-upload-3d-render.spec.ts`). Moab is one of the three
 *      DA-PI-4 pilot jurisdictions, so the FE wiring this test
 *      exercises is the same one production traffic will hit. The
 *      seed is removed in `afterAll`, FK-cascading any briefing /
 *      briefing-source rows the test produced.
 *
 *   2. Stub the two endpoints the SiteContextTab depends on with
 *      `page.route`:
 *
 *        - `POST /api/engagements/:id/generate-layers` returns a
 *          deterministic `GenerateLayersResponse` carrying one OK
 *          state-adapter outcome (utah:ugrc-parcels), one OK local-
 *          adapter outcome (grand-county-ut:zoning), and one
 *          no-coverage outcome (utah:tax-parcels) so the per-adapter
 *          panel renders all three status branches.
 *        - `GET /api/engagements/:id/briefing` returns
 *          `{ briefing: null }` until the POST is observed, and the
 *          populated briefing afterwards. The state flip happens
 *          inside the POST handler so the order of operations is
 *          deterministic regardless of how React Query schedules the
 *          refetch.
 *
 *      Why stubs (and not the real adapters): the production adapters
 *      hit county/state GIS endpoints. Letting them run from the
 *      Replit pre-merge validation budget would (a) be flaky against
 *      county uptime, (b) add network latency to the e2e timeout, and
 *      (c) make the assertions data-dependent on whatever the
 *      jurisdiction returns today. The task explicitly allows
 *      stubbing the upstream adapter HTTP calls so the test stays
 *      deterministic. The route's real persistence + atom-event path
 *      is already covered by the integration test referenced above.
 *
 *   3. Drive the UI through Playwright: open the engagement on the
 *      Site Context tab, assert that no tier groups render initially
 *      (briefing is null), click the "Generate Layers" button, then
 *      assert that
 *        - the per-adapter outcome panel renders one row per outcome
 *          with the correct status text,
 *        - the cache-invalidation refetch lands and the
 *          tier-grouped briefing-source rows render under the
 *          state and local tier headers,
 *        - the per-source rows carry the testids the rest of the
 *          page wires off of (`briefing-source-<id>`).
 *
 *      A final check confirms the POST was invoked exactly once —
 *      a future regression that double-fires the mutation (e.g. by
 *      removing `disabled={isPending}`) would otherwise slip past.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements } from "@workspace/db";
import { PILOT_JURISDICTIONS } from "@workspace/adapters";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Generate Layers ${RUN_TAG}`;

let engagementId = "";

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      // Moab UT — one of the three DA-PI-4 pilot jurisdictions
      // (Bastrop TX, Moab UT, Salmon ID). The route uses the
      // `jurisdictionState`/`jurisdictionCity` columns + the
      // lat/lng to resolve the jurisdiction; we stamp coordinates
      // alongside so the FE briefingQuery shape matches what
      // production sees, even though every server-side response is
      // stubbed via `page.route`.
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "49019",
      address: "789 E2E Generate St, Moab, UT 84532",
      latitude: "38.573000",
      longitude: "-109.549400",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascade removes parcel_briefings + briefing_sources, which
    // matters here only because a future variant of this test that
    // exercises the real (non-stubbed) route would land rows.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("Generate Layers: POST → outcome panel + cache-invalidation re-renders the tier-grouped sources", async ({
  page,
}) => {
  // Stable ids so the per-source testid assertions can target them.
  // Real UUIDs are not required — `briefing-source-<id>` is a string
  // interpolation on `source.id` and the briefing wire never round-
  // trips through Zod here (we are the producer).
  const utahSourceId = "11111111-1111-1111-1111-111111111111";
  const grandSourceId = "22222222-2222-2222-2222-222222222222";
  const briefingId = "33333333-3333-3333-3333-333333333333";

  // Wire shapes mirror `EngagementBriefingSource` and
  // `EngagementBriefing` from `@workspace/api-client-react` — kept
  // inline rather than imported because the e2e tsconfig pulls a
  // stripped-down workspace surface and we do not want this spec to
  // depend on a new generated-types import path.
  const baseSource = {
    note: null,
    uploadObjectPath: null,
    uploadOriginalFilename: null,
    uploadContentType: null,
    uploadByteSize: null,
    dxfObjectPath: null,
    glbObjectPath: null,
    conversionStatus: null,
    conversionError: null,
    supersededAt: null,
    supersededById: null,
    snapshotDate: "2026-01-15T00:00:00.000Z",
    createdAt: "2026-01-15T00:00:00.000Z",
  } as const;
  const utahSource = {
    ...baseSource,
    id: utahSourceId,
    layerKind: "ugrc-parcels",
    sourceKind: "state-adapter",
    provider: "utah:ugrc-parcels (Utah Geospatial Resource Center)",
  };
  const grandSource = {
    ...baseSource,
    id: grandSourceId,
    layerKind: "grand-county-zoning",
    sourceKind: "local-adapter",
    provider: "grand-county-ut:zoning (Grand County GIS)",
  };
  const populatedBriefing = {
    id: briefingId,
    engagementId,
    createdAt: "2026-01-15T00:00:00.000Z",
    updatedAt: "2026-01-15T00:00:00.000Z",
    sources: [utahSource, grandSource],
  };

  // Mutable state the two route handlers share. The briefing GET
  // returns the empty envelope until the POST has fired — that's how
  // we prove the cache-invalidation refetch is what populates the
  // tier-grouped rows (vs. an unrelated render trigger).
  let briefingState: "empty" | "populated" = "empty";
  let postCount = 0;

  await page.route(
    `**/api/engagements/${engagementId}/briefing`,
    async (route) => {
      // Be defensive — the same path could in theory carry a method
      // we don't want to stub (e.g. CORS preflights in the future).
      // Only intercept the GET; everything else falls through to the
      // real API.
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          briefingState === "empty"
            ? { briefing: null }
            : { briefing: populatedBriefing },
        ),
      });
    },
  );

  await page.route(
    `**/api/engagements/${engagementId}/generate-layers`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      postCount += 1;
      // Flip the GET stub *before* fulfilling the POST: the
      // mutation's `onSuccess` immediately invalidates the briefing
      // key, which kicks off the refetch in the same microtask. If
      // we flipped after `fulfill()` resolved we would race the
      // refetch handler.
      briefingState = "populated";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          briefing: populatedBriefing,
          outcomes: [
            {
              adapterKey: "utah:ugrc-parcels",
              tier: "state",
              sourceKind: "state-adapter",
              layerKind: "ugrc-parcels",
              status: "ok",
              error: null,
              sourceId: utahSourceId,
            },
            {
              adapterKey: "grand-county-ut:zoning",
              tier: "local",
              sourceKind: "local-adapter",
              layerKind: "grand-county-zoning",
              status: "ok",
              error: null,
              sourceId: grandSourceId,
            },
            {
              // A no-coverage outcome so the per-adapter panel
              // renders the third status branch the wire enum
              // permits — proves the FE doesn't filter out
              // non-OK rows from the outcomes array.
              adapterKey: "utah:tax-parcels",
              tier: "state",
              sourceKind: "state-adapter",
              layerKind: "ut-tax-parcels",
              status: "no-coverage",
              error: {
                code: "no-coverage",
                message: "parcel outside coverage",
              },
              sourceId: null,
            },
          ],
        }),
      });
    },
  );

  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // Pre-condition: the briefing read returned `{ briefing: null }`,
  // so neither tier group should be rendered. Asserting the absence
  // up-front means the post-click assertion is unambiguous about
  // *why* the tier groups appeared.
  await expect(page.getByTestId("briefing-sources-tier-state")).toHaveCount(0);
  await expect(page.getByTestId("briefing-sources-tier-local")).toHaveCount(0);
  await expect(page.getByTestId("generate-layers-outcomes")).toHaveCount(0);

  // Task #232 — the supported-jurisdictions disclosure must render
  // before any Generate Layers click. The empty-pilot banner only
  // appears after the 422 round-trip, so an architect on a non-
  // pilot project would otherwise hit a dead-end before discovering
  // the supported set is systemically narrow. Iterating
  // `PILOT_JURISDICTIONS` here pins the visible labels to the same
  // registry the empty-pilot banner consumes — a future drift
  // between the two surfaces breaks this assertion instead of
  // hiding behind stale copy.
  const preClickSupported = page.getByTestId(
    "generate-layers-supported-jurisdictions",
  );
  await expect(preClickSupported).toBeVisible();
  await expect(
    page.getByTestId("generate-layers-supported-jurisdictions-summary"),
  ).toContainText(`Supported jurisdictions (${PILOT_JURISDICTIONS.length})`);
  // Expand the disclosure so the per-label list is visible (and
  // not just present in the DOM behind the closed `<details>`).
  await page
    .getByTestId("generate-layers-supported-jurisdictions-summary")
    .click();
  const preClickSupportedList = page.getByTestId(
    "generate-layers-supported-jurisdictions-list",
  );
  await expect(preClickSupportedList).toBeVisible();
  for (const j of PILOT_JURISDICTIONS) {
    await expect(preClickSupportedList).toContainText(j.label);
  }

  const button = page.getByTestId("generate-layers-button");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("Generate Layers");

  await button.click();

  // Per-adapter outcome panel renders one row per wire outcome with
  // the correct status text. We scope each assertion to its own
  // testid so a re-ordering of the `outcomes` array (the FE preserves
  // wire order) cannot satisfy the wrong row.
  const outcomes = page.getByTestId("generate-layers-outcomes");
  await expect(outcomes).toBeVisible();
  await expect(
    page.getByTestId("generate-layers-outcome-utah:ugrc-parcels"),
  ).toContainText("ok");
  await expect(
    page.getByTestId("generate-layers-outcome-grand-county-ut:zoning"),
  ).toContainText("ok");
  await expect(
    page.getByTestId("generate-layers-outcome-utah:tax-parcels"),
  ).toContainText("no-coverage");

  // Cache-invalidation refetch landed: tier-grouped rows render under
  // the state + local headers (the `state-adapter` source bucketed
  // into `state`, the `local-adapter` source into `local`), and each
  // per-source row exposes its own testid.
  await expect(page.getByTestId("briefing-sources-tier-state")).toBeVisible();
  await expect(page.getByTestId("briefing-sources-tier-local")).toBeVisible();
  const utahRow = page.getByTestId(`briefing-source-${utahSourceId}`);
  const grandRow = page.getByTestId(`briefing-source-${grandSourceId}`);
  await expect(utahRow).toBeVisible();
  await expect(grandRow).toBeVisible();

  // Adapter-tier pill mirrors the wire `sourceKind`: a state-adapter
  // row reads "State adapter", a local-adapter row reads "Local
  // adapter". The previous code path collapsed both onto the
  // "Federal adapter" label, so this guards against regressing to
  // that mislabel now that the View-layer-details panel below the
  // pill exposes adapter-tier-specific content.
  await expect(utahRow).toContainText("State adapter");
  await expect(utahRow).not.toContainText("Federal adapter");
  await expect(grandRow).toContainText("Local adapter");
  await expect(grandRow).not.toContainText("Federal adapter");

  // Sanity: the mutation fired exactly once. A regression that
  // dropped `disabled={generateMutation.isPending}` (or that wired
  // the click handler twice) would otherwise slip past the
  // assertions above because both POSTs would still produce the
  // same final UI.
  expect(postCount).toBe(1);
});

/**
 * Companion case for Task #177: the same Site Context tab, but the
 * POST returns a structured 422 `no_applicable_adapters` envelope
 * (the response shape the route emits for engagements outside the
 * three pilot jurisdictions). We seed a Boulder CO engagement so the
 * scenario reads naturally even though the route is fully stubbed,
 * then assert that
 *
 *   - the generic `generate-layers-error` alert does NOT render —
 *     surfacing the raw `no_applicable_adapters` slug as an upstream
 *     failure was the bug the task was opened to fix;
 *   - the new `generate-layers-no-adapters-banner` renders with the
 *     server's human-readable `message` so an architect immediately
 *     understands the cause is "this jurisdiction is not in the pilot
 *     yet" rather than a transient outage;
 *   - clicking the banner's CTA opens the existing
 *     `BriefingSourceUploadModal` (asserted by the layer-kind select
 *     control the modal owns). That proves the dead-end is actionable
 *     instead of confusing.
 */
test("Generate Layers: 422 no_applicable_adapters renders the empty-pilot banner with a working upload CTA", async ({
  page,
}) => {
  // Reuse the same engagement seeded in beforeAll — the FE wiring
  // doesn't read jurisdiction from the seeded row to decide which
  // banner to render (the server response is the single source of
  // truth), so a Moab engagement is just as good as a Boulder one
  // for stubbing the 422. Keeping a single seed also keeps the test
  // file from doubling its DB churn.
  let postCount = 0;

  await page.route(
    `**/api/engagements/${engagementId}/briefing`,
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      // Briefing stays empty throughout — the 422 path never persists
      // any sources, so the briefing read after the failed POST is
      // identical to the read before it. Asserting that the tier
      // groups never appear is part of how we confirm the server's
      // response was treated as an error, not a successful run with
      // zero outcomes.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ briefing: null }),
      });
    },
  );

  const serverMessage =
    'No adapters configured for jurisdiction "CO" / "boulder".';

  await page.route(
    `**/api/engagements/${engagementId}/generate-layers`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      postCount += 1;
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: "no_applicable_adapters",
          message: serverMessage,
        }),
      });
    },
  );

  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // Pre-condition: neither banner is up before the click.
  await expect(
    page.getByTestId("generate-layers-no-adapters-banner"),
  ).toHaveCount(0);
  await expect(page.getByTestId("generate-layers-error")).toHaveCount(0);

  await page.getByTestId("generate-layers-button").click();

  // The new empty-pilot banner is the only banner that should render.
  // The generic `generate-layers-error` alert MUST stay absent — that
  // was the bug: the architect on a non-pilot project saw the raw
  // `no_applicable_adapters` slug there and could not tell the cause
  // apart from a real upstream failure.
  const banner = page.getByTestId("generate-layers-no-adapters-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    "No adapters configured for this jurisdiction yet",
  );
  await expect(
    page.getByTestId("generate-layers-no-adapters-message"),
  ).toContainText(serverMessage);
  // Task #188 — the banner now also surfaces the actual pilot
  // jurisdictions so an architect on a non-pilot project (Boulder
  // CO in the message above) immediately sees the supported set
  // without leaving the page. The list is sourced from the same
  // `@workspace/adapters` registry the server's `appliesTo` gate
  // filters on, so iterating `PILOT_JURISDICTIONS` here pins the
  // visible set to the registry — a future drift between the two
  // breaks this test instead of hiding behind stale copy.
  const supported = page.getByTestId(
    "generate-layers-no-adapters-supported",
  );
  await expect(supported).toBeVisible();
  await expect(supported).toContainText("Currently supported:");
  for (const j of PILOT_JURISDICTIONS) {
    await expect(supported).toContainText(j.label);
  }
  await expect(banner).toContainText(
    "Upload a QGIS overlay below to seed the briefing manually.",
  );
  await expect(page.getByTestId("generate-layers-error")).toHaveCount(0);

  // The briefing read still returns no sources, so neither tier
  // group should have rendered as a side effect.
  await expect(page.getByTestId("briefing-sources-tier-state")).toHaveCount(0);
  await expect(page.getByTestId("briefing-sources-tier-local")).toHaveCount(0);
  await expect(page.getByTestId("generate-layers-outcomes")).toHaveCount(0);

  // Clicking the CTA opens the BriefingSourceUploadModal. The modal
  // has no top-level testid; its `briefing-source-layer-kind` select
  // is the cleanest proof of mounting because that id is unique to
  // the modal subtree.
  await expect(page.locator("#briefing-source-layer-kind")).toHaveCount(0);
  await page.getByTestId("generate-layers-no-adapters-upload").click();
  await expect(page.locator("#briefing-source-layer-kind")).toBeVisible();

  // Sanity: only one POST fired. A regression that double-fires the
  // mutation (e.g. by dropping `disabled={isPending}`) would still
  // show the banner once but bump postCount above 1.
  expect(postCount).toBe(1);
});

/**
 * Pre-flight pilot-eligibility e2e (Task #189).
 *
 * Companion case for the proactive empty-pilot banner. The earlier
 * spec above stubs the POST so the 422 envelope still fires; this
 * one seeds an out-of-pilot engagement (Boulder CO) and asserts that
 *
 *   - the empty-pilot banner is up before any click — the
 *     `appliesTo` gate runs client-side from the cached engagement
 *     record and shares its source-of-truth with `generateLayers.ts`
 *     through `@workspace/adapters/eligibility`, so the FE pre-flight
 *     produces the same verdict the server's 422 would have without
 *     the wasted round-trip;
 *   - the Generate Layers button is `disabled` and carries the same
 *     human-readable message as a `title` tooltip;
 *   - clicking the button does NOT fire a POST (a `page.route`
 *     handler is registered to count any request that slips through
 *     and assert it stays at zero);
 *   - clicking the banner's CTA opens the existing
 *     `BriefingSourceUploadModal`, proving the dead-end is
 *     immediately recoverable.
 *
 * A dedicated Boulder seed mirrors the Moab one above — the FE wiring
 * reads the city/state columns to make its pre-flight decision, so a
 * Boulder seed is the only honest way to exercise the "out of pilot"
 * branch in a real round-trip.
 */
test.describe("Generate Layers pre-flight (Task #189)", () => {
  let outOfPilotEngagementId = "";

  test.beforeAll(async () => {
    const [eng] = await db
      .insert(engagements)
      .values({
        name: `e2e Pre-flight Boulder ${RUN_TAG}`,
        nameLower: `e2e pre-flight boulder ${RUN_TAG}`.toLowerCase(),
        // Boulder CO — outside every DA-PI-4 pilot jurisdiction.
        // The FE resolver consults `jurisdictionCity` /
        // `jurisdictionState` first so these columns alone are
        // enough for the pre-flight gate to pick "out of pilot"
        // even before the address scan kicks in.
        jurisdiction: "Boulder, CO",
        jurisdictionCity: "Boulder",
        jurisdictionState: "CO",
        jurisdictionFips: "08013",
        address: "100 Walnut St, Boulder, CO 80302",
        latitude: "40.014984",
        longitude: "-105.270546",
        status: "active",
      })
      .returning();
    if (!eng) throw new Error("seed: out-of-pilot engagement returned no row");
    outOfPilotEngagementId = eng.id;
  });

  test.afterAll(async () => {
    if (outOfPilotEngagementId) {
      await db
        .delete(engagements)
        .where(eq(engagements.id, outOfPilotEngagementId));
    }
  });

  test("disables Generate Layers + renders the proactive banner with a working upload CTA for an out-of-pilot engagement", async ({
    page,
  }) => {
    // Stub both endpoints so the test is independent of any real
    // server response. The briefing GET keeps the engagement empty
    // (the proactive banner does not depend on briefing state). The
    // generate-layers POST counts requests so we can prove the
    // disabled button never fires a round-trip.
    let postCount = 0;
    await page.route(
      `**/api/engagements/${outOfPilotEngagementId}/briefing`,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ briefing: null }),
        });
      },
    );
    await page.route(
      `**/api/engagements/${outOfPilotEngagementId}/generate-layers`,
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        postCount += 1;
        // If the disabled-button regression slips through and the
        // POST fires anyway, return the same 422 the route would
        // have so the rest of the page does not desync — the
        // postCount assertion below is what fails the test.
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: "no_applicable_adapters",
            message:
              'No adapters configured for jurisdiction "CO" / "Boulder".',
          }),
        });
      },
    );

    await page.goto(
      `/engagements/${outOfPilotEngagementId}?tab=site-context`,
    );

    // Proactive banner must be up *before* any click. The architect
    // sees the dead-end on tab open instead of after a wasted POST.
    const banner = page.getByTestId("generate-layers-no-adapters-banner");
    await expect(banner).toBeVisible();
    // Pre-flight message comes from the shared
    // `noApplicableAdaptersMessage` helper — Boulder resolves to no
    // `stateKey`, so the helper picks the "could not resolve a
    // pilot jurisdiction" copy. The same helper is invoked by the
    // server route's 422 envelope, so the FE pre-flight cannot
    // disagree with the BE.
    await expect(
      page.getByTestId("generate-layers-no-adapters-message"),
    ).toContainText(/Could not resolve a pilot jurisdiction/i);
    await expect(banner).toContainText(
      "No adapters configured for this jurisdiction yet",
    );
    await expect(banner).toContainText(
      "Upload a QGIS overlay below to seed the briefing manually.",
    );

    // Generate Layers button is disabled — the architect cannot
    // accidentally fire the wasted round-trip. Tooltip surfaces the
    // shared message so a hover reveals the cause without scrolling.
    const button = page.getByTestId("generate-layers-button");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute(
      "title",
      /Could not resolve a pilot jurisdiction/i,
    );

    // Trying to click the disabled button is a no-op; Playwright's
    // `force: true` bypasses the actionability check so we confirm
    // the React handler also short-circuits even if a stray click
    // event makes it through (e.g. via a future label-for binding).
    await button.click({ force: true }).catch(() => {});
    await expect(page.getByTestId("generate-layers-error")).toHaveCount(0);

    // Banner CTA opens the BriefingSourceUploadModal — the dead-end
    // is recoverable. Same anchor as the post-error variant: the
    // unique `briefing-source-layer-kind` id the modal owns.
    await expect(page.locator("#briefing-source-layer-kind")).toHaveCount(0);
    await page.getByTestId("generate-layers-no-adapters-upload").click();
    await expect(page.locator("#briefing-source-layer-kind")).toBeVisible();

    // Pin the no-round-trip contract: the disabled button + the
    // proactive gate must mean zero POSTs hit the route.
    expect(postCount).toBe(0);
  });
});
