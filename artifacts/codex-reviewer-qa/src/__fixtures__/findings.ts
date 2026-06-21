/**
 * Test fixture — a representative `Finding` wire object. Shared by the
 * FindingCard and ReviewPage test suites so the wire shape is pinned
 * in one place.
 */
import type { Finding, FindingActor } from "@workspace/api-client-react";

const FIXTURE_READ_CONTRACT: Finding["readContract"] = {
  axes: {
    calibratedConfidence: {
      estimate: 0.82,
      n: 1,
      intervalWidth: 0.12,
      provenance: "asserted",
    },
    assertedConfidence: {
      estimate: 0.82,
      n: 1,
      intervalWidth: 0.12,
      provenance: "asserted",
    },
    consequence: {
      derivation: {
        source: "asce7-risk-category",
        asce7RiskCategory: "II",
      },
      stratum: "routine",
      assertedAt: "2026-06-21T00:00:00.000Z",
    },
  },
  assembledAt: "2026-06-21T00:00:00.000Z",
};

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding:sub-1:01",
    submissionId: "sub-1",
    severity: "blocker",
    category: "setback",
    status: "ai-produced",
    text: "Front setback is 12 ft; the R-1 district requires a 25 ft minimum.",
    citations: [
      {
        kind: "code-section",
        atomId: "code-section:grand-county:r1-setbacks",
      },
    ],
    confidence: 0.82,
    readContract: FIXTURE_READ_CONTRACT,
    lowConfidence: false,
    reviewerStatusBy: null,
    reviewerStatusChangedAt: null,
    reviewerComment: null,
    elementRef: null,
    sourceRef: null,
    aiGeneratedAt: "2026-05-20T14:30:00.000Z",
    revisionOf: null,
    aiGenerated: true,
    acceptedByReviewerId: null,
    acceptedAt: null,
    acceptedBy: null,
    ...overrides,
  };
}

export function makeActor(overrides: Partial<FindingActor> = {}): FindingActor {
  return {
    kind: "user",
    id: "reviewer-1",
    displayName: "Sam Lee",
    ...overrides,
  };
}
