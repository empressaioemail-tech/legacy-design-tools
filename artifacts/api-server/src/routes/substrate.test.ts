/**
 * Route tests for /api/substrate/jurisdictions (QA-17).
 *
 * Mounts only the substrate router on a bare Express app and injects a
 * stub substrate client via setHauskaSubstrateClient — no DB, no MCP
 * server. Asserts the happy path plus the two failure shapes.
 */

import { describe, it, expect, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import substrateRouter from "./substrate";
import {
  MockHauskaSubstrateClient,
  SubstrateError,
  setHauskaSubstrateClient,
  type HauskaSubstrateClient,
} from "../lib/hauskaSubstrateClient";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", substrateRouter);
  return app;
}

afterEach(() => {
  setHauskaSubstrateClient(null);
});

describe("GET /api/substrate/jurisdictions", () => {
  it("returns the substrate catalog with all five jurisdictions", async () => {
    setHauskaSubstrateClient(new MockHauskaSubstrateClient());
    const res = await request(buildApp()).get("/api/substrate/jurisdictions");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("mock");
    expect(res.body.jurisdictions).toHaveLength(5);
    expect(res.body.jurisdictions[0]).toHaveProperty("accessPolicy");
    expect(res.body.jurisdictions[0]).toHaveProperty("atomCount");
  });

  it("answers 502 substrate_unavailable when the substrate is unreachable", async () => {
    setHauskaSubstrateClient(
      new MockHauskaSubstrateClient({
        failWith: new SubstrateError(
          "substrate_unreachable",
          "MCP server did not respond",
        ),
      }),
    );
    const res = await request(buildApp()).get("/api/substrate/jurisdictions");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("substrate_unavailable");
    expect(res.body.code).toBe("substrate_unreachable");
    expect(res.body.detail).toMatch(/did not respond/);
  });

  it("answers 500 on an unexpected (non-SubstrateError) failure", async () => {
    const brokenClient: HauskaSubstrateClient = {
      async listJurisdictions() {
        throw new Error("unexpected boom");
      },
    };
    setHauskaSubstrateClient(brokenClient);
    const res = await request(buildApp()).get("/api/substrate/jurisdictions");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to list substrate jurisdictions/);
  });
});
