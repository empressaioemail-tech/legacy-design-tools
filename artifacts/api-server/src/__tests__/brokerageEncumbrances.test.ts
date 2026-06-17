/**
 * Brokerage workspace encumbrance upload (R4) — keyed by atoms.workspaceDid.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { buildPropertyWorkspaceDid } from "../lib/brokerageBriefAtoms";

const extractMock = vi.hoisted(() =>
  vi.fn(async () => ({
    plainText: "Article VII § 4.2\nNo structure shall exceed thirty-five feet.",
    pageCount: 1,
    clauses: [
      {
        clausePath: "Article VII § 4.2",
        bodyText: "No structure shall exceed thirty-five feet.",
        sourceCitation: "Article VII § 4.2 (approx. p. 1)",
        sourcePage: 1,
        confidence: 0.9,
        reasoningSummary: "Fixture clause.",
      },
    ],
    metadata: {
      documentModel: "encumbrance-extract-v1",
      documentModelVersion: "1.0.0",
      extractedAt: "2026-05-29T12:00:00.000Z",
    },
  })),
);

const uploadMock = vi.hoisted(() =>
  vi.fn(async () => "/objects/uploads/brokerage-ccr.pdf"),
);

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("brokerageEncumbrances.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/encumbranceExtract", () => ({
  extractEncumbranceClausesFromPdf: extractMock,
  mintInstrumentDid: (id: string) => `did:hauska:instrument:brk-${id.slice(0, 8)}`,
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

const TEST_API_KEY = "brokerage-enc-test-key-001";

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { listingKeyFromAddress } = await import("../lib/brokerageWorkspace");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  extractMock.mockClear();
  uploadMock.mockClear();
  process.env.BROKERAGE_API_KEYS = TEST_API_KEY;
  resetBrokerageApiKeysForTests();
});

const authHeaders = {
  "X-Hauska-Install-Id": "install-enc-test-aaaaaaaa",
  Authorization: `Bearer ${TEST_API_KEY}`,
};

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
);

describe("brokerage workspace encumbrances", () => {
  it("upload + list by workspaceDid", async () => {
    const address = "430 Evergreen Trl, Cedar Hill, TX 75104";
    const listingKey = listingKeyFromAddress(address);
    const workspaceDid = buildPropertyWorkspaceDid(listingKey);

    const upload = await request(getApp())
      .post("/api/brokerage/v1/workspaces/encumbrances/upload")
      .set(authHeaders)
      .field("workspaceDid", workspaceDid)
      .attach("file", MINIMAL_PDF, {
        filename: "ccr-sample.pdf",
        contentType: "application/pdf",
      });

    expect(upload.status).toBe(201);
    expect(upload.body.workspaceDid).toBe(workspaceDid);
    expect(upload.body.instruments).toHaveLength(1);
    expect(upload.body.clauses[0].clause.entityType).toBe("restriction-clause");

    const list = await request(getApp())
      .get("/api/brokerage/v1/workspaces/encumbrances")
      .set(authHeaders)
      .query({ workspaceDid });

    expect(list.status).toBe(200);
    expect(list.body.clauses).toHaveLength(1);
  });
});
