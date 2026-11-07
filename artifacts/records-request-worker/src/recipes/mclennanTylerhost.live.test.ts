/**
 * McLennan Tyler self-service live grading (P-113 CP2).
 *
 * Operator run — one graded McLennan parcel-context job (owner-name search;
 * parcelKey is job-threading context only, matching the existing Bastrop/
 * Williamson live-grading convention where the search itself is owner-name
 * based and not parcel-specific — it is NOT asserted as a verified McLennan
 * CAD account number):
 *
 * 1. From repo root: `cd artifacts/records-request-worker && pnpm install`
 * 2. Ensure Playwright Chromium is installed: `pnpm exec playwright install chromium`
 * 3. Run live test (hits production portal — do not run in CI):
 *    `pnpm exec vitest run src/recipes/mclennanTylerhost.live.test.ts`
 * 4. Grade pass criteria on `records_request_jobs.scope_searched`:
 *    - `mode` === `"index-search"`
 *    - `portalId` === `"mclennan-online-records"`
 *    - `recipeVersion` === `"p85-tyler-self-service-v2"` (shared Tyler self-service code constant)
 *    - `stepsReached` includes `open-disclaimer`, `open-search-surface`, `fill-owner-query`, `submit-search`
 *    - `captures[0].sha256` is a 64-char hex digest
 *    - Terminal status in `complete`, `needs-human`, or `awaiting-purchase-approval`
 * 5. If `loginRequired` or `captchaRequired`, portal session/challenge wall — retry headed or clerk path.
 *
 * Ground truth (verified live 2026-09-03): "BAYLOR UNIVERSITY" resolves 1,706
 * real records on this portal. The shared row extractor (built for
 * RadGrid/table markup) does not yet recognize McLennan's div/listview
 * results panel, so the honest outcome here is `needs-human` /
 * `index-hit-extraction-unsupported` with `portalDeclaredResultCount: 1706`
 * on scope — NOT a fabricated `complete` with 0 hits. See P-113 hardening in
 * searchPostProcess.ts. A future pass that teaches the extractor this
 * vendor's markup would turn this into `complete` with real hits; that is
 * tracked as an open item, not silently assumed done here.
 */

import { describe, expect, it } from "vitest";
import { withPlaywrightBrowser } from "../playwrightBrowser.js";
import { runRecipeForJob } from "./index.js";
import type { RecordsRecipeContext } from "./types.js";

const MCLENNAN_GRADING_PARCEL: RecordsRecipeContext = {
  jobId: "job-mclennan-live-grade",
  countyFips: "48309",
  parcelKey: "apn:48309:live-grading",
  portalId: "mclennan-online-records",
  requestPayload: {
    searchTerms: {
      ownerName: "BAYLOR UNIVERSITY",
    },
  },
};

describe("McLennan Tyler self-service live search (network)", () => {
  it("runs index-search for BAYLOR UNIVERSITY on the real DOCSEARCH402S1 surface", async () => {
    const result = await withPlaywrightBrowser((browser) =>
      runRecipeForJob(MCLENNAN_GRADING_PARCEL, browser),
    );
    // eslint-disable-next-line no-console
    console.log("live result", JSON.stringify(result, null, 2));

    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.portalId).toBe("mclennan-online-records");
    // The shared Tyler self-service code constant, not the p85Portals.ts
    // config label (which is p85-mclennan-tylerhost-v1) — the same
    // distinction already holds for Hays (see tylerSelfServiceSearch.ts).
    expect(result.scopeSearched?.recipeVersion).toBe("p85-tyler-self-service-v2");

    const captures = result.scopeSearched?.captures as
      | Array<{ sha256?: string }>
      | undefined;
    if (captures && captures.length > 0) {
      expect(captures[0]?.sha256).toMatch(/^[a-f0-9]{64}$/i);
    }

    expect(
      ["complete", "needs-human", "awaiting-purchase-approval"].includes(
        result.status,
      ),
    ).toBe(true);

    // Ground truth as of 2026-09-03: BAYLOR UNIVERSITY has real records on
    // this portal (1,706, verified by direct DOM read outside the recipe).
    // If the extractor cannot parse McLennan's grid, the honest outcome is
    // this refuse — never a silent complete/zero. If a future extractor
    // update recognizes this vendor's markup, this becomes `complete` with
    // real indexHits and this assertion should be revisited then, not
    // loosened preemptively now.
    if (result.status === "needs-human") {
      expect(result.errorCode).toBe("index-hit-extraction-unsupported");
      expect(
        (result.scopeSearched?.portalDeclaredResultCount as number | undefined) ?? 0,
      ).toBeGreaterThan(0);
    }
  }, 120_000);
});
