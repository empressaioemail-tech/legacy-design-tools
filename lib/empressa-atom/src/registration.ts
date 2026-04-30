/**
 * Atom registration contract — Spec 20 §4.
 *
 * An {@link AtomRegistration} declares the four-layer contract that every
 * Empressa atom must satisfy: identity, context interface, composition
 * declaration, and history anchoring. The registration is **server-safe**:
 * it carries no React types so the registry can be used from the AI context
 * pipeline as well as the FE renderer.
 *
 * Render bindings (the React `<AtomShell>`, per-mode components, focus
 * store wiring) live in a separate package that depends on this one — not
 * the other way around. See README §"What's NOT shipped in A0".
 */

import type { AtomComposition } from "./composition";
import type { ContextSummary } from "./context";
import type { Scope } from "./scope";

/**
 * The five render modes Spec 20 §5 declares. A0 ships these as a type-only
 * contract; the React binding for each mode lands in a later sprint.
 */
export type AtomMode =
  | "inline"
  | "compact"
  | "card"
  | "expanded"
  | "focus";

/**
 * Stable reference to a single atom instance. The {@link displayLabel} is
 * populated by {@link parseInlineReferences} from the third token of
 * `{{atom:type:id:label}}`; downstream code should treat the label as
 * presentation-only and never use it for identity.
 */
export interface AtomReference {
  kind: "atom";
  entityType: string;
  entityId: string;
  mode?: AtomMode;
  /**
   * Inline-prose display label. Single source of truth for the chip text.
   * Recon H2: previously duplicated on `AtomRegistration.displayLabel`; in
   * A0 it lives only here.
   */
  displayLabel?: string;
}

/**
 * Headless atom props passed to render bindings (lives in a future
 * package). Declared here so the registration's render-mode contract is
 * complete, but free of React imports.
 */
export interface AtomProps {
  entityId: string;
  mode: AtomMode;
  data?: Record<string, unknown>;
  onAction?: (message: string) => void;
  onModeChange?: (mode: AtomMode) => void;
  onDrillIn?: (atom: AtomReference) => void;
}

/**
 * Optional chip action surfaced by the render layer when an atom appears
 * in inline prose. Generated from the underlying data, never persisted.
 */
export interface ChipAction {
  id: string;
  label: string;
  /** Free-form prompt fragment the chat will send when the chip is clicked. */
  message: string;
}

/**
 * Type-level helper that constrains `defaultMode` to a member of
 * `supportedModes`. Used as the `defaultMode` field type so registrations
 * with a mismatched default fail to typecheck (Spec 20 §4 compile-time
 * enforcement).
 */
export type DefaultModeOf<TSupported extends ReadonlyArray<AtomMode>> =
  TSupported[number];

/**
 * Type-level guard rejecting widened (non-literal) string types. When
 * `T = string` (i.e. callers passed a non-literal), `string extends T` is
 * `true` and this resolves to `never`, which makes the surrounding field
 * un-assignable. When `T = "task"` (a literal), it resolves to `T`.
 *
 * Used to enforce recon B4 / decision #3: every registration must have a
 * literal `entityType` so the registry can narrow the resolved type.
 */
export type LiteralString<T extends string> = string extends T ? never : T;

/**
 * The four-layer atom contract. Generic in `TType` (a literal string) so
 * the resolver can narrow the entity type at the call site. Recon B4:
 * preserves a compile-time union of registered types.
 *
 * @typeParam TType - Literal string type identifying the atom (e.g. `"task"`).
 * @typeParam TSupported - Tuple of supported render modes; constrains
 *   `defaultMode` at compile time.
 */
export interface AtomRegistration<
  TType extends string = string,
  TSupported extends ReadonlyArray<AtomMode> = ReadonlyArray<AtomMode>,
> {
  /**
   * Stable atom identity. The literal-only constraint is enforced at the
   * {@link AtomRegistry.register} entry point (via {@link LiteralString})
   * rather than on the type itself, so heterogeneous storage shapes
   * (`AnyAtomRegistration`) and stub builders can carry plain `TType`
   * without fighting the type system.
   */
  entityType: TType;

  /**
   * Required, queryable. Atoms are grouped by domain for prompt-builder
   * derivation (`registry.describeForPrompt()`) and for `listByDomain()`.
   * Recon B3: previously optional and unread.
   */
  domain: string;

  /** Modes the future render binding will implement. */
  supportedModes: TSupported;

  /**
   * Default mode used when the caller does not specify one. The type
   * constraint forces this to be a member of `supportedModes` —
   * registrations with a mismatched default fail to typecheck.
   */
  defaultMode: DefaultModeOf<TSupported>;

  /**
   * Optional chip-action generator invoked by the render layer when the
   * atom appears as an inline chip. Unused in A0.
   */
  chipActions?: (data: Record<string, unknown>) => ChipAction[];

  /**
   * The four-layer context resolver. Receives the entity id and a
   * {@link Scope} object; returns a typed payload (never a bare string).
   * Atoms that don't differentiate by scope can ignore the second arg.
   */
  contextSummary: (
    entityId: string,
    scope: Scope,
  ) => Promise<ContextSummary<TType>>;

  /**
   * Declarative composition graph. Pass an empty array (`[]`) to declare
   * "no children" — the field is **required** so a registration cannot
   * silently omit the composition layer of the four-layer contract
   * (Spec 20 §F). The registry validates referenced child types at
   * `validate()` and on first lookup. Recon D1/D2: was single-child and
   * unread; in A0 it is multi-child, required, and consumed.
   */
  composition: ReadonlyArray<AtomComposition>;
}

/**
 * Convenience alias for a registration whose render-mode tuple is
 * forgotten — useful for storage in heterogeneous collections (the
 * registry's `Map`). Loses the `defaultMode ⊂ supportedModes` constraint
 * so should not be used as a parameter type for `register(...)`.
 */
export type AnyAtomRegistration = AtomRegistration<
  string,
  ReadonlyArray<AtomMode>
>;
