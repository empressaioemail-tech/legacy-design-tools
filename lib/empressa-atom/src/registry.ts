/**
 * Atom registry runtime.
 *
 * Stores {@link AtomRegistration} instances in a `Map<string, …>` keyed by
 * `entityType`. Provides typed lookup, domain-scoped iteration, and a
 * cross-reference validator that walks every registration's composition
 * edges. No singleton — callers (tests, app bootstrap) construct their own.
 *
 * Recon B5: replaces the Empressa Demo's side-effect-import boot mechanism
 * with explicit `createAtomRegistry()` so the registry can be reset
 * between tests and built up programmatically from server code.
 *
 * Recon C8: `resolve(entityType)` returns a discriminated `Result` so
 * consumers (renderer, AI context builder) decide whether to dev-warn or
 * prod-null instead of catching exceptions.
 */

import type {
  AtomRegistration,
  AnyAtomRegistration,
  AtomMode,
  LiteralString,
} from "./registration";

/**
 * Discriminated error variant returned by {@link AtomRegistry.resolve}
 * when no registration exists for the requested `entityType`.
 */
export class AtomNotRegisteredError extends Error {
  readonly kind = "atom-not-registered" as const;
  constructor(public readonly entityType: string) {
    super(`No atom registered for entityType "${entityType}"`);
    this.name = "AtomNotRegisteredError";
  }
}

/**
 * Discriminated error variant returned by {@link AtomRegistry.validate}
 * for each composition edge whose target entity type is not registered.
 */
export interface DanglingCompositionRef {
  parentEntityType: string;
  childEntityType: string;
  dataKey: string;
}

/** Discriminated success/failure result for {@link AtomRegistry.resolve}. */
export type ResolveResult<TType extends string = string> =
  | { ok: true; registration: AtomRegistration<TType, ReadonlyArray<AtomMode>> }
  | { ok: false; error: AtomNotRegisteredError };

/** Discriminated success/failure result for {@link AtomRegistry.validate}. */
export type ValidateResult =
  | { ok: true }
  | { ok: false; errors: ReadonlyArray<DanglingCompositionRef> };

/**
 * Per-atom prompt-builder description. The AI prompt builder is expected
 * to consume an array of these and turn them into a "you can render
 * <type> using {{atom:type:id:label}}" enumeration without hardcoding
 * the type list (recon H6).
 */
export interface AtomPromptDescription {
  entityType: string;
  domain: string;
  supportedModes: ReadonlyArray<AtomMode>;
  defaultMode: AtomMode;
  composes: ReadonlyArray<string>;
  /**
   * Event-type vocabulary the atom self-declares via
   * {@link AtomRegistration.eventTypes}. Always an array — atoms that
   * don't declare events surface as `[]` rather than `undefined` so
   * downstream tooling (catalog UIs, audit-log filters) can map over
   * the field without nullish guards.
   */
  eventTypes: ReadonlyArray<string>;
}

/**
 * The registry's public surface. Returned by {@link createAtomRegistry}.
 *
 * The {@link register} method is generic so the inferred literal type of
 * the registration narrows the result of {@link resolve} when the same
 * literal is passed in.
 */
export interface AtomRegistry {
  /**
   * Register an atom. The `entityType` field is constrained to a literal
   * string via {@link LiteralString} so the registry can narrow the
   * resolved type — non-literal (`string`) values are rejected at compile
   * time. Pass a literal (e.g. `"task"`) or apply `as const`.
   */
  register: <TType extends string, TSupported extends ReadonlyArray<AtomMode>>(
    registration: AtomRegistration<TType, TSupported> & {
      entityType: LiteralString<TType>;
    },
  ) => void;
  /**
   * Register a pre-built, type-erased registration. Bypasses the literal
   * `entityType` constraint enforced by {@link register} — intended for
   * trusted internal callers (test harnesses, dynamic atom loaders) that
   * have already validated the shape. Application code should always use
   * {@link register} so it gets the literal narrowing.
   */
  registerAny: (registration: AnyAtomRegistration) => void;
  resolve: <TType extends string>(entityType: TType) => ResolveResult<TType>;
  list: () => ReadonlyArray<AnyAtomRegistration>;
  listByDomain: (domain: string) => ReadonlyArray<AnyAtomRegistration>;
  validate: () => ValidateResult;
  describeForPrompt: () => ReadonlyArray<AtomPromptDescription>;
}

