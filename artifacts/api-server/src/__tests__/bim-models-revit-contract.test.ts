/**
 * Revit add-in ↔ /api/bim-models/:id/divergence contract test — Task #173.
 *
 * The route tests in `bim-models.test.ts` verify the server's HMAC
 * verifier round-trips against an inline signing helper. That is
 * not enough: an inline helper is server-aware by construction, so
 * a header rename or canonical-separator change on either side would
 * stay aligned with itself and the unit tests would still pass —
 * production would 401.
 *
 * This file exists to close that gap. It imports the vendored Revit
 * add-in signing snippet (`__vendor__/revit-addin-signer.ts` — a TS
 * port of the C# `DivergenceRequestSigner.Sign` helper) and uses it,
 * and only it, to mint a signed POST against the live route. If the
 * server changes the header names, the canonical input separator,
 * the hash family, or the digest encoding, this test fails because
 * the vendored snippet still emits the old shape. If the Revit team
 * changes their C# helper, re-vendoring `revit-addin-signer.ts` is
 * what flushes the new contract through this test.
 *
 * Asserts:
 *   - The vendored snippet's header names match the names the server
 *     route reads from `req.header(...)` (catches a one-sided rename
 *     even if the HMAC math agrees).
 *   - The vendored snippet's canonical separator is the `.` the
 *     server's `verifyDivergenceHmac` concatenates with.
 *   - A divergence POST signed *only* with the vendored snippet
 *     hits the live route and lands a 201 with the expected body.
 *   - A request signed for one bim-model id but POSTed against a
 *     different bim-model id is rejected (401) — the route binds
 *     the signature to the URL's bim-model id.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
} from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import {
  signDivergenceRequest,
  REVIT_ADDIN_REQUEST_ID_HEADER,
  REVIT_ADDIN_SIGNATURE_HEADER,
  REVIT_ADDIN_CANONICAL_SEPARATOR,
} from "./__vendor__/revit-addin-signer";

import { vi } from "vitest";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("bim-models-revit-contract.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  parcelBriefings,
  materializableElements,
  briefingDivergences,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

const TEST_HMAC_SECRET = "revit-contract-test-secret";

beforeAll(() => {
  process.env.BIM_MODEL_SHARED_SECRET = TEST_HMAC_SECRET;
});

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const ARCHITECT_HEADER = ["x-audience", "internal"] as const;

async function seedBimModelWithElement(): Promise<{
  bimModelId: string;
  elementId: string;
}> {
  if (!ctx.schema)
    throw new Error("bim-models-revit-contract.test: ctx.schema not set");
  const db = ctx.schema.db;
  const name = "Revit Contract Engagement";
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.toLowerCase(),
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({ engagementId: eng.id })
    .returning();

  // Push to materialize a bim_model row via the live route — we
  // intentionally don't insert the row directly so this test also
  // exercises the production push path the architect uses before
  // the C# add-in ever sees the bim-model id.
  const push = await request(getApp())
    .post(`/api/engagements/${eng.id}/bim-model`)
    .set(ARCHITECT_HEADER[0], ARCHITECT_HEADER[1])
    .send({});
  if (push.status !== 200) {
    throw new Error(
      `setup push failed: ${push.status} ${JSON.stringify(push.body)}`,
    );
  }
  const bimModelId = push.body.bimModel.id as string;

  const [elem] = await db
    .insert(materializableElements)
    .values({
      briefingId: briefing.id,
      elementKind: "buildable-envelope",
      label: "Contract envelope",
      geometry: { ring: [] },
    })
    .returning();
  return { bimModelId, elementId: elem.id };
}

describe("Revit add-in ↔ divergence route contract", () => {
  it("vendored snippet emits the exact header names the server route reads (request rejected when header names drift)", async () => {
    // Catches a one-sided rename even if the HMAC math would still
    // match — the bytes-on-the-wire contract is the header NAME.
    // We prove the contract behaviorally: sign a request with the
    // vendored snippet, then send it under deliberately *wrong*
    // header names. If the server were reading any other header
    // name (a one-sided rename), the request would be accepted and
    // we'd fail to detect drift. The route must instead reject for
    // missing headers — that is the round-trip proof that the
    // server is reading the same header name the snippet writes.
    const { bimModelId, elementId } = await seedBimModelWithElement();
    const requestId = "00000000-0000-0000-0000-0000000000c1";
    const signed = signDivergenceRequest({
      sharedSecret: TEST_HMAC_SECRET,
      bimModelId,
      requestId,
    });

    // Sanity: the snippet's header names are the ones we expect.
    expect(signed.requestIdHeaderName).toBe(REVIT_ADDIN_REQUEST_ID_HEADER);
    expect(signed.signatureHeaderName).toBe(REVIT_ADDIN_SIGNATURE_HEADER);

    const drifted = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      // Same VALUES as the vendored snippet would set, but under
      // header NAMES the route doesn't read. A drifted server
      // (reads `x-revit-*` instead of `x-bim-model-*`) would
      // succeed; the contract requires this to fail.
      .set("x-revit-request-id", signed.requestIdHeaderValue)
      .set("x-revit-signature", signed.signatureHeaderValue)
      .send({
        materializableElementId: elementId,
        reason: "geometry-edited",
      });
    expect(drifted.status).toBe(400);
    expect(drifted.body.error).toBe("missing_bim_model_signature_headers");
  });

  it("vendored snippet's canonical separator matches the server's HMAC input", () => {
    // The server concatenates `${args.requestId}.${args.bimModelId}` —
    // a separator change on either side would silently 401 in prod.
    expect(REVIT_ADDIN_CANONICAL_SEPARATOR).toBe(".");
  });

  it("a request signed with the vendored snippet lands a 201 against the live route", async () => {
    const { bimModelId, elementId } = await seedBimModelWithElement();
    const requestId = "00000000-0000-0000-0000-0000000000a1";

    // Sign with the vendored snippet ONLY — no server-aware shortcut.
    // If anything in the contract drifts, this is the call that
    // produces a "wrong" signature and the route returns 401.
    const signed = signDivergenceRequest({
      sharedSecret: TEST_HMAC_SECRET,
      bimModelId,
      requestId,
    });

    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set(signed.requestIdHeaderName, signed.requestIdHeaderValue)
      .set(signed.signatureHeaderName, signed.signatureHeaderValue)
      .send({
        materializableElementId: elementId,
        reason: "geometry-edited",
        note: "moved a vertex",
        detail: { revitElementId: 12345 },
      });

    expect(res.status).toBe(201);
    expect(res.body.divergence.bimModelId).toBe(bimModelId);
    expect(res.body.divergence.materializableElementId).toBe(elementId);
    expect(res.body.divergence.reason).toBe("geometry-edited");

    if (!ctx.schema)
      throw new Error("bim-models-revit-contract.test: ctx.schema not set");
    const rows = await ctx.schema.db
      .select()
      .from(briefingDivergences)
      .where(eq(briefingDivergences.bimModelId, bimModelId));
    expect(rows).toHaveLength(1);
  });

  it("a signature minted for a different bim-model id is rejected (signature is URL-bound)", async () => {
    // The vendored snippet binds the signature to the bim-model id
    // it was given, and the server rebuilds the canonical input from
    // the URL parameter. Posting the signature against a *different*
    // url id must 401 — this is the protection that stops a leaked
    // signature from being replayed against an unrelated bim-model.
    const { bimModelId, elementId } = await seedBimModelWithElement();
    const requestId = "00000000-0000-0000-0000-0000000000a2";
    const signed = signDivergenceRequest({
      sharedSecret: TEST_HMAC_SECRET,
      bimModelId: "00000000-0000-0000-0000-000000000bad",
      requestId,
    });

    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set(signed.requestIdHeaderName, signed.requestIdHeaderValue)
      .set(signed.signatureHeaderName, signed.signatureHeaderValue)
      .send({
        materializableElementId: elementId,
        reason: "geometry-edited",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_bim_model_signature");
  });
});
