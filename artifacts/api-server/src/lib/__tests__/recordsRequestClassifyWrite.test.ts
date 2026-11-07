/**
 * P-85 WDLL item 8 — classify+write integration with mocked DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordsRequestArtifact, RecordsRequestJob } from "@workspace/db";

const fakeState = {
  insertedInstruments: [] as Array<Record<string, unknown>>,
  insertedClauses: [] as Array<Record<string, unknown>>,
  engagementInstruments: [] as Array<{
    id: string;
    extractMetadata: Record<string, unknown>;
  }>,
  artifactUpdates: [] as Array<Record<string, unknown>>,
};

function makeThenableSelect(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.from = passthrough;
  chain.where = passthrough;
  chain.limit = passthrough;
  chain.orderBy = passthrough;
  chain.then = (
    resolve: (v: unknown) => void,
    reject?: (e: unknown) => void,
  ) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function makeInsertChain(kind: "instruments" | "clauses") {
  const chain: Record<string, unknown> = {};
  chain.values = (row: Record<string, unknown> | Array<Record<string, unknown>>) => {
    const rows = Array.isArray(row) ? row : [row];
    if (kind === "instruments") {
      fakeState.insertedInstruments.push(...rows);
      chain.returning = async () =>
        rows.map((r, i) => ({
          id: `inst-${fakeState.insertedInstruments.length - rows.length + i + 1}`,
          ...r,
        }));
    } else {
      fakeState.insertedClauses.push(...rows);
    }
    return chain;
  };
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = (patch: Record<string, unknown>) => {
    fakeState.artifactUpdates.push(patch);
    return chain;
  };
  chain.where = () => chain;
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
  return chain;
}

let insertKind: "instruments" | "clauses" = "instruments";

vi.mock("@workspace/db", () => ({
  db: {
    select: () => makeThenableSelect(fakeState.engagementInstruments),
    insert: () => {
      const chain = makeInsertChain(insertKind);
      return chain;
    },
    update: () => makeUpdateChain(),
  },
  recordedInstruments: { engagementId: "engagement_id", extractMetadata: "extract_metadata" },
  restrictionClauses: { instrumentId: "instrument_id" },
  recordsRequestArtifacts: { id: "id", metadata: "metadata", jobId: "job_id" },
  recordsRequestJobs: { id: "id" },
}));

vi.mock("../encumbranceExtract", () => ({
  ENCUMBRANCE_EXTRACT_MODEL: "encumbrance-extract-v1",
  ENCUMBRANCE_EXTRACT_VERSION: "1.0.0",
  extractClauseCandidatesFromPlainText: vi.fn(() => [
    {
      clausePath: "Section 1",
      bodyText: "Grantee shall maintain a twenty-foot utility easement.",
      sourceCitation: "Section 1 (approx. p. 1)",
      sourcePage: 1,
      confidence: 0.8,
      reasoningSummary: "fixture",
    },
  ]),
  mintInstrumentDid: () => "did:hauska:instrument:test",
  mintClauseDid: (_did: string, i: number) => `did:hauska:instrument:test:clause:${i + 1}`,
  sourceDocumentCidFromObjectPath: (p: string) => `gcs:${p}`,
}));

const JOB: RecordsRequestJob = {
  id: "job-1",
  engagementId: "eng-1",
  placeKey: null,
  userId: "user-1",
  userEmail: null,
  parcelKey: "apn:48453:TEST",
  countyFips: "48453",
  status: "complete",
  requestPayload: {},
  scopeSearched: null,
  liveInstantGis: null,
  runCost: null,
  recipeVersion: "test",
  errorCode: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: new Date(),
};

function baseArtifact(
  overrides: Partial<RecordsRequestArtifact> = {},
): RecordsRequestArtifact {
  return {
    id: "art-1",
    jobId: JOB.id,
    portalId: "travis-tccsearch",
    recordingRef: "2024-555",
    documentType: "EASEMENT",
    recordingDate: "2024-06-01",
    parties: "CITY / OWNER",
    acquisitionMethod: "capture",
    contentSha256: "abc123",
    byteSize: 1000,
    purchaseCostCents: null,
    detailUrl: null,
    storagePath: null,
    metadata: {
      capturePngBase64: Buffer.from("png").toString("base64"),
      visionRead: {
        status: "complete",
        visionApplied: true,
        extractedText:
          "[source: vision-read claude-opus-4-8]\nSection 1\nGrantee shall maintain a twenty-foot utility easement.",
        readAt: "2026-08-27T12:00:00.000Z",
      },
    },
    createdAt: new Date(),
    ...overrides,
  };
}

describe("classifyAndWriteRecordsRequestArtifact", () => {
  beforeEach(() => {
    fakeState.insertedInstruments = [];
    fakeState.insertedClauses = [];
    fakeState.engagementInstruments = [];
    fakeState.artifactUpdates = [];
    insertKind = "instruments";
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("writes easement instrument with restriction clauses", async () => {
    const dbMod = await import("@workspace/db");
    const origInsert = dbMod.db.insert;
    vi.spyOn(dbMod.db, "insert").mockImplementation(() => {
      const chain = makeInsertChain(insertKind);
      insertKind = "clauses";
      return chain as unknown as ReturnType<typeof origInsert>;
    });

    const { classifyAndWriteRecordsRequestArtifact } = await import(
      "../recordsRequestClassifyWrite"
    );
    const result = await classifyAndWriteRecordsRequestArtifact({
      artifact: baseArtifact(),
      job: JOB,
    });
    expect(result.status).toBe("written");
    expect(result.instrumentType).toBe("easement");
    expect(result.clauseCount).toBe(1);
    expect(fakeState.insertedInstruments).toHaveLength(1);
    expect(fakeState.insertedInstruments[0]?.sourceAdapter).toBe(
      "records-request-v1",
    );
    expect(fakeState.insertedClauses).toHaveLength(1);
  });

  it("writes deed header-only without clauses", async () => {
    const { classifyAndWriteRecordsRequestArtifact } = await import(
      "../recordsRequestClassifyWrite"
    );
    const result = await classifyAndWriteRecordsRequestArtifact({
      artifact: baseArtifact({
        documentType: "WARRANTY DEED",
        metadata: {
          capturePngBase64: Buffer.from("png").toString("base64"),
          visionRead: {
            status: "complete",
            visionApplied: true,
            extractedText:
              "[source: vision-read]\nGrantor: SMITH\nGrantee: JONES",
            readAt: "2026-08-27T12:00:00.000Z",
          },
        },
      }),
      job: JOB,
    });
    expect(result.status).toBe("written");
    expect(result.instrumentType).toBe("other");
    expect(result.documentKind).toBe("deed");
    expect(result.clauseCount).toBe(0);
    expect(fakeState.insertedClauses).toHaveLength(0);
    const meta = fakeState.insertedInstruments[0]?.extractMetadata as Record<
      string,
      unknown
    >;
    expect(meta.documentKind).toBe("deed");
    expect(meta.headerFacts).toBeTruthy();
  });

  it("writes ASSIGNMENT as unclassified and preserves the source label", async () => {
    const { classifyAndWriteRecordsRequestArtifact } = await import(
      "../recordsRequestClassifyWrite"
    );
    const result = await classifyAndWriteRecordsRequestArtifact({
      artifact: baseArtifact({ documentType: "ASSIGNMENT" }),
      job: JOB,
    });
    expect(result.status).toBe("written");
    expect(result.documentKind).toBe("unclassified");
    expect(fakeState.insertedInstruments).toHaveLength(1);
    const meta = fakeState.insertedInstruments[0]?.extractMetadata as Record<
      string,
      unknown
    >;
    expect(meta.documentKind).toBe("unclassified");
    expect(meta.sourceDocumentType).toBe("ASSIGNMENT");
    const facts = meta.headerFacts as Record<string, unknown>;
    expect(facts.documentType).toBe("ASSIGNMENT");
  });

  it("records absent document type as refused and writes no instrument", async () => {
    const { classifyAndWriteRecordsRequestArtifact } = await import(
      "../recordsRequestClassifyWrite"
    );
    const result = await classifyAndWriteRecordsRequestArtifact({
      artifact: baseArtifact({ documentType: null }),
      job: JOB,
    });
    expect(result.status).toBe("refused");
    expect(result.refuseCode).toBe("unclassifiable_document_type");
    expect(fakeState.insertedInstruments).toHaveLength(0);
    expect(fakeState.artifactUpdates[0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          classify: expect.objectContaining({
            status: "refused",
            refuseCode: "unclassifiable_document_type",
          }),
        }),
      }),
    );
  });

  it("refuses artifact missing recording ref and image", async () => {
    const { classifyAndWriteRecordsRequestArtifact } = await import(
      "../recordsRequestClassifyWrite"
    );
    const result = await classifyAndWriteRecordsRequestArtifact({
      artifact: baseArtifact({
        recordingRef: null,
        storagePath: null,
        metadata: {},
      }),
      job: JOB,
    });
    expect(result.status).toBe("refused");
    expect(result.refuseCode).toBe("missing_recording_ref_and_image");
    expect(fakeState.insertedInstruments).toHaveLength(0);
  });

  it("returns skipped without writing classify metadata on the artifact", async () => {
    fakeState.engagementInstruments = [
      {
        id: "inst-existing",
        extractMetadata: { recordsRequestArtifactId: "art-1" },
      },
    ];
    const { classifyAndWriteRecordsRequestArtifact } = await import(
      "../recordsRequestClassifyWrite"
    );
    const result = await classifyAndWriteRecordsRequestArtifact({
      artifact: baseArtifact(),
      job: JOB,
    });
    expect(result.status).toBe("skipped");
    expect(result.instrumentId).toBe("inst-existing");
    expect(result.refuseCode).toBe("already_classified");
    expect(fakeState.insertedInstruments).toHaveLength(0);
    expect(fakeState.artifactUpdates).toHaveLength(0);
  });
});
