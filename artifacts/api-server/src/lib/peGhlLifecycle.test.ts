import { describe, expect, it, afterEach } from "vitest";
import { applyLifecycleToGhl } from "./peGhlLifecycle";
import { resetGhlCatalogCache } from "./peGhlCatalog";
import { mockGhlFetch } from "./peGhlCatalog.test";

afterEach(() => {
  resetGhlCatalogCache();
});

describe("applyLifecycleToGhl E1", () => {
  it("upserts Explorer + ss_src_ad + free/none + first-touch UTMs", async () => {
    const { fetchImpl, calls } = mockGhlFetch();
    const result = await applyLifecycleToGhl(
      {
        email: "ad@example.com",
        displayName: "Ad User",
        event: "e1_account_created",
        campaign: "utm_source=facebook&utm_medium=paid&utm_campaign=phase1&utm_content=v2",
        plan: "free",
        billing: "none",
      },
      { fetchImpl, config: { apiKey: "k", locationId: "loc_1" } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tags).toEqual(["ss_explorer", "ss_src_ad"]);
    expect(result.sourceTag).toBe("ss_src_ad");
    expect(result.stage).toBe("Explorer");

    const upsert = calls.find((c) => c.url.includes("/contacts/upsert"));
    expect(upsert).toBeTruthy();
    const body = upsert!.body as Record<string, unknown>;
    expect(body["tags"]).toEqual(["ss_explorer", "ss_src_ad"]);
    expect(JSON.stringify(body)).not.toMatch(/source-organic|tier-free/);
    const fields = body["customFields"] as { id: string; field_value: string }[];
    const values = fields.map((f) => f.field_value);
    expect(values).toContain("free");
    expect(values).toContain("none");
    expect(values).toContain("facebook");
    expect(values).toContain("paid");
    expect(values).toContain("phase1");
    expect(values).toContain("v2");

    const opp = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/opportunities/"),
    );
    expect(opp).toBeTruthy();
    expect((opp!.body as Record<string, unknown>)["pipelineId"]).toBe("pipe_ss");
    expect((opp!.body as Record<string, unknown>)["pipelineStageId"]).toBe(
      "stage_0",
    );
  });

  it("unmapped UTMs write no source tag and still create Explorer", async () => {
    const { fetchImpl, calls } = mockGhlFetch();
    const result = await applyLifecycleToGhl(
      {
        email: "u@example.com",
        event: "e1_account_created",
        campaign: "utm_source=twitter&utm_medium=cpc",
        plan: "free",
        billing: "none",
      },
      { fetchImpl, config: { apiKey: "k", locationId: "loc_1" } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tags).toEqual(["ss_explorer"]);
    expect(result.sourceTag).toBeNull();
    const upsert = calls.find((c) => c.url.includes("/contacts/upsert"));
    expect((upsert!.body as Record<string, unknown>)["tags"]).toEqual([
      "ss_explorer",
    ]);
  });

  it("no UTMs write ss_src_direct", async () => {
    const { fetchImpl } = mockGhlFetch();
    const result = await applyLifecycleToGhl(
      {
        email: "d@example.com",
        event: "e1_account_created",
        plan: "free",
        billing: "none",
      },
      { fetchImpl, config: { apiKey: "k", locationId: "loc_1" } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tags).toEqual(["ss_explorer", "ss_src_direct"]);
  });

  it("a plan with no share skips to Solo", async () => {
    const { fetchImpl, calls } = mockGhlFetch();
    const result = await applyLifecycleToGhl(
      {
        email: "p@example.com",
        event: "e5_plan_started",
        plan: "solo",
        billing: "annual",
        currentStage: "Explorer",
      },
      { fetchImpl, config: { apiKey: "k", locationId: "loc_1" } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stage).toBe("Solo");
    expect(result.tags).toContain("ss_solo");
    expect(result.tags).toContain("ss_annual");
    const opp = calls.find((c) => c.url.endsWith("/opportunities/"));
    expect((opp!.body as Record<string, unknown>)["pipelineStageId"]).toBe(
      "stage_3",
    );
  });

  it("refuses to send when the catalog is incomplete", async () => {
    const { fetchImpl, calls } = mockGhlFetch({
      failCatalogPath: "/customFields",
    });
    const result = await applyLifecycleToGhl(
      {
        email: "x@example.com",
        event: "e1_account_created",
        plan: "free",
        billing: "none",
      },
      { fetchImpl, config: { apiKey: "k", locationId: "loc_1" } },
    );
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.url.includes("/contacts/upsert"))).toBe(false);
  });
});
