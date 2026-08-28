import { describe, expect, it } from "vitest";
import {
  artifactHasPersistedDocument,
  capturePngBytesFromMetadata,
  documentUrlForArtifact,
  enrichRecordsRequestJobWire,
  recordsRequestArtifactDocumentUrl,
} from "../recordsRequestDocumentServe";

const PNG_B64 = Buffer.from("png-bytes").toString("base64");

describe("recordsRequestDocumentServe", () => {
  it("builds the auth-gated artifact document path", () => {
    expect(recordsRequestArtifactDocumentUrl("art-1")).toBe(
      "/api/property-explorer/v1/records-request/artifacts/art-1/document",
    );
  });

  it("exposes documentUrl only when the artifact already has a capture or storage path", () => {
    expect(
      documentUrlForArtifact({
        id: "art-empty",
        storagePath: null,
        metadata: {},
      }),
    ).toBeNull();
    expect(
      artifactHasPersistedDocument({ storagePath: null, metadata: {} }),
    ).toBe(false);

    expect(
      documentUrlForArtifact({
        id: "art-png",
        storagePath: null,
        metadata: { capturePngBase64: PNG_B64 },
      }),
    ).toBe("/api/property-explorer/v1/records-request/artifacts/art-png/document");
  });

  it("stamps documentUrl onto matching index hits and leaves unmatched hits null", () => {
    const wire = enrichRecordsRequestJobWire(
      {
        jobId: "job-1",
        scopeSearched: {
          indexHits: [
            { recordingRef: "2024-1", parties: null },
            { recordingRef: "2024-2", parties: null },
          ],
        },
      },
      [
        {
          id: "art-1",
          recordingRef: "2024-1",
          acquisitionMethod: "capture",
          storagePath: null,
          metadata: { capturePngBase64: PNG_B64 },
        },
      ],
    );
    const hits = (wire.scopeSearched as { indexHits: Array<{ documentUrl: string | null }> })
      .indexHits;
    expect(hits[0]?.documentUrl).toBe(
      "/api/property-explorer/v1/records-request/artifacts/art-1/document",
    );
    expect(hits[1]?.documentUrl).toBeNull();
    expect(wire.artifacts).toEqual([
      {
        artifactId: "art-1",
        recordingRef: "2024-1",
        documentUrl:
          "/api/property-explorer/v1/records-request/artifacts/art-1/document",
        acquisitionMethod: "capture",
        classifyStatus: null,
        refuseCode: null,
      },
    ]);
  });

  it("keeps a refused artifact on the job GET wire with status and refuse code", () => {
    const wire = enrichRecordsRequestJobWire(
      {
        jobId: "job-1",
        scopeSearched: {
          indexHits: [{ recordingRef: "2024-9", documentType: null }],
        },
      },
      [
        {
          id: "art-refused",
          recordingRef: "2024-9",
          acquisitionMethod: "capture",
          storagePath: null,
          metadata: {
            classify: {
              status: "refused",
              refuseCode: "unclassifiable_document_type",
              refuseMessage: "Document type is absent; refuse rather than invent a kind",
            },
          },
        },
      ],
    );
    const artifacts = wire.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      artifactId: "art-refused",
      recordingRef: "2024-9",
      documentUrl: null,
      acquisitionMethod: "capture",
      classifyStatus: "refused",
      refuseCode: "unclassifiable_document_type",
    });
    expect(artifacts[0]?.classifyStatus).not.toBeNull();
    expect(artifacts[0]?.classifyStatus).not.toBe("written");
  });

  it("reads the persisted capture bytes", () => {
    const bytes = capturePngBytesFromMetadata({ capturePngBase64: PNG_B64 });
    expect(bytes?.toString()).toBe("png-bytes");
    expect(capturePngBytesFromMetadata({})).toBeNull();
  });
});
