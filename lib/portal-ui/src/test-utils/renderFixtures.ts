/**
 * Render fixtures shared by portal-ui + design-tools tests. Mirrors
 * the wire shape returned by `GET /engagements/{id}/renders` and
 * `GET /renders/{id}` so adopting tests don't re-derive the contract.
 */

import type {
  RenderDetailResponse,
  RenderListItem,
  RenderOutputProjection,
  ElevationSetJob,
} from "@workspace/api-client-react";

const NOW_ISO = "2026-05-02T12:00:00.000Z";
const ONE_MIN_AGO = "2026-05-02T11:59:00.000Z";
const FIVE_MIN_AGO = "2026-05-02T11:55:00.000Z";

export const fixtureReadyStill: RenderListItem = {
  id: "render-ready-1",
  kind: "still",
  status: "ready",
  errorCode: null,
  requestedBy: "user:architect-1",
  createdAt: FIVE_MIN_AGO,
  updatedAt: NOW_ISO,
  completedAt: NOW_ISO,
};

export const fixtureRenderingStill: RenderListItem = {
  id: "render-rendering-1",
  kind: "still",
  status: "rendering",
  errorCode: null,
  requestedBy: "user:architect-1",
  createdAt: ONE_MIN_AGO,
  updatedAt: ONE_MIN_AGO,
  completedAt: null,
};

export const fixtureFailedStill: RenderListItem = {
  id: "render-failed-1",
  kind: "still",
  status: "failed",
  errorCode: "mnml_quota_exceeded",
  requestedBy: "user:architect-1",
  createdAt: FIVE_MIN_AGO,
  updatedAt: FIVE_MIN_AGO,
  completedAt: FIVE_MIN_AGO,
};

export const fixtureReadyStillOutput: RenderOutputProjection = {
  id: "output-ready-1",
  role: "primary",
  format: "png",
  resolution: "2048x1152",
  sizeBytes: 1_500_000,
  durationSeconds: null,
  mirroredObjectKey: "renders/render-ready-1/primary.png",
  thumbnailUrl: null,
  previewUrl: "/api/render-outputs/output-ready-1/file",
  downloadUrl: "/api/render-outputs/output-ready-1/file?download=1",
  seed: 12345,
};

export const fixtureReadyStillDetail: RenderDetailResponse = {
  id: fixtureReadyStill.id,
  engagementId: "eng-1",
  kind: "still",
  status: "ready",
  mnmlJobId: "mnml-job-1",
  mnmlJobs: null,
  errorCode: null,
  errorMessage: null,
  errorDetails: null,
  requestedBy: "user:architect-1",
  createdAt: fixtureReadyStill.createdAt,
  updatedAt: fixtureReadyStill.updatedAt,
  completedAt: fixtureReadyStill.completedAt,
  outputs: [fixtureReadyStillOutput],
};

export const fixtureRenderingStillDetail: RenderDetailResponse = {
  id: fixtureRenderingStill.id,
  engagementId: "eng-1",
  kind: "still",
  status: "rendering",
  mnmlJobId: "mnml-job-2",
  mnmlJobs: null,
  errorCode: null,
  errorMessage: null,
  errorDetails: null,
  requestedBy: "user:architect-1",
  createdAt: fixtureRenderingStill.createdAt,
  updatedAt: fixtureRenderingStill.updatedAt,
  completedAt: null,
  outputs: [],
};

export const fixtureFailedStillDetail: RenderDetailResponse = {
  id: fixtureFailedStill.id,
  engagementId: "eng-1",
  kind: "still",
  status: "failed",
  mnmlJobId: "mnml-job-3",
  mnmlJobs: null,
  errorCode: "mnml_quota_exceeded",
  errorMessage: "mnml.ai quota exceeded for this account.",
  errorDetails: null,
  requestedBy: "user:architect-1",
  createdAt: fixtureFailedStill.createdAt,
  updatedAt: fixtureFailedStill.updatedAt,
  completedAt: fixtureFailedStill.completedAt,
  outputs: [],
};

export const fixtureElevationSetInFlight: RenderListItem = {
  id: "render-elev-1",
  kind: "elevation-set",
  status: "rendering",
  errorCode: null,
  requestedBy: "user:architect-1",
  createdAt: ONE_MIN_AGO,
  updatedAt: ONE_MIN_AGO,
  completedAt: null,
};

const elevJobs: ElevationSetJob[] = [
  {
    role: "elevation-n",
    cameraDirection: "front",
    mnmlJobId: "mnml-job-n",
    status: "ready",
    outputUrl: "https://example.com/render-elev-1/n.png",
    mirroredObjectKey: "renders/render-elev-1/n.png",
  },
  {
    role: "elevation-e",
    cameraDirection: "right",
    mnmlJobId: "mnml-job-e",
    status: "rendering",
  },
  {
    role: "elevation-s",
    cameraDirection: "back",
    mnmlJobId: "mnml-job-s",
    status: "queued",
  },
  {
    role: "elevation-w",
    cameraDirection: "left",
    mnmlJobId: null,
    status: "pending-trigger",
  },
];

export const fixtureElevationSetDetail: RenderDetailResponse = {
  id: fixtureElevationSetInFlight.id,
  engagementId: "eng-1",
  kind: "elevation-set",
  status: "rendering",
  mnmlJobId: null,
  mnmlJobs: elevJobs,
  errorCode: null,
  errorMessage: null,
  errorDetails: null,
  requestedBy: "user:architect-1",
  createdAt: fixtureElevationSetInFlight.createdAt,
  updatedAt: fixtureElevationSetInFlight.updatedAt,
  completedAt: null,
  outputs: [
    {
      id: "output-elev-n",
      role: "elevation-n",
      format: "png",
      resolution: "1024x576",
      sizeBytes: 500_000,
      durationSeconds: null,
      mirroredObjectKey: "renders/render-elev-1/n.png",
      thumbnailUrl: null,
      previewUrl: "/api/render-outputs/output-elev-n/file",
      downloadUrl: "/api/render-outputs/output-elev-n/file?download=1",
      seed: 222,
    },
  ],
};
