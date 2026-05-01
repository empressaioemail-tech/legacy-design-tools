/**
 * End-to-end regression test for the federal-adapter "Copy summary"
 * button rendered inside the inline `BriefingSourceDetails` panel
 * (Task #210, button defined in
 * `artifacts/design-tools/src/components/BriefingSourceDetails.tsx`).
 *
 * Why this test exists: Task #210 unit-tested the markdown formatter
 * (`formatFederalSummaryMarkdown`) and the clipboard interaction in
 * isolation under `BriefingSourceDetails.test.tsx`, but no test walks
 * the button through the wire on a real engagement detail page. The
 * button could regress in any of these silent ways and slip past CI:
 *
 *   - if `EngagementDetail.BriefingSourceRow` stopped mounting
 *     `BriefingSourceDetails` (or the "View layer details" toggle
 *     stopped flipping the panel open), the button would no longer
 *     render even though the formatter still works;
 *   - if the `KindBody` switch dropped a federal `kind` branch (e.g.
 *     `flood-zone` → fell through to `RawPayload`), the
 *     `FederalSummaryGroup` wrapper would never mount and the button
 *     would silently disappear;
 *   - if the `CopySummaryButton` `onClick` started swallowing the
 *     promise rejection or the navigator clipboard call, the label
 *     would never flip to "Copied!" — invisible to a unit test that
 *     mocks `navigator.clipboard` but real to a reviewer using the
 *     button;
 *   - if a future change re-introduced the button on non-federal
 *     rows (local-adapter zoning, manual-upload), the formatter would
 *     return `null`, the button would suppress, but a regression
 *     could re-add it in a way that produces an empty markdown digest
 *     on click.
 *
 * Strategy:
 *
 *   1. Insert a clean Bastrop TX engagement directly via `@workspace/db`
 *      (matches the seed jurisdiction the sibling `federal-*` specs
 *      use). The engagement is removed in `afterAll`, FK-cascading the
 *      parcel_briefings + briefing_sources rows the seed inserts.
 *
 *   2. Insert one parent `parcel_briefings` row and three child
 *      `briefing_sources` rows directly in the DB:
 *
 *        - a federal-adapter FEMA NFHL flood-zone row (the "happy
 *          path" the button must render on);
 *        - a local-adapter zoning row (the closest non-federal sibling
 *          that still mounts `BriefingSourceDetails`, since the
 *          "View layer details" toggle gate is `sourceKind !==
 *          "manual-upload"`); and
 *        - a manual-upload zoning row (which never opens the details
 *          panel at all, so the button must not render in the DOM).
 *
 *      The FEMA row carries a pinned `snapshotDate` so the clipboard
 *      digest is byte-stable; a drifting snapshot would otherwise turn
 *      the assertion into a flake on day boundaries.
 *
 *   3. Drive the UI through Playwright with clipboard read/write
 *      permissions granted on the test context, then:
 *
 *        a. Open the engagement on the Site Context tab.
 *        b. Expand the federal-adapter row's details panel and assert
 *           the "Copy summary" button is visible.
 *        c. Click the button, assert the label flips to "Copied!",
 *           and read the clipboard back via `navigator.clipboard
 *           .readText()` — assert it byte-matches the markdown digest
 *           the formatter is contracted to produce. Reading the
 *           clipboard back (vs. just trusting the label flip) is what
 *           proves the wire seam between the button, the formatter,
 *           and the browser actually works end-to-end.
 *        d. Expand the local-adapter zoning row's details panel and
 *           assert the copy button is NOT in the DOM for that row.
 *        e. Assert the manual-upload row exposes no toggle at all
 *           (because `BriefingSourceRow` gates the toggle on
 *           `sourceKind !== "manual-upload"`) and that the copy
 *           button is not anywhere on the page for that row.
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  db,
  engagements,
  parcelBriefings,
  briefingSources,
} from "@workspace/db";

const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PROJECT_NAME = `e2e Federal Copy Summary ${RUN_TAG}`;

let engagementId = "";
let briefingId = "";
let femaSourceId = "";
let localZoningSourceId = "";
let manualUploadSourceId = "";

/**
 * Pinned snapshot date for the FEMA seed row so the clipboard
 * digest's `— snapshot YYYY-MM-DD` tail is byte-stable. The
 * formatter slices the first 10 chars of the ISO timestamp, so any
 * UTC instant within 2026-01-01 would do — we pick midnight UTC for
 * readability.
 */
