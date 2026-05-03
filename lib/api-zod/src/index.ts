// Runtime zod schemas (request bodies, params, responses)
export * from "./generated/api";

// Hand-written types (BE source-of-truth; CT mirrors into OpenAPI).
// Lives outside `./generated/` so orval's `clean: true` does not wipe it.
export * from "./types/planReviewDiscipline";

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
  SubmissionReceipt,
  SubmissionStatus,
  User,
} from "./generated/types";

// `CreateUserBody` and `UpdateUserBody` are intentionally NOT re-exported
// as types here — they collide with the zod consts of the same name from
// `./generated/api`, and adding them to a `type`-only re-export would
// shadow the value side at compile time (matching the existing pattern
// for `UpdateEngagementBody` and `CreateEngagementSubmissionBody`, which
// flow through the `export *` value+type pair only). Consumers that need
// the TS type can derive it via `z.infer<typeof CreateUserBody>` or
// import from `@workspace/api-client-react` (which re-exports the
// generated interface alongside the React Query hooks).
