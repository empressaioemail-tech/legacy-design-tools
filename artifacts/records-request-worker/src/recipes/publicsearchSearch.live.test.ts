/**
 * Williamson publicsearch.us live grading (P-85 W1 item 5 partial).
 *
 * Operator run — one graded Williamson parcel (apn:48491:R062578):
 *
 * 1. From repo root: `cd artifacts/records-request-worker && pnpm install`
 * 2. Ensure Playwright Chromium is installed: `pnpm exec playwright install chromium`
 * 3. Run live test (hits production portal — do not run in CI):
 *    `pnpm exec vitest run src/recipes/publicsearchSearch.live.test.ts`
 * 4. Optional: set `DATABASE_URL` and enqueue a real job via api-server, then:
 *    `RECORDS_REQUEST_JOB_ID=<uuid> DATABASE_URL=... pnpm start`
 * 5. Grade pass criteria on `records_request_jobs.scope_searched`:
 *    - `mode` === `"index-search"`
 *    - `portalId` === `"williamson-publicsearch"`
 *    - `recipeVersion` === `"p85-publicsearch-v1"`
 *    - `stepsReached` includes `open-entry`, `open-portal`, `fill-owner-query`, `submit-search`
 *    - `captures[0].sha256` is a 64-char hex digest (non-empty results page capture)
 *    - `queries[0].kind` === `"owner-name"` with query matching CAD owner
 *    - Terminal status in `complete`, `needs-human`, or `awaiting-purchase-approval`
 * 6. If status is `needs-human` with `loginRequired`, portal session wall — retry headed or clerk path.
 * 7. If `indexHits` populated, verify `resultCount` matches hit count before acquisition leg.
 */

import { describe, expect, it } from "vitest";
import { withPlaywrightBrowser } from "../playwrightBrowser.js";
import { runRecipeForJob } from "./index.js";
import { WILLIAMSON_GRADING_PARCEL } from "./publicsearchSearch.js";

describe("Williamson publicsearch live search (network)", () => {
  it("runs index-search for grading parcel R062578 / PURVIS MICHAEL", async () => {
    const result = await withPlaywrightBrowser((browser) =>
      runRecipeForJob(WILLIAMSON_GRADING_PARCEL, browser),
    );
    if (result.status !== "complete") {
      console.log("live result", JSON.stringify(result, null, 2));
    }

    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.portalId).toBe("williamson-publicsearch");
    expect(result.scopeSearched?.recipeVersion).toBe("p85-publicsearch-v1");
    expect(result.scopeSearched?.parcelKey).toBe("apn:48491:R062578");

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
  }, 120_000);
});
