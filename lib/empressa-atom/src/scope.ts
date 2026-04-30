/**
 * Scope object passed at the call site of `contextSummary` and other
 * resolver entry points. Recon C4 / Spec 20 §4: previously absent in the
 * Empressa Demo; in A0 it is mandatory at the call site so future audience-
 * aware behavior (AI vs. user vs. internal panels) is opt-in for atoms but
 * impossible to forget at the call site.
 */

/**
 * Who is asking, with what permissions, as of when. The framework forwards
 * this verbatim to {@link AtomRegistration.contextSummary}; atoms that do
 * not differentiate by scope receive the same shape and ignore it.
 */
export interface Scope {
  /**
   * Audience the response will be shown to. Atoms may filter / redact
   * based on this value (e.g. omit internal-only metadata for `"ai"`).
   */
  audience: "ai" | "user" | "internal";

  /**
   * Identity of the requestor when known. Optional because some entry
   * points (cron warmups, system tasks) have no requestor.
   */
  requestor?: { kind: "user" | "agent"; id: string };

  /**
   * Time horizon for the response. Defaults to "now" when omitted; atoms
   * with history may use this to render an as-of view. Stored as a `Date`
   * for downstream comparison; serialize with `.toISOString()`.
   */
  asOf?: Date;

  /**
   * Optional permission claim list. The framework does no enforcement —
   * atoms decide what to do with these. Reserved for future RBAC work.
   */
  permissions?: ReadonlyArray<string>;
}

/**
 * Convenience constructor for tests and CLI tools. Returns a scope with
 * `audience: "internal"` and no requestor, suitable for trusted callers.
 *
 * @example
 *   await registration.contextSummary("id-1", defaultScope());
 */
export function defaultScope(): Scope {
  return { audience: "internal" };
}
