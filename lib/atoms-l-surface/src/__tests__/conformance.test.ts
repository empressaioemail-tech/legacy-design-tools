/**
 * Conformance suite for the mirrored L-surface atom schemas.
 *
 * Each representative example is a full atom instance shaped per the
 * canonical endpoint contract
 * (doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md)
 * — the endpoints return exactly these instances. If the mirror in
 * instances.ts drifts from the engine shapes (or the contract), a
 * representative payload stops parsing and this suite fails CI rather
 * than the divergence surfacing at runtime.
 */
import { describe, it, expect } from "vitest";
import {
  RESPONSE_TASK_SCHEMA,
  SHEET_CONTENT_EXTRACTION_SCHEMA,
  ATTACHED_DOCUMENT_SCHEMA,
  DELIVERABLE_LETTER_SCHEMA,
  DETAIL_CALLOUT_SPEC_SCHEMA,
  PRODUCT_SPEC_REFERENCE_SCHEMA,
  DELIVERABLE_LETTER_RENDER_SCHEMA,
  deliverableLetterCompleteness,
  isLegalPushTransition,
  CORTEX_ATOM_ENTITY_TYPES,
} from "../instances";

/** The seven `BaseAtomInstance` fields every L-atom carries. */
function base(entityType: string, entityId: string) {
  return {
    entityType,
    entityId,
    jurisdictionTenant: "tenant-empressa",
    fetchedAt: "2026-05-19T12:00:00.000Z",
    sourceAdapter: "legacy-design-tools",
    sourceUrl: "",
    contentHash: "sha256:deadbeef",
  };
}

const responseTask = {
  ...base("response-task", "rt-1"),
  title: "Respond to comment 7",
  description: "Revise the egress width per IBC 1005.",
  state: "open",
  createdAt: "2026-05-19T12:00:00.000Z",
  dueAt: null,
  completedAt: null,
  sourceClientCommentId: null,
  findingId: "finding-9",
  engagementId: "eng-1",
  actorId: null,
  principalActorId: null,
  accessPolicy: "tenant-private",
};

const sheetContentExtraction = {
  ...base("sheet-content-extraction", "sce-1"),
  sourceSheetId: "sheet-1",
  engagementId: "eng-1",
  pageLabel: "A-101",
  extractedTextSegments: [
    {
      text: "DOOR SCHEDULE",
      boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      sourceConfidence: 0.98,
    },
  ],
  structuredAnnotations: [
    {
      kind: "schedule-row",
      position: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
      content: "101 | Single | 3'-0\"",
      sourceConfidence: 0.9,
    },
  ],
  ocrModel: "claude-sonnet-4-5",
  actorId: null,
  accessPolicy: "tenant-private",
};

const attachedDocument = {
  ...base("attached-document", "ad-1"),
  engagementId: "eng-1",
  title: "Structural calculations",
  documentType: "calculation",
  extractedText: "Roof live load 20 psf ...",
  originalBlobRef: "gs://cortex-blobs/ad-1.pdf",
  actorId: null,
  accessPolicy: "tenant-private",
};

const deliverableLetter = {
  ...base("deliverable-letter", "dl-1"),
  engagementId: "eng-1",
  title: "Comment response letter",
  status: "draft",
  recipientActorId: null,
  sections: [
    {
      kind: "cover",
      heading: "",
      content: "Cover page",
      provenance: {
        responseTaskIds: [],
        sheetContentExtractionIds: [],
        findingIds: [],
        adjudicationStateIds: [],
      },
    },
  ],
  createdAt: "2026-05-19T12:00:00.000Z",
  sentAt: null,
  actorId: null,
  principalActorId: null,
  accessPolicy: "tenant-private",
};

const detailCalloutSpec = {
  ...base("detail-callout-spec", "dcs-1"),
  engagementId: "eng-1",
  spec: {
    detailType: "door-schedule",
    rows: [
      {
        doorMark: "101",
        doorType: "Single",
        width: "3'-0\"",
        height: "7'-0\"",
        material: "Hollow metal",
        fireRating: "20 min",
        hardwareSet: "HW-1",
      },
    ],
  },
  pushState: "pending",
  apsTaskRef: null,
  findingId: null,
  responseTaskId: null,
  createdAt: "2026-05-19T12:00:00.000Z",
  pushedAt: null,
  actorId: null,
  principalActorId: null,
  accessPolicy: "tenant-private",
};

const productSpecReference = {
  ...base("product-spec-reference", "psr-1"),
  product: { name: "Strong-Drive SDWS Timber Screw", manufacturer: "Simpson Strong-Tie" },
  esrNumber: "ESR-1234",
  status: "active",
  lastVerifiedAt: "2026-05-19T12:00:00.000Z",
  statusHistory: [
    {
      status: "active",
      changedAt: "2026-05-19T12:00:00.000Z",
      sourceUrl: "https://icc-es.org/report-listing/esr-1234/",
    },
  ],
  engagementId: "eng-1",
  findingId: null,
  responseTaskId: null,
  createdAt: "2026-05-19T12:00:00.000Z",
  actorId: null,
  principalActorId: null,
  accessPolicy: "tenant-private",
};

