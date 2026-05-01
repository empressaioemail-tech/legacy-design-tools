/**
 * End-to-end regression test for the DA-PI-6 "Export PDF" button on
 * the engagement detail page (Task #323).
 *
 * Why this test exists: the PDF export route
 * (`GET /api/engagements/:id/briefing/export.pdf`) has comprehensive
 * unit coverage in `api-server/src/__tests__/briefing-export-pdf.test.ts`
 * (status codes, headers, %PDF magic, %%EOF trailer, byte size, header
 * override) and the "Export PDF" anchor has rendering coverage in the
 * design-tools component tests, but nothing currently exercises the
 * full integration:
 *
 *   1. The button is rendered enabled when a briefing narrative exists,
 *   2. clicking it opens the route URL in a new tab,
 *   3. that tab actually receives an `application/pdf` response with
 *      well-formed bytes (so a route URL that drifted from the FE href
 *      — e.g. someone renaming `export.pdf` to `export-pdf` — is caught
 *      by CI),
 *   4. when no narrative exists, the button renders in its disabled
 *      state and a click cannot navigate to the export endpoint.
 *
 * Strategy:
 *   - Insert two engagements via `@workspace/db` so the test owns
 *     known ids: one with a fully-generated A–G briefing on file
 *     (`generatedAt` stamped + every `section_*` populated), one with
 *     no briefing at all. Mirrors the seeding pattern already used by
 *     `briefing-citation-pills.spec.ts` and
 *     `recent-runs-deep-link.spec.ts`.
 *   - For the enabled flow: click the button, wait for the new tab
 *     (`popup` event), and read the response of the navigation. That
 *     response is what the user actually sees, so asserting on its
 *     status / content-type / body bytes pins the *integrated*
 *     contract — a route rename, a missing `target="_blank"`, or a
 *     proxy mis-route would all surface here even though every
 *     individual layer's unit test still passes.
 *   - For the disabled flow: assert the anchor exposes the disabled
 *     affordance (no href, `aria-disabled="true"`, the explanatory
 *     tooltip), then click it and confirm that *no* popup is opened
 *     within a short window — proves the `onClick` preventDefault
 *     plus `pointer-events: none` style guard actually neutralizes
 *     the navigation.
 *
 * Cleanup: `afterAll` deletes both seeded engagements; the FK on
 * `parcel_briefings.engagement_id` is `ON DELETE CASCADE`, so the
 * briefing rows disappear with their engagement.
 */

import { test, expect, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db, engagements, parcelBriefings } from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME_GENERATED = `e2e PDF Export Generated ${RUN_TAG}`;
const TEST_PROJECT_NAME_EMPTY = `e2e PDF Export Empty ${RUN_TAG}`;

let generatedEngagementId = "";
let emptyEngagementId = "";

