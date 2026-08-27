import { describe, expect, it, vi } from "vitest";
import {
  listRegisteredRecipes,
  resolvePortalIdForJob,
  runRecipeForJob,
} from "./index.js";
import { P85_DEFAULT_PORTAL_BY_COUNTY, P85_PORTALS } from "./p85Portals.js";
import type { RecordsRecipeBrowser, RecordsRecipeContext } from "./types.js";

describe("P-85 portal registry", () => {
  it("registers all six county default portals", () => {
    expect(listRegisteredRecipes()).toHaveLength(P85_PORTALS.length);
    for (const [county, portalId] of Object.entries(P85_DEFAULT_PORTAL_BY_COUNTY)) {
      expect(resolvePortalIdForJob(county, {})).toBe(portalId);
    }
  });

  it("honours explicit portalId in request payload", () => {
    expect(
      resolvePortalIdForJob("48491", { portalId: "williamson-publicsearch" }),
    ).toBe("williamson-publicsearch");
  });

  it("returns null for counties outside P-85", () => {
    expect(resolvePortalIdForJob("48141", {})).toBeNull();
  });
});

describe("runRecipeForJob — reachability scaffold", () => {
  const bastropCtx: RecordsRecipeContext = {
    jobId: "job-bastrop",
    countyFips: "48021",
    parcelKey: "apn:48021:34161",
    portalId: "bastrop-aumentum",
    requestPayload: {},
  };

  it("completes Bastrop when entry surface is reachable", async () => {
    const browser: RecordsRecipeBrowser = {
      goto: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    };
    const result = await runRecipeForJob(bastropCtx, browser);
    expect(result.status).toBe("complete");
    expect(result.scopeSearched?.portalId).toBe("bastrop-aumentum");
    expect(result.scopeSearched?.mode).toBe("scaffold");
  });

  it("fails closed when entry navigation fails", async () => {
    const browser: RecordsRecipeBrowser = {
      goto: vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    };
    const result = await runRecipeForJob(bastropCtx, browser);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("portal-unreachable");
  });
});
