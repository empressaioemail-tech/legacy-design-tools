/**
 * P-85 WDLL item 7 — batch vision read persists metadata.visionRead per artifact.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { VISION_READ_SOURCE_HEADER } from "../attachedDocumentVision";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ART_OK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ART_BLANK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ART_MISSING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Minimal valid 1×1 white PNG (blank page fixture). */
const BLANK_PAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface FakeDbState {
  artifactRows: Array<Record<string, unknown>>;
  metadataByArtifactId: Map<string, Record<string, unknown>>;
  visionReadPatches: Array<{ artifactId: string; visionRead: unknown }>;
}

const fakeState: FakeDbState = {
  artifactRows: [],
  metadataByArtifactId: new Map(),
  visionReadPatches: [],
};

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain["from"] = passthrough;
  chain["where"] = passthrough;
  chain["limit"] = async () => {
    const artifactId = fakeState.visionReadPatches.length
      ? fakeState.artifactRows[fakeState.visionReadPatches.length - 1]?.id
      : fakeState.artifactRows[0]?.id;
    const meta = artifactId
      ? fakeState.metadataByArtifactId.get(String(artifactId))
      : undefined;
    return meta ? [{ metadata: meta }] : [{ metadata: {} }];
  };
  chain["then"] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(fakeState.artifactRows).then(resolve);
  return chain;
}

function makeUpdateChain() {
  let pendingPatch: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = {};
  chain["set"] = (patch: Record<string, unknown>) => {
    pendingPatch = patch;
    return chain;
  };
  chain["where"] = () => {
    const idx = fakeState.visionReadPatches.length;
    const artifactId = String(fakeState.artifactRows[idx]?.id ?? "unknown");
    const meta = pendingPatch?.metadata as Record<string, unknown> | undefined;
    if (meta?.visionRead) {
      fakeState.visionReadPatches.push({
        artifactId,
        visionRead: meta.visionRead,
      });
      const prior = fakeState.metadataByArtifactId.get(artifactId) ?? {};
      fakeState.metadataByArtifactId.set(artifactId, {
        ...prior,
        ...meta,
      });
    }
    return chain;
  };
  chain["then"] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(undefined).then(resolve);
  return chain;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => makeUpdateChain(),
  },
  recordsRequestArtifacts: {
    jobId: "job_id",
    id: "id",
    metadata: "metadata",
  },
}));

vi.mock("../recordsRequestClassifyWrite", () => ({
  processRecordsRequestJobClassification: vi.fn(async () => []),
}));

const mockReadArtifact = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fakeState.artifactRows = [];
  fakeState.metadataByArtifactId = new Map();
  fakeState.visionReadPatches = [];
});

describe("resolveArtifactMimeType", () => {
  it("prefers captureMimeType from metadata", async () => {
    const { resolveArtifactMimeType } = await import("../recordsRequestVisionRead");
    expect(
      resolveArtifactMimeType({
        storagePath: null,
        metadata: { captureMimeType: "image/png" },
      }),
    ).toBe("image/png");
  });

  it("infers application/pdf from storage path", async () => {
    const { resolveArtifactMimeType } = await import("../recordsRequestVisionRead");
    expect(
      resolveArtifactMimeType({
        storagePath: "records/job/deed.pdf",
        metadata: {},
      }),
    ).toBe("application/pdf");
  });
});

describe("processRecordsRequestJobVisionReads", () => {
  it("persists metadata.visionRead for each artifact on the job", async () => {
    fakeState.artifactRows = [
      {
        id: ART_OK,
        jobId: JOB_ID,
        recordingRef: "2024-100",
        documentType: "DEED",
        storagePath: null,
        metadata: {
          captureMimeType: "image/png",
          capturePngBase64: Buffer.from("png-bytes").toString("base64"),
        },
      },
    ];
    fakeState.metadataByArtifactId.set(ART_OK, {
      captureMimeType: "image/png",
    });

    mockReadArtifact.mockResolvedValue({
      artifactId: ART_OK,
      status: "complete",
      visionApplied: true,
      extractedText: `${VISION_READ_SOURCE_HEADER}\nGrantor: SMITH`,
    });

    const { processRecordsRequestJobVisionReads } = await import(
      "../recordsRequestVisionRead"
    );
    const { vision, classification } = await processRecordsRequestJobVisionReads(JOB_ID, {
      readArtifact: mockReadArtifact,
      runClassification: false,
    });

    expect(classification).toEqual([]);
    expect(vision).toHaveLength(1);
    expect(vision[0]?.status).toBe("complete");
    expect(mockReadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: ART_OK,
        mimeType: "image/png",
      }),
    );
    expect(fakeState.visionReadPatches).toHaveLength(1);
    expect(fakeState.visionReadPatches[0]).toMatchObject({
      artifactId: ART_OK,
      visionRead: {
        status: "complete",
        visionApplied: true,
      },
    });
    expect(
      (fakeState.visionReadPatches[0]?.visionRead as Record<string, unknown>)
        .extractedText,
    ).toContain("Grantor: SMITH");
  });

  it("records failed read for blank page, never as absent (WDLL item 7)", async () => {
    fakeState.artifactRows = [
      {
        id: ART_BLANK,
        jobId: JOB_ID,
        recordingRef: "2024-200",
        documentType: "DEED",
        storagePath: null,
        metadata: {
          captureMimeType: "image/png",
          capturePngBase64: BLANK_PAGE_PNG.toString("base64"),
        },
      },
    ];
    fakeState.metadataByArtifactId.set(ART_BLANK, {
      captureMimeType: "image/png",
    });

    mockReadArtifact.mockResolvedValue({
      artifactId: ART_BLANK,
      status: "failed",
      visionApplied: false,
      failureReason: "vision_read_produced_no_text",
    });

    const { processRecordsRequestJobVisionReads } = await import(
      "../recordsRequestVisionRead"
    );
    const { vision } = await processRecordsRequestJobVisionReads(JOB_ID, {
      readArtifact: mockReadArtifact,
      runClassification: false,
    });

    expect(vision[0]).toMatchObject({
      status: "failed",
      failureReason: "vision_read_produced_no_text",
      visionApplied: false,
    });
    expect(fakeState.visionReadPatches[0]?.visionRead).toMatchObject({
      status: "failed",
      failureReason: "vision_read_produced_no_text",
      visionApplied: false,
    });
    expect(fakeState.visionReadPatches[0]?.visionRead).not.toHaveProperty("absent");
  });

  it("records artifact_bytes_missing when capture bytes are unavailable", async () => {
    fakeState.artifactRows = [
      {
        id: ART_MISSING,
        jobId: JOB_ID,
        recordingRef: "2024-300",
        documentType: null,
        storagePath: null,
        metadata: { captureLabel: "detail-page" },
      },
    ];
    fakeState.metadataByArtifactId.set(ART_MISSING, { captureLabel: "detail-page" });

    const { processRecordsRequestJobVisionReads } = await import(
      "../recordsRequestVisionRead"
    );
    const { vision } = await processRecordsRequestJobVisionReads(JOB_ID, {
      readArtifact: mockReadArtifact,
      runClassification: false,
    });

    expect(vision[0]).toMatchObject({
      status: "failed",
      failureReason: "artifact_bytes_missing",
    });
    expect(mockReadArtifact).not.toHaveBeenCalled();
    expect(fakeState.visionReadPatches[0]?.visionRead).toMatchObject({
      status: "failed",
      failureReason: "artifact_bytes_missing",
    });
  });
});
