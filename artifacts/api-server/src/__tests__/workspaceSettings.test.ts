/**
 * /api/workspace/settings — practice states (v1.5).
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("workspace settings practiceStates", () => {
  it("GET returns practiceStates array", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp()).get("/api/workspace/settings");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.practiceStates)).toBe(true);
    expect(res.body).toHaveProperty("primaryColor");
    expect(res.body).toHaveProperty("preferences");
    expect(res.body.preferences.federalLayers).toHaveProperty("fema");
    expect(res.body).toHaveProperty("storageDisplay");
  });

  it("PATCH merges preferences federalLayers", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .patch("/api/workspace/settings")
      .send({
        preferences: {
          federalLayers: { fema: true, usgs: false, epa: true, fcc: false },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.preferences.federalLayers.usgs).toBe(false);
    expect(res.body.preferences.federalLayers.fema).toBe(true);
  });

  it("PATCH accepts valid US state codes", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .patch("/api/workspace/settings")
      .send({ practiceStates: ["tx", "UT", "TX"] });
    expect(res.status).toBe(200);
    expect(res.body.practiceStates).toEqual(["TX", "UT"]);
  });

  it("PATCH accepts primaryColor hex", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .patch("/api/workspace/settings")
      .send({ primaryColor: "#0284c7" });
    expect(res.status).toBe(200);
    expect(res.body.primaryColor).toBe("#0284C7");
  });

  it("PATCH rejects invalid primaryColor", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .patch("/api/workspace/settings")
      .send({ primaryColor: "cyan" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_primary_color");
  });

  it("PATCH rejects invalid state name", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp())
      .patch("/api/workspace/settings")
      .send({ practiceStates: ["Texas"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_practice_state_code");
  });
});
