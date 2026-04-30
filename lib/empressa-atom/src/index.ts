/**
 * Public surface of `@workspace/empressa-atom`.
 *
 * The barrel re-exports every primitive but never anything from
 * `src/testing/` — testing utilities live behind the `./testing` subpath
 * so production bundles never pull them in.
 *
 * See `lib/empressa-atom/README.md` for the contract walk-through and the
 * "what's NOT shipped in A0" deferred-surface list.
 */

export type {
  AtomMode,
  AtomReference,
  AtomProps,
  ChipAction,
  AtomRegistration,
  AnyAtomRegistration,
  DefaultModeOf,
} from "./registration";

export type { Scope } from "./scope";
export { defaultScope } from "./scope";

export type {
  ContextSummary,
  KeyMetric,
  HistoryProvenance,
  HttpContextSummaryOptions,
  HttpContextSummaryHandle,
} from "./context";
export { httpContextSummary } from "./context";

export type {
  AtomComposition,
  ResolvedChild,
  CompositionRegistryView,
} from "./composition";
export { resolveComposition } from "./composition";

export {
  FALLBACK_ORDER,
  resolveMode,
} from "./render";

export type {
  ParsedSegment,
  ParsedTextSegment,
  ParsedAtomSegment,
} from "./inline-reference";
export {
  INLINE_ATOM_REGEX,
  parseInlineReferences,
  serializeInlineReference,
} from "./inline-reference";

export type {
  EventActor,
  AppendEventInput,
  AtomEvent,
  ReadHistoryOptions,
  EventAnchoringService,
  DrizzleLikeDb,
} from "./history";
export { PostgresEventAnchoringService } from "./history";

export type { VdaEnvelope, WrappedValue } from "./vda";
export { wrapForStorage, unwrapFromStorage } from "./vda";

export type {
  AtomRegistry,
  ResolveResult,
  ValidateResult,
  DanglingCompositionRef,
  AtomPromptDescription,
} from "./registry";
export { createAtomRegistry, AtomNotRegisteredError } from "./registry";