const FEMA_SNAPSHOT_ISO = "2026-01-01T00:00:00.000Z";
const FEMA_EXPECTED_MARKDOWN =
  "**FEMA NFHL** — Zone AE, in SFHA, BFE 432 ft — snapshot 2026-01-01";

// Grant the test browser context permission to read AND write the
// system clipboard. Chromium gates `navigator.clipboard.writeText`
// behind the `clipboard-write` permission (granted by default for
// secure contexts but explicit here to defend against headless
// flakiness) and `readText` behind `clipboard-read` (NOT granted by
// default, required for the round-trip assertion).
test.use({
  permissions: ["clipboard-read", "clipboard-write"],
});

test.beforeAll(async () => {
  // 1. Seed the engagement. Bastrop, TX matches the sibling federal
  //    specs' jurisdiction so the seed shape stays consistent across
  //    the federal e2e suite.
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Bastrop, TX",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: "48021",
      address: "300 E2E Copy Summary St, Bastrop, TX 78602",
      latitude: "30.110500",
      longitude: "-97.318600",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // 2. Seed the parent parcel_briefings row.
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({ engagementId })
    .returning();
  if (!briefing) {
    throw new Error("seed: parcel_briefings insert returned no row");
  }
  briefingId = briefing.id;

  // 3. Seed the three briefing_sources rows. We insert them in one
  //    batch to keep the seed atomic; the per-(briefing, layerKind)
  //    unique index lets the rows coexist because every layerKind is
  //    distinct. The FEMA row's `snapshotDate` is pinned so the
  //    clipboard digest is byte-stable.
  const inserted = await db
    .insert(briefingSources)
    .values([
      {
        briefingId,
        layerKind: "fema-nfhl-flood-zone",
        sourceKind: "federal-adapter",
        provider: "FEMA National Flood Hazard Layer (NFHL)",
        snapshotDate: new Date(FEMA_SNAPSHOT_ISO),
        payload: {
          kind: "flood-zone",
          inSpecialFloodHazardArea: true,
          floodZone: "AE",
          zoneSubtype: null,
          baseFloodElevation: 432,
          features: [{ attributes: { FLD_ZONE: "AE" } }],
        },
        note: "Seeded by federal-copy-summary-button.spec.ts",
      },
      {
        briefingId,
        layerKind: "bastrop-tx-zoning",
        sourceKind: "local-adapter",
        provider: "bastrop-tx:zoning (Bastrop County GIS)",
        payload: {
          kind: "zoning",
          zoning: { attributes: { ZONING: "C-1", DISTRICT: "Commercial" } },
        },
        note: "Seeded by federal-copy-summary-button.spec.ts",
      },
      {
        briefingId,
        layerKind: "qgis-zoning",
        sourceKind: "manual-upload",
        provider: "Architect manual upload",
        payload: {
          kind: "zoning",
          zoning: { attributes: { ZONING: "R-1" } },
        },
        uploadObjectPath: "/objects/seed-copy-summary",
        uploadOriginalFilename: "zoning.geojson",
        uploadContentType: "application/geo+json",
        uploadByteSize: 1024,
        note: "Seeded by federal-copy-summary-button.spec.ts",
      },
    ])
    .returning({
      id: briefingSources.id,
      sourceKind: briefingSources.sourceKind,
      layerKind: briefingSources.layerKind,
    });
  for (const row of inserted) {
    if (
      row.sourceKind === "federal-adapter" &&
      row.layerKind === "fema-nfhl-flood-zone"
    ) {
      femaSourceId = row.id;
    } else if (row.sourceKind === "local-adapter") {
      localZoningSourceId = row.id;
    } else if (row.sourceKind === "manual-upload") {
      manualUploadSourceId = row.id;
    }
  }
  if (!femaSourceId || !localZoningSourceId || !manualUploadSourceId) {
    throw new Error(
      `seed: missing one of the seeded rows (fema=${femaSourceId}, local=${localZoningSourceId}, manual=${manualUploadSourceId})`,
    );
  }
});

