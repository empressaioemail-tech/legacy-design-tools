// Runtime zod schemas (request bodies, params, responses)
export * from "./generated/api";

// TypeScript interfaces for the same OpenAPI schemas. Re-exported as
// types-only so that names which collide with the zod consts above
// (e.g. UpdateEngagementBody) resolve to the value side at runtime
// while still being available as types via `import type`.
export type {
  ChatErrorResponse,
  ChatMessage,
  ChatMessageRole,
  ChatRequest,
  EngagementDetail,
  EngagementStatus,
  EngagementSummary,
  ErrorResponse,
  Geocode,
  GeocodeSource,
  HealthStatus,
  ProjectType,
  SheetSummary,
  SheetUploadResponse,
  Site,
  SnapshotDetail,
  SnapshotDetailPayload,
  SnapshotPayload,
  SnapshotReceipt,
  SnapshotSummary,
} from "./generated/types";