test.beforeAll(async () => {
  // Engagement #1: fully-generated A–G briefing on file. The route
  // gates on `briefing.generatedAt`, so we stamp that explicitly
  // alongside non-empty section bodies. We don't need a
  // `briefing_generation_jobs` row for this — the route's projection
  // surfaces `generationId` as null on legacy rows and the renderer
  // handles that case explicitly (see briefing-export-pdf.test.ts).
  const [engGenerated] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME_GENERATED,
      nameLower: TEST_PROJECT_NAME_GENERATED.toLowerCase(),
      jurisdiction: "Boulder, CO",
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
      jurisdictionFips: "08013",
      address: "123 PDF Export Ave, Boulder, CO 80301",
      status: "active",
      latitude: "40.014984",
      longitude: "-105.270546",
    })
    .returning();
  if (!engGenerated)
    throw new Error("seed: generated-engagement insert returned no row");
  generatedEngagementId = engGenerated.id;

  await db
    .insert(parcelBriefings)
    .values({
      engagementId: generatedEngagementId,
      sectionA:
        "Executive summary — buildable thesis for the test parcel under e2e fixtures.",
      sectionB: "Threshold issues — flood zone exposure requires elevation review.",
      sectionC: "Regulatory gates — base zoning caps height at 35 ft.",
      sectionD: "Site infrastructure — water main on the east lot line confirmed.",
      sectionE: "Buildable envelope — derived from the parcel polygon.",
      sectionF: "Neighboring context — adjacent parcels are mid-block residential.",
      sectionG: "Next-step checklist — order soils test, schedule pre-app meeting.",
      generatedAt: new Date("2026-04-15T12:00:00Z"),
      generatedBy: "system:e2e-test",
    });

  // Engagement #2: no briefing row at all → the FE renders the
  // "Export PDF" button in its disabled state. We don't need to
  // insert a parcelBriefings row here; the engagement is enough for
  // the page to load and surface the disabled button.
  const [engEmpty] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME_EMPTY,
      nameLower: TEST_PROJECT_NAME_EMPTY.toLowerCase(),
      jurisdiction: "Boulder, CO",
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
      jurisdictionFips: "08013",
      address: "456 PDF Export Ave, Boulder, CO 80301",
      status: "active",
    })
    .returning();
  if (!engEmpty)
    throw new Error("seed: empty-engagement insert returned no row");
  emptyEngagementId = engEmpty.id;
});

test.afterAll(async () => {
  // Cascades through parcel_briefings (and any downstream rows we
  // happened to mint), so a single engagement delete clears the seed
  // graph for both fixtures.
  if (generatedEngagementId) {
    await db.delete(engagements).where(eq(engagements.id, generatedEngagementId));
  }
  if (emptyEngagementId) {
    await db.delete(engagements).where(eq(engagements.id, emptyEngagementId));
  }
});

/**
 * Open the engagement page on the Site Context tab and wait for the
 * Export PDF button to mount. Centralised so both tests agree on the
 * landing tab and don't race the briefing query.
 */
async function openEngagementSiteContext(
  page: Page,
  engagementId: string,
): Promise<void> {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);
  await expect(page.getByTestId("briefing-export-pdf-button")).toBeVisible();
}

