/**
 * Public surface for `@workspace/atoms-l-surface`.
 *
 * The mirrored Cortex L1-L6 atom-instance shapes — TypeScript types,
 * Zod schemas, and the advisory helpers (`deliverableLetterCompleteness`,
 * `isLegalPushTransition`). Consumed by the Lane C.4 L-surface
 * endpoints (api-server) and the L1-L6 UI surfaces.
 *
 * See ./instances.ts for the mirror provenance and re-mirror
 * discipline (the shapes are mirrored from @hauska-engine/atoms@0.6.0
 * because that package is private and unpublished).
 */

export * from "./instances";