test.afterAll(async () => {
  if (engagementId) {
    // FK cascade: engagement → parcel_briefings → briefing_sources.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("federal-adapter row exposes a Copy summary button that writes the markdown digest to the clipboard, and non-federal rows do not", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // Wait for the federal tier group to render so the briefing read
  // landed; without this the per-row assertions could race the
  // initial paint.
  const federalGroup = page.getByTestId("briefing-sources-tier-federal");
  await expect(federalGroup).toBeVisible();

  // ---- Federal-adapter row: button must render and copy the digest ----

  const femaRow = federalGroup.getByTestId(`briefing-source-${femaSourceId}`);
  await expect(femaRow).toBeVisible();

  // Open the inline "View layer details" panel — the button only
  // mounts inside `BriefingSourceDetails`, which is gated behind
  // this toggle. Pre-flight: the copy button is NOT in the DOM yet.
  await expect(
    femaRow.getByTestId(`briefing-source-copy-summary-${femaSourceId}`),
  ).toHaveCount(0);
  await femaRow
    .getByTestId(`briefing-source-details-toggle-${femaSourceId}`)
    .click();
  const femaDetails = femaRow.getByTestId(
    `briefing-source-details-${femaSourceId}`,
  );
  await expect(femaDetails).toBeVisible();

  // The button is rendered with the idle label.
  const copyButton = femaDetails.getByTestId(
    `briefing-source-copy-summary-${femaSourceId}`,
  );
  await expect(copyButton).toBeVisible();
  await expect(copyButton).toHaveText("Copy summary");

  // Click and assert the label flips to "Copied!" — proves the
  // `setState("copied")` branch ran (i.e. the clipboard write
  // resolved without throwing). The 1500ms revert-to-idle timer
  // means we have a comfortable assertion window before the label
  // flips back.
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied!");

  // Round-trip the clipboard: read what the browser actually wrote
  // and assert it byte-matches the formatter's contracted digest.
  // Doing this via `navigator.clipboard.readText` (vs. trusting the
  // label flip alone) is what proves the wire seam between the
  // button, the markdown formatter, and the system clipboard works
  // end-to-end. `clipboard-read` is the permission that gates this
  // call (granted via `test.use` above).
  const clipboardText = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(clipboardText).toBe(FEMA_EXPECTED_MARKDOWN);

  // ---- Local-adapter zoning row: details panel renders, button does not ----

  // Local-adapter rows are bucketed into the `local` tier, not the
  // federal one — scope the lookup to the page so the row resolves
  // even though it lives in a different tier group.
  const localRow = page.getByTestId(
    `briefing-source-${localZoningSourceId}`,
  );
  await expect(localRow).toBeVisible();
  await localRow
    .getByTestId(`briefing-source-details-toggle-${localZoningSourceId}`)
    .click();
  const localDetails = localRow.getByTestId(
    `briefing-source-details-${localZoningSourceId}`,
  );
  await expect(localDetails).toBeVisible();
  // The zoning `KindBody` branch does not render
  // `FederalSummaryGroup`, so the copy button must not appear under
  // this row's details panel even though the panel itself renders.
  await expect(
    localRow.getByTestId(
      `briefing-source-copy-summary-${localZoningSourceId}`,
    ),
  ).toHaveCount(0);

  // ---- Manual-upload row: no details toggle, no copy button anywhere ----

  const manualRow = page.getByTestId(
    `briefing-source-${manualUploadSourceId}`,
  );
  await expect(manualRow).toBeVisible();
  // The "View layer details" toggle is gated on
  // `sourceKind !== "manual-upload"` in `BriefingSourceRow`, so it
  // must not be present at all on the manual-upload row. Asserting
  // its absence pins the gate — a regression that mounted the
  // toggle (and therefore the details panel) for manual-upload rows
  // would also potentially mount the copy button against a
  // non-federal payload.
  await expect(
    manualRow.getByTestId(
      `briefing-source-details-toggle-${manualUploadSourceId}`,
    ),
  ).toHaveCount(0);
  // Belt-and-braces: the copy button is also not in the DOM for
  // this row anywhere on the page.
  await expect(
    page.getByTestId(
      `briefing-source-copy-summary-${manualUploadSourceId}`,
    ),
  ).toHaveCount(0);
});
