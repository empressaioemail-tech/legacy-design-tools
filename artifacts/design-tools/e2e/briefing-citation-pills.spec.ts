/**
 * End-to-end regression test for the A–G briefing narrative citation
 * pill click → scroll-to-source → flash-highlight loop (Task #176).
 *
 * Why this test exists: the citation renderer
 * (`components/briefingCitations.tsx`) and the SiteContextTab wiring
 * that owns the highlight state both have unit coverage, but nothing
 * else exercises the integrated flow:
 *
 *   1. The narrative panel parses a section body containing a
 *      `{{atom|briefing-source|<id>|<label>}}` token,
 *   2. renders a clickable pill,
 *   3. SiteContextTab's `handleJumpToSource` runs scrollIntoView on
 *      the matching `BriefingSourceRow`, AND
 *   4. flips the row's `data-highlighted` flag for ~1.6s.
 *
 * A regression that breaks any seam — the renderer dropping the
 * onJump prop, SiteContextTab forgetting to pass `isHighlighted`
 * through, the row's outline style being keyed off the wrong prop —
 * would currently slip past CI.
 *
 * Strategy: insert a clean engagement, parcel briefing, and one
 * briefing source directly via `@workspace/db` so the test owns
 * known ids. Hand-write the section body so the inline citation
 * token's id matches the inserted source. Drive the UI through
 * Playwright: visit Site Context, expand the section, click the
 * pill, assert the row scrolls into view and `data-highlighted`
 * flips to "true". The test cleans up by deleting the engagement
 * (FK cascades remove the briefing + source rows).
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
const TEST_PROJECT_NAME = `e2e Citation Pills ${RUN_TAG}`;

let engagementId = "";
let sourceId = "";

test.beforeAll(async () => {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: TEST_PROJECT_NAME,
      nameLower: TEST_PROJECT_NAME.toLowerCase(),
      jurisdiction: "Boulder, CO",
      jurisdictionCity: "Boulder",
      jurisdictionState: "CO",
      jurisdictionFips: "08013",
      address: "789 E2E Citation Ave, Boulder, CO 80301",
      status: "active",
    })
    .returning();
  if (!eng) throw new Error("seed: engagement insert returned no row");
  engagementId = eng.id;

  // The briefing engine normally writes these columns, but for this
  // test we want a known section body containing a known source-id
  // citation token. We hand-write both rows in the same FK chain.
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({
      engagementId,
      generatedAt: new Date(),
      generatedBy: "system:e2e-test",
    })
    .returning();
  if (!briefing) throw new Error("seed: parcel briefing insert returned no row");

  const [source] = await db
    .insert(briefingSources)
    .values({
      briefingId: briefing.id,
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "E2E Citation Fixture",
      payload: { fixture: true },
      note: "Synthesized by briefing-citation-pills.spec.ts",
    })
    .returning();
  if (!source) throw new Error("seed: briefing source insert returned no row");
  sourceId = source.id;

  // Stamp section A with a body that contains the pipe-delimited
  // citation token pointing at the source we just inserted. Section
  // bodies are plain text columns the renderer parses at read time,
  // so writing the token directly is the same shape the engine would
  // produce. The label is what the pill renders as its visible text.
  await db
    .update(parcelBriefings)
    .set({
      sectionA: `Per the engagement's zoning overlay {{atom|briefing-source|${sourceId}|Boulder Zoning Map}} the parcel falls in district MU-3.`,
    })
    .where(eq(parcelBriefings.id, briefing.id));
});

test.afterAll(async () => {
  if (engagementId) {
    // Cascades through parcel_briefings → briefing_sources, so all
    // three rows the seed inserted disappear with the engagement.
    await db.delete(engagements).where(eq(engagements.id, engagementId));
  }
});

test("clicking a narrative citation pill scrolls to and highlights the matching source row", async ({
  page,
}) => {
  await page.goto(`/engagements/${engagementId}?tab=site-context`);

  // The source row renders inside the Briefing Sources list above
  // the narrative panel. Wait for it to mount before doing anything
  // else — the briefing query has to round-trip first.
  const row = page.getByTestId(`briefing-source-${sourceId}`);
  await expect(row).toBeVisible();
  // Sanity: the row starts in its un-highlighted state.
  await expect(row).not.toHaveAttribute("data-highlighted", "true");

  // Section A (Executive Summary) is *expanded by default* per
  // `defaultExpansion` in EngagementDetail — A and any non-empty
  // section B/E auto-open so the architect's eye lands on the
  // narrative without an extra click. The pill should already be
  // rendered without us toggling anything.
  const pill = page.getByTestId(`briefing-citation-pill-${sourceId}`);
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Boulder Zoning Map");

  // Click the pill and assert two outcomes:
  //   1. the source row picks up `data-highlighted="true"` (proves
  //      SiteContextTab.handleJumpToSource wired the highlight state
  //      back into BriefingSourceRow),
  //   2. the row is scrolled into the viewport center (proves
  //      `scrollToBriefingSource` ran against the right testid).
  // We assert on the highlight first because it's the React-state
  // signal the parent owns; the scroll happens on the next animation
  // frame.
  await pill.click();
  await expect(row).toHaveAttribute("data-highlighted", "true");
  await expect(row).toBeInViewport();

  // The highlight clears itself after ~1.6s — this confirms the
  // SiteContextTab timer effect cleans up so consecutive clicks on
  // different pills don't double-flash the same row indefinitely.
  await expect(row).not.toHaveAttribute("data-highlighted", "true", {
    timeout: 3_000,
  });
});
