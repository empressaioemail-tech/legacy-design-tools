import { describe, expect, it } from "vitest";
import { withPlaywrightBrowser } from "../playwrightBrowser.js";
import { runRecipeForJob } from "./index.js";
import type { RecordsRecipeContext } from "./types.js";

const bastropCtx: RecordsRecipeContext = {
  jobId: "job-bastrop-live",
  countyFips: "48021",
  parcelKey: "apn:48021:34161",
  portalId: "bastrop-aumentum",
  requestPayload: {
    searchTerms: {
      ownerName: "DIOCESE OF AUSTIN",
    },
  },
};

describe("Bastrop Aumentum live search (network)", () => {
  it("finds index hits for Diocese of Austin grantor search", async () => {
    const result = await withPlaywrightBrowser((browser) =>
      runRecipeForJob(bastropCtx, browser),
    );
    if (result.status !== "complete") {
      console.log("live result", JSON.stringify(result, null, 2));
    }
    expect(result.scopeSearched?.mode).toBe("index-search");
    expect(result.scopeSearched?.resultCount).toBeGreaterThan(0);
    expect(
      (result.scopeSearched?.queries as Array<{ resultCount?: number }>)?.[0]
        ?.resultCount,
    ).toBeGreaterThan(0);
    expect(
      ["complete", "needs-human", "awaiting-purchase-approval"].includes(
        result.status,
      ),
    ).toBe(true);
  }, 120_000);
});