const deliverableLetterRender = {
  ...base("deliverable-letter-render", "dlr-1"),
  sourceLetterRef: "did:hauska:deliverable-letter:dl-1",
  sourceLetterVersion: "sha256:cafef00d",
  format: "pdf",
  blobRef: "gs://cortex-blobs/dlr-1.pdf",
  renderedAt: "2026-05-19T12:00:00.000Z",
  renderedByActorId: null,
  accessPolicy: "tenant-private",
};

describe("L-surface atom schemas accept conformant instances", () => {
  it("L1 response-task", () => {
    expect(RESPONSE_TASK_SCHEMA.safeParse(responseTask).success).toBe(true);
  });
  it("L2a sheet-content-extraction", () => {
    expect(
      SHEET_CONTENT_EXTRACTION_SCHEMA.safeParse(sheetContentExtraction).success,
    ).toBe(true);
  });
  it("L2b attached-document", () => {
    expect(
      ATTACHED_DOCUMENT_SCHEMA.safeParse(attachedDocument).success,
    ).toBe(true);
  });
  it("L3 deliverable-letter", () => {
    expect(
      DELIVERABLE_LETTER_SCHEMA.safeParse(deliverableLetter).success,
    ).toBe(true);
  });
  it("L4 detail-callout-spec (door-schedule)", () => {
    expect(
      DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(detailCalloutSpec).success,
    ).toBe(true);
  });
  it("L4 detail-callout-spec (wall-section discriminant arm)", () => {
    const wallSection = {
      ...detailCalloutSpec,
      entityId: "dcs-2",
      spec: {
        detailType: "wall-section",
        sectionMark: "A/A-501",
        cutLocation: "Exterior wall at grid 3",
        assemblyLayers: [
          { material: "Gypsum board", thickness: "5/8\"", function: "finish" },
        ],
        baseDatum: "T.O. Slab",
        topDatum: "T.O. Parapet",
      },
    };
    expect(DETAIL_CALLOUT_SPEC_SCHEMA.safeParse(wallSection).success).toBe(true);
  });
  it("L5 product-spec-reference", () => {
    expect(
      PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse(productSpecReference).success,
    ).toBe(true);
  });
  it("L6 deliverable-letter-render", () => {
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse(deliverableLetterRender)
        .success,
    ).toBe(true);
  });
});

describe("L-surface atom schemas reject contract violations", () => {
  it("rejects an unknown response-task state", () => {
    expect(
      RESPONSE_TASK_SCHEMA.safeParse({ ...responseTask, state: "frozen" })
        .success,
    ).toBe(false);
  });
  it("rejects an esrNumber that is not ESR-<digits>", () => {
    expect(
      PRODUCT_SPEC_REFERENCE_SCHEMA.safeParse({
        ...productSpecReference,
        esrNumber: "1234",
      }).success,
    ).toBe(false);
  });
  it("rejects a detail-callout spec payload missing its arm fields", () => {
    expect(
      DETAIL_CALLOUT_SPEC_SCHEMA.safeParse({
        ...detailCalloutSpec,
        spec: { detailType: "door-schedule" },
      }).success,
    ).toBe(false);
  });
  it("rejects a sourceLetterRef that is not a deliverable-letter DID", () => {
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse({
        ...deliverableLetterRender,
        sourceLetterRef: "did:hauska:finding:finding-9",
      }).success,
    ).toBe(false);
  });
  it("rejects an unsupported render format", () => {
    expect(
      DELIVERABLE_LETTER_RENDER_SCHEMA.safeParse({
        ...deliverableLetterRender,
        format: "rtf",
      }).success,
    ).toBe(false);
  });
});

describe("advisory helpers", () => {
  it("deliverableLetterCompleteness flags a missing required section", () => {
    const result = deliverableLetterCompleteness([
      { kind: "cover", heading: "", content: "", provenance: emptyProvenance() },
      { kind: "intro", heading: "", content: "", provenance: emptyProvenance() },
    ]);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["signature"]);
  });
  it("deliverableLetterCompleteness passes a complete section set", () => {
    const result = deliverableLetterCompleteness([
      { kind: "cover", heading: "", content: "", provenance: emptyProvenance() },
      { kind: "intro", heading: "", content: "", provenance: emptyProvenance() },
      {
        kind: "signature",
        heading: "",
        content: "",
        provenance: emptyProvenance(),
      },
    ]);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });
  it("isLegalPushTransition matches the L4 push lifecycle", () => {
    expect(isLegalPushTransition("pending", "pushed")).toBe(true);
    expect(isLegalPushTransition("pushed", "applied")).toBe(true);
    expect(isLegalPushTransition("rejected-by-user", "pending")).toBe(true);
    expect(isLegalPushTransition("pending", "applied")).toBe(false);
    expect(isLegalPushTransition("applied", "pending")).toBe(false);
  });
});

describe("entity-type registry", () => {
  it("enumerates all seven Cortex L-surface atom types", () => {
    expect([...CORTEX_ATOM_ENTITY_TYPES].sort()).toEqual(
      [
        "attached-document",
        "deliverable-letter",
        "deliverable-letter-render",
        "detail-callout-spec",
        "product-spec-reference",
        "response-task",
        "sheet-content-extraction",
      ].sort(),
    );
  });
});

function emptyProvenance() {
  return {
    responseTaskIds: [],
    sheetContentExtractionIds: [],
    findingIds: [],
    adjudicationStateIds: [],
  };
}
