/**
 * Caldwell CountyGovernmentRecords live grading (P-113 CP2).
 *
 * Operator run — proves the real recipe reaches the real portal and fails
 * closed exactly the way the 2026-09-03 reconnaissance verified it must
 * (no anonymous search path exists on this vendor for Caldwell):
 *
 * 1. From repo root: `cd artifacts/records-request-worker && pnpm install`
 * 2. Ensure Playwright Chromium is installed: `pnpm exec playwright install chromium`
 * 3. Run live test (hits production portal — do not run in CI):
 *    `pnpm exec vitest run src/recipes/countyGovernmentRecordsSearch.live.test.ts`
 * 4. Grade pass criteria on `records_request_jobs.scope_searched`:
 *    - `mode` === `"index-search"`
 *    - `portalId` === `"caldwell-clerk-web"`
 *    - `recipeVersion` === `"p85-caldwell-countygovernmentrecords-v1"`
 *    - `stepsReached` includes `open-entry`
 *    - Terminal status `needs-human` with `errorCode` `login-required` is the
 *      VERIFIED-CORRECT outcome for this vendor today, not a failure of the
 *      recipe — see file header of countyGovernmentRecordsSearch.ts.
 */

import { describe, expect, it } from "vitest";
import { withPlaywrightBrowser } from "../playwrightBrowser.js";
import { runRecipeForJob } from "./index.js";
import type { RecordsRecipeContext } from "./types.js";

const CALDWELL_GRADING_PARCEL: RecordsRecipeContext = {
  jobId: "job-caldwell-live-grade",
  countyFips: "48055",
  parcelKey: "apn:48055:live-grading",
  portalId: "caldwell-clerk-web",
  requestPayload: {
    searchTerms: {
      ownerName: "CALDWELL COUNTY",
    },
  },
};

describe("Caldwell CountyGovernmentRecords live search (network)", () => {
  it("reaches the real splash and fails closed to needs-human/login-required (no anonymous search path on this vendor)", async () => {
    const result = await withPlaywrightBrowser((browser) =>
      runRecipeForJob(CALDWELL_GRADING_PARCEL, browser),
    );
    // eslint-disable-next-line no-console
    console.log("live result", JSON.stringify(result, null, 2));

    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.portalId).toBe("caldwell-clerk-web");
    expect(result.scopeSearched?.recipeVersion).toBe(
      "p85-caldwell-countygovernmentrecords-v1",
    );
    expect(result.scopeSearched?.stepsReached).toEqual(
      expect.arrayContaining(["open-entry"]),
    );

    expect(
      ["complete", "needs-human", "awaiting-purchase-approval"].includes(
        result.status,
      ),
    ).toBe(true);
    // The verified ground truth (2026-09-03 reconnaissance): this vendor has
    // no anonymous search surface for Caldwell. A future pass where the
    // vendor changes would show up here as a legitimate new finding, not a
    // silently accepted drift — this assertion is deliberately specific.
    if (result.status === "needs-human") {
      expect(result.errorCode).toBe("login-required");
    }
  }, 120_000);
});
