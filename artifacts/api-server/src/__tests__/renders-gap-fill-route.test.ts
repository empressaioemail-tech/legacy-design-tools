/**
 * GET /api/renders/credits + POST /api/renders/prompt-generator —
 * the doc 40c gap-fill route surface.
 *
 * Both routes are stateless (no `viewpoint_renders` row, no DB read),
 * so this suite stubs the mnml client via `setMnmlClient` and asserts
 * the HTTP contract: the architect-audience guard, the multipart
 * parse, the happy-path envelopes, and the MnmlError → HTTP-status
 * mapping. The PG schema is still provisioned by `setupRouteTests`
 * because `buildTestApp` mounts the whole router tree.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("renders-gap-fill-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { setMnmlClient, MnmlError, MockMnmlClient } = await import(
  "@workspace/mnml-client"
);
import type {
  CreditsResult,
  MnmlClient,
  PromptGeneratorResult,
  RenderStatusResult,
  TriggerRenderResult,
} from "@workspace/mnml-client";

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  setMnmlClient(null);
});

afterAll(() => {
  setMnmlClient(null);
});

/**
 * Send the dev-only `x-audience: internal` header so the architect-
 * audience guard lets the request through. Mirrors the helper in
 * `briefing-source-glb.test.ts` / `bim-models.test.ts`.
 */
function asArchitect<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req.set("x-audience", "internal");
}

/**
 * A 1×1 PNG — enough bytes for the multipart wire + the route's
 * non-empty-image check.
 */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4" +
    "890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

/**
 * Minimal hand-built MnmlClient whose every method rejects with the
 * supplied MnmlError. Lets a test drive the route's error-mapping
 * branch for a specific `kind` without the mock's broader behaviour.
 */
function throwingClient(err: InstanceType<typeof MnmlError>): MnmlClient {
  const reject = async () => {
    throw err;
  };
  return {
    triggerRender: reject as () => Promise<TriggerRenderResult>,
    getRenderStatus: reject as () => Promise<RenderStatusResult>,
    getCredits: reject as () => Promise<CreditsResult>,
    generatePrompt: reject as () => Promise<PromptGeneratorResult>,
  };
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/renders/credits
// ─────────────────────────────────────────────────────────────────────

describe("GET /api/renders/credits", () => {
  it("403s when the caller is not architect-audience", async () => {
    const res = await request(getApp()).get("/api/renders/credits");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("renders_requires_architect_audience");
  });

  it("200s with the mnml account balance", async () => {
    setMnmlClient(new MockMnmlClient({ startingCredits: 412 }));
    const res = await asArchitect(
      request(getApp()).get("/api/renders/credits"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ credits: 412 });
  });

  it("does not collide with GET /renders/:id (literal route wins)", async () => {
    // `credits` is a literal segment registered before `/renders/:id`.
    // If the parametric route shadowed it, the UUID check would 400
    // with `invalid_render_id` instead of serving the balance.
    setMnmlClient(new MockMnmlClient({ startingCredits: 7 }));
    const res = await asArchitect(
      request(getApp()).get("/api/renders/credits"),
    );
    expect(res.status).toBe(200);
    expect(res.body.credits).toBe(7);
  });

  it("maps an mnml insufficient_credits error to HTTP 402", async () => {
    setMnmlClient(
      throwingClient(
        new MnmlError("insufficient_credits", "NO_CREDITS", "out of credits"),
      ),
    );
    const res = await asArchitect(
      request(getApp()).get("/api/renders/credits"),
    );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("insufficient_credits");
  });

  it("maps an mnml unavailable error to HTTP 503", async () => {
    setMnmlClient(
      throwingClient(new MnmlError("unavailable", "HTTP_500", "mnml down")),
    );
    const res = await asArchitect(
      request(getApp()).get("/api/renders/credits"),
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("unavailable");
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/renders/prompt-generator
// ─────────────────────────────────────────────────────────────────────

describe("POST /api/renders/prompt-generator", () => {
  it("403s when the caller is not architect-audience", async () => {
    const res = await request(getApp())
      .post("/api/renders/prompt-generator")
      .attach("image", PNG_BYTES, "sketch.png");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("renders_requires_architect_audience");
  });

  it("415s when the body is not multipart/form-data", async () => {
    const res = await asArchitect(
      request(getApp()).post("/api/renders/prompt-generator"),
    ).send({ keywords: "modern" });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("expected_multipart");
  });

  it("400s when the multipart body has no image part", async () => {
    const res = await asArchitect(
      request(getApp()).post("/api/renders/prompt-generator"),
    ).field("keywords", "modern glass facade");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_image_part");
  });

  it("200s with a generated prompt on a valid image upload", async () => {
    setMnmlClient(new MockMnmlClient());
    const res = await asArchitect(
      request(getApp()).post("/api/renders/prompt-generator"),
    )
      .attach("image", PNG_BYTES, "sketch.png")
      .field("keywords", "desert house, courtyard");
    expect(res.status).toBe(200);
    expect(typeof res.body.prompt).toBe("string");
    // The mock folds the keyword hint into its deterministic prompt.
    expect(res.body.prompt).toContain("desert house, courtyard");
  });

  it("200s without keywords (the field is optional)", async () => {
    setMnmlClient(new MockMnmlClient());
    const res = await asArchitect(
      request(getApp()).post("/api/renders/prompt-generator"),
    ).attach("image", PNG_BYTES, "sketch.png");
    expect(res.status).toBe(200);
    expect(typeof res.body.prompt).toBe("string");
    expect(res.body.prompt.length).toBeGreaterThan(0);
  });

  it("maps an mnml validation error to HTTP 400", async () => {
    // `alwaysFail` makes the mock's generatePrompt throw
    // MnmlError(validation, MOCK_FORCED) → the route maps it to 400.
    setMnmlClient(new MockMnmlClient({ alwaysFail: true }));
    const res = await asArchitect(
      request(getApp()).post("/api/renders/prompt-generator"),
    ).attach("image", PNG_BYTES, "sketch.png");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("mnml_validation");
  });

  it("maps an mnml insufficient_credits error to HTTP 402", async () => {
    setMnmlClient(
      throwingClient(
        new MnmlError("insufficient_credits", "NO_CREDITS", "out of credits"),
      ),
    );
    const res = await asArchitect(
      request(getApp()).post("/api/renders/prompt-generator"),
    ).attach("image", PNG_BYTES, "sketch.png");
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("insufficient_credits");
  });
});
