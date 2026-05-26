/**
 * Phase 1 — encumbrance upload / list / verify (ADR-020 R4).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const extractMock = vi.hoisted(() =>
  vi.fn(async () => ({
    plainText: "Article VII § 4.2\nNo structure shall exceed thirty-five feet.",
    pageCount: 2,
    clauses: [
      {
        clausePath: "Article VII § 4.2",
        bodyText: "No structure shall exceed thirty-five feet.",
        sourceCitation: "Article VII § 4.2 (approx. p. 1)",
        sourcePage: 1,
        confidence: 0.9,
        reasoningSummary: "Test fixture clause.",
      },
    ],
    metadata: {
      documentModel: "encumbrance-extract-v1",
      documentModelVersion: "1.0.0",
      extractedAt: "2026-05-26T12:00:00.000Z",
    },
  })),
);

const uploadMock = vi.hoisted(() =>
  vi.fn(async () => "/objects/uploads/test-pdf"),
);

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("encumbrances.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/encumbranceExtract", () => ({
  extractEncumbranceClausesFromPdf: extractMock,
  mintInstrumentDid: (id: string) => `did:hauska:instrument:test-${id.slice(0, 8)}`,
  mintClauseDid: (did: string, i: number) => `${did}:clause:${i + 1}`,
  sourceDocumentCidFromObjectPath: (p: string) => `gcs:${p}`,
  ENCUMBRANCE_EXTRACT_MODEL: "encumbrance-extract-v1",
  ENCUMBRANCE_EXTRACT_VERSION: "1.0.0",
}));

vi.mock("../lib/objectStorage", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/objectStorage")
  >("../lib/objectStorage");
  return {
    ...actual,
    ObjectStorageService: class extends actual.ObjectStorageService {
      override async uploadObjectEntityFromBuffer() {
        return uploadMock();
      }
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, restrictionClauses } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(async () => {
  const { resetAtomRegistryForTests } = await import("../atoms/registry");
  resetAtomRegistryForTests();
});

beforeEach(() => {
  extractMock.mockClear();
  uploadMock.mockClear();
});

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
);

async function seedEngagement(name: string) {
  const [eng] = await ctx.schema!.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.toLowerCase(),
      address: "430 Evergreen Trl, Cedar Hill, TX 75104",
    })
    .returning();
  return eng!;
}

describe("encumbrances routes", () => {
  it("GET returns empty instruments and clauses", async () => {
    const eng = await seedEngagement("Enc empty");
    const res = await request(getApp()).get(`/api/engagements/${eng.id}/encumbrances`);
    expect(res.status).toBe(200);
    expect(res.body.instruments).toEqual([]);
    expect(res.body.clauses).toEqual([]);
  });

  it("POST upload creates instrument + clauses; briefing includes privateRestrictions", async () => {
    const eng = await seedEngagement("Cedar Hill enc");

    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/encumbrances/upload`)
      .attach("file", MINIMAL_PDF, {
        filename: "ccr-sample.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.instruments).toHaveLength(1);
    expect(res.body.clauses).toHaveLength(1);
    expect(res.body.instruments[0].instrument.entityType).toBe("recorded-instrument");
    expect(res.body.instruments[0].instrument.sourceAdapter).toBe("R4");
    expect(res.body.clauses[0].clause.entityType).toBe("restriction-clause");

    const briefingRes = await request(getApp()).get(
      `/api/engagements/${eng.id}/briefing`,
    );
    expect(briefingRes.status).toBe(200);
    expect(briefingRes.body.briefing?.privateRestrictions?.items).toHaveLength(1);
    expect(briefingRes.body.briefing?.privateRestrictions?.summary).toMatch(
      /not municipal code/i,
    );
  });

  it("PATCH verify sets humanVerifiedAt", async () => {
    const eng = await seedEngagement("Verify enc");
    const upload = await request(getApp())
      .post(`/api/engagements/${eng.id}/encumbrances/upload`)
      .attach("file", MINIMAL_PDF, { filename: "deed.pdf" });
    const clauseId = upload.body.clauses[0].id as string;

    const verify = await request(getApp()).patch(
      `/api/engagements/${eng.id}/encumbrances/clauses/${clauseId}/verify`,
    );
    expect(verify.status).toBe(200);
    expect(verify.body.clauses[0].clause.humanVerifiedAt).toBeTruthy();

    const rows = await ctx.schema!.db
      .select()
      .from(restrictionClauses)
      .where(eq(restrictionClauses.id, clauseId));
    expect(rows[0]?.humanVerifiedAt).not.toBeNull();
  });

  it("415s when upload is not multipart", async () => {
    const eng = await seedEngagement("Bad ct");
    const res = await request(getApp())
      .post(`/api/engagements/${eng.id}/encumbrances/upload`)
      .send({})
      .set("Content-Type", "application/json");
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("expected_multipart");
  });
});