test("clicking Export PDF on a generated briefing opens a new tab that renders an application/pdf response", async ({
  page,
}) => {
  // Puppeteer cold-start + the synchronous PDF render together can
  // take 30-60s on first invocation (the API server lazily launches
  // a single shared browser; subsequent renders reuse it). The
  // suite-wide default timeout in `playwright.config.ts` is 30s,
  // which is fine for purely-FE flows but blows up here. The unit
  // test that exercises the same Puppeteer pipeline
  // (`briefing-export-pdf.test.ts`) uses the same 60s ceiling.
  test.setTimeout(90_000);

  await openEngagementSiteContext(page, generatedEngagementId);

  const exportLink = page.getByTestId("briefing-export-pdf-button");
  // Sanity: the enabled button carries the export href and the
  // "opens in a new tab" tooltip — proves the FE branch under test
  // is the `hasNarrative` branch and not the disabled one.
  await expect(exportLink).toHaveAttribute(
    "href",
    new RegExp(
      `/api/engagements/${generatedEngagementId}/briefing/export\\.pdf$`,
    ),
  );
  await expect(exportLink).toHaveAttribute("target", "_blank");
  await expect(exportLink).toHaveAttribute(
    "title",
    /Render the current A–G briefing as a stakeholder PDF/,
  );

  // Set up the context-level response wait *before* clicking. Two
  // reasons:
  //
  //   1. Race: `target="_blank"` opens the popup and immediately
  //      starts navigating to the URL. By the time
  //      `page.waitForEvent("popup")` resolves and we attach a
  //      `popup.waitForResponse(...)` listener, a hot-puppeteer
  //      render (~5-10s) may already have completed and the
  //      response event is gone. A context-level listener captures
  //      the response regardless of which page it landed on.
  //   2. Chromium serves `application/pdf` responses through its
  //      built-in PDF viewer in popups, which can swallow the
  //      page-level response event in headless mode. The
  //      context-level listener bypasses that quirk by hooking into
  //      the network layer directly.
  //
  // The predicate scopes the match to *this* engagement's export
  // URL so the listener only fires for the route under test.
  const responsePromise = page.context().waitForEvent("response", {
    predicate: (r) =>
      r.url().endsWith(
        `/api/engagements/${generatedEngagementId}/briefing/export.pdf`,
      ),
    timeout: 75_000,
  });

  // We still want to assert that the click really did spawn a new
  // tab — that's the integration this test was added to pin —
  // hence the parallel popup wait. The popup.close() at the end
  // also keeps test isolation clean.
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 15_000 }),
    exportLink.click(),
  ]);

  const response = await responsePromise;

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  // Default disposition is `inline`; `?download=1` is what flips it
  // to `attachment`. The button does not pass `?download=1`, so
  // pinning `inline` here catches a regression where the FE starts
  // sending a query string the route then 400s on.
  expect(response.headers()["content-disposition"]).toContain("inline");

  // Close the popup before we re-fetch the bytes — Chromium's
  // built-in PDF viewer in the popup consumes the response body
  // buffer as it renders, so `response.body()` on the popup's
  // navigation response throws
  // `Network.getResponseBody: No resource with given identifier`.
  // We've already verified the click→popup→PDF-route flow above
  // (status, content-type, content-disposition all came from the
  // click-triggered request); here we re-issue an out-of-band
  // request through Playwright's APIRequest to get the raw bytes
  // and assert PDF integrity.
  await popup.close();

  const bytesResponse = await page.request.get(
    `/api/engagements/${generatedEngagementId}/briefing/export.pdf`,
  );
  expect(bytesResponse.status()).toBe(200);
  expect(bytesResponse.headers()["content-type"]).toContain("application/pdf");

  const body = await bytesResponse.body();
  // Same shape the unit test asserts (`api-server/.../briefing-export-pdf.test.ts`):
  // %PDF- magic at the start, %%EOF trailer near the end, and a
  // non-trivial body — Puppeteer-emitted PDFs print to several KB
  // even for a small briefing, so anything below ~3 KB would mean
  // the renderer silently emitted an empty document.
  expect(body.length).toBeGreaterThan(3_000);
  expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(body.subarray(body.length - 8).toString("ascii")).toContain("%%EOF");
});

test("Export PDF renders disabled with an explanatory tooltip and cannot navigate when no narrative exists", async ({
  page,
}) => {
  await openEngagementSiteContext(page, emptyEngagementId);

  const exportLink = page.getByTestId("briefing-export-pdf-button");
  // Disabled affordance: no href (the FE branches `hasNarrative ?
  // url : undefined`), aria-disabled="true", and the "generate
  // first" tooltip copy. All three together pin the disabled
  // contract — flipping any one would suggest the gating logic
  // drifted.
  await expect(exportLink).not.toHaveAttribute("href", /.+/);
  await expect(exportLink).toHaveAttribute("aria-disabled", "true");
  await expect(exportLink).toHaveAttribute(
    "title",
    /Generate the briefing first/,
  );

  // Belt-and-braces: a click must not open a new tab. The component
  // both `preventDefault`s in `onClick` and sets
  // `pointer-events: none` in `style`, so a regression in either
  // guard alone could leak through. Use `force: true` to bypass
  // Playwright's actionability so a `pointer-events: none`
  // regression would actually fire the click handler we're
  // testing.
  let popupOpened = false;
  page.context().once("page", () => {
    popupOpened = true;
  });
  await exportLink.click({ force: true });
  // Give the browser a beat to actually open a tab if the guards
  // failed; 1s is plenty since `target="_blank"` opens are
  // synchronous on click.
  await page.waitForTimeout(1_000);
  expect(popupOpened).toBe(false);
});