/**
 * Build a fresh, empty registry. Tests construct their own; the eventual
 * app bootstrap will construct one and register catalog atoms explicitly.
 *
 * Boot-time contract: after every `register()` call has run, the
 * application bootstrap MUST call {@link AtomRegistry.validate} once and
 * fail to start if the result is `{ ok: false }`. The registry does not
 * validate composition references on each `register()` (the parent may
 * legitimately be registered before the child) and `resolve()` does not
 * recheck them on lookup either, so dangling cross-references would
 * otherwise surface only at composition-resolution time. Treating
 * `validate()` as a hard boot gate keeps the contract enforceable
 * without paying its cost on every call.
 *
 * Per Spec 20 decision #3, a composition edge may opt out of presence
 * validation by setting `forwardRef: true`. Forward-ref edges are
 * skipped by both `validate()` (so the bootstrap doesn't crash on a
 * not-yet-registered child) and the lookup-time `resolveComposition`
 * step (so the parent's `contextSummary` keeps returning a successful
 * result, with zero child references for that edge, until the child
 * catalog atom registers).
 */
export function createAtomRegistry(): AtomRegistry {
  const store = new Map<string, AnyAtomRegistration>();

  function insert(reg: AnyAtomRegistration) {
    if (store.has(reg.entityType)) {
      throw new Error(`Atom "${reg.entityType}" is already registered`);
    }
    store.set(reg.entityType, reg);
  }

  const registry: AtomRegistry = {
    register(registration) {
      insert(registration as unknown as AnyAtomRegistration);
    },
    registerAny(registration) {
      insert(registration);
    },

    resolve<TType extends string>(entityType: TType): ResolveResult<TType> {
      const reg = store.get(entityType);
      if (!reg) {
        return { ok: false, error: new AtomNotRegisteredError(entityType) };
      }
      return {
        ok: true,
        registration: reg as unknown as AtomRegistration<
          TType,
          ReadonlyArray<AtomMode>
        >,
      };
    },

    list(): ReadonlyArray<AnyAtomRegistration> {
      return Array.from(store.values());
    },

    listByDomain(domain) {
      return Array.from(store.values()).filter((r) => r.domain === domain);
    },

    validate(): ValidateResult {
      const errors: DanglingCompositionRef[] = [];
      for (const reg of store.values()) {
        for (const edge of reg.composition) {
          // Spec 20 decision #3: forward-ref edges deliberately point at
          // a child atom that has not been registered yet (typically a
          // future-sprint catalog atom). The parent has opted out of
          // boot-time presence validation; the lookup-time
          // `resolveComposition` step still rejects the edge if the
          // child is still missing when contextSummary runs.
          if (edge.forwardRef) continue;
          if (!store.has(edge.childEntityType)) {
            errors.push({
              parentEntityType: reg.entityType,
              childEntityType: edge.childEntityType,
              dataKey: edge.dataKey,
            });
          }
        }
      }
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    },

    describeForPrompt() {
      return Array.from(store.values()).map((reg) => ({
        entityType: reg.entityType,
        domain: reg.domain,
        supportedModes: reg.supportedModes,
        defaultMode: reg.defaultMode,
        composes: reg.composition.map((c) => c.childEntityType),
        // Normalize undefined → empty array so consumers can map over the
        // field without a nullish guard. The registration field itself is
        // optional (undeclared = "no declared events"); the catalog
        // surfaces always returns an array.
        eventTypes: reg.eventTypes ?? [],
      }));
    },
  };

  return registry;
}
