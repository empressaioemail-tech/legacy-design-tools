/**
 * Dataroom / Files tile BFF — the upload -> ingest -> atom-chip flow, the
 * tenant-private firewall, and ingest idempotency.
 *
 * The engine `postEngineSpine` call is mocked so the BFF orchestration
 * (firewall: no accessPolicy sent; persist exactly what the engine returns;
 * upsert-on-conflict idempotency; chip read-back) is what is under test — no
 * network to engine-api, no GCS.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, engagements, attachedDocuments } from "@workspace/db";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";

// Capture the outbound engine request so the firewall assertion can inspect it.
const capturedIngestBodies: Array<Record<string, unknown>> = [];

// The atoms the mocked engine "extracts". tenant-private, asserted confidence,
// point-to, each citing the pinned source blob — exactly the ingest contract.
const ENGINE_ATOMS = [
  {
    atomDid: "did:hauska:survey-record:424cba22deadbeef",
    entityType: "survey-record",
    entityId: "survey-record:424cba22",
    accessPolicy: "tenant-private",
    storageRelation: "point-to",
    confidence: { kind: "asserted", value: 0.72, intervalWidth: 0.3, n: 0 },
    verificationStatus: "extracted-unverified",
    sourceDocumentCid: "bafycid-source-blob-1",
    created: true,
  },
];

vi.mock("../lib/engineSpineClient", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/engineSpineClient")>(
      "../lib/engineSpineClient",
    );
  return {
    ...actual,
    postEngineSpine: vi.fn(async (opts: { body: Record<string, unknown> }) => {
      capturedIngestBodies.push(opts.body);
      return {
        payload: {
          status: "ok",
          sourceDocument: {
            cid: "bafycid-source-blob-1",
            contentHash: "sha256:deadbeef",
            contentType: "application/pdf",
            accessPolicy: "tenant-private",
            pinned: true,
          },
          classification: {
            documentType: "survey",
            adapter: "survey-record",
            score: 0.95,
          },
          atoms: ENGINE_ATOMS,
        },
      };
    }),
  };
});

// The ingest lib downloads the uploaded blob bytes before calling the engine.
// Stub the storage read so no GCS is touched.
vi.mock("../lib/objectStorage", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/objectStorage")>(
      "../lib/objectStorage",
    );
  return {
    ...actual,
    ObjectStorageService: class {
      async getObjectEntityFile(): Promise<unknown> {
        return {};
      }
      async downloadObject(): Promise<{ body: ReadableStream<Uint8Array> }> {
        const bytes = Buffer.from("%PDF-1.4 survey stub");
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(bytes));
              controller.close();
            },
          }),
        };
      }
    },
  };
});

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("dataroom-ingest.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagementWithFile(): Promise<{
  engagementId: string;
  documentId: string;
}> {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: "Dataroom Case",
      nameLower: "dataroom case",
      ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
      jurisdiction: "bastrop-tx",
      address: "1 Dataroom Way, Bastrop TX",
    })
    .returning();
  const engagementId = eng!.id;
  const [doc] = await db
    .insert(attachedDocuments)
    .values({
      engagementId,
      title: "survey.pdf",
      documentType: "narrative",
      extractedText: "[Uploaded survey.pdf]",
      originalBlobRef: "/objects/uploads/survey-blob-1",
      actorId: LEGACY_INTERNAL_OWNER_USER_ID,
    })
    .returning();
  return { engagementId, documentId: doc!.id };
}

describe("Dataroom / Files tile BFF", () => {
  beforeEach(() => {
    capturedIngestBodies.length = 0;
  });

  it("ingests a file into cited, confidence-graded atoms and lists them", async () => {
    const { engagementId, documentId } = await seedEngagementWithFile();

    const res = await request(getApp())
      .post(
        `/api/plan-review/engagements/${engagementId}/documents/${documentId}/ingest`,
      )
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.sourceDocumentCid).toBe("bafycid-source-blob-1");
    expect(res.body.atoms).toHaveLength(1);

    const chip = res.body.atoms[0];
    expect(chip.entityType).toBe("survey-record");
    // Cited: links back to the pinned source blob.
    expect(chip.sourceDocumentCid).toBe("bafycid-source-blob-1");
    // Confidence-graded, never bare: the {kind,value,intervalWidth,n} shape.
    expect(chip.confidence).toMatchObject({
      kind: "asserted",
      value: 0.72,
      intervalWidth: 0.3,
      n: 0,
    });
    expect(chip.verificationStatus).toBe("extracted-unverified");

    // The atoms are persisted and re-listable without a re-ingest.
    const listRes = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/documents/${documentId}/atoms`,
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.atoms).toHaveLength(1);
    expect(listRes.body.atoms[0].atomDid).toBe(chip.atomDid);

    // And via the engagement-wide hydrate, keyed by documentId.
    const hydrateRes = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/dataroom-atoms`,
    );
    expect(hydrateRes.status).toBe(200);
    expect(hydrateRes.body.atomsByDocument[documentId]).toHaveLength(1);
  });

  it("FIREWALL: sends no accessPolicy on a private upload and persists tenant-private", async () => {
    const { engagementId, documentId } = await seedEngagementWithFile();

    const res = await request(getApp())
      .post(
        `/api/plan-review/engagements/${engagementId}/documents/${documentId}/ingest`,
      )
      .send({});
    expect(res.status).toBe(200);

    // The BFF must NOT set accessPolicy on the ingest request — the engine
    // defaults + clamps to tenant-private. No auto-publish path.
    expect(capturedIngestBodies).toHaveLength(1);
    expect(capturedIngestBodies[0]).not.toHaveProperty("accessPolicy");

    // And the persisted / returned atom carries tenant-private (never public).
    expect(res.body.atoms[0].accessPolicy).toBe("tenant-private");
  });

  it("is idempotent — re-ingesting the same file does not duplicate atoms", async () => {
    const { engagementId, documentId } = await seedEngagementWithFile();

    await request(getApp())
      .post(
        `/api/plan-review/engagements/${engagementId}/documents/${documentId}/ingest`,
      )
      .send({});
    await request(getApp())
      .post(
        `/api/plan-review/engagements/${engagementId}/documents/${documentId}/ingest`,
      )
      .send({});

    const listRes = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/documents/${documentId}/atoms`,
    );
    expect(listRes.status).toBe(200);
    // Deterministic atomDid -> upsert-on-conflict -> exactly one row.
    expect(listRes.body.atoms).toHaveLength(1);
  });

  it("returns 404 for an unknown document", async () => {
    const { engagementId } = await seedEngagementWithFile();
    const res = await request(getApp())
      .post(
        `/api/plan-review/engagements/${engagementId}/documents/00000000-0000-0000-0000-000000000000/ingest`,
      )
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("document_not_found");
  });

  it("returns 404 for an unknown engagement", async () => {
    const res = await request(getApp())
      .post(
        `/api/plan-review/engagements/00000000-0000-0000-0000-000000000000/documents/00000000-0000-0000-0000-000000000001/ingest`,
      )
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });
});
