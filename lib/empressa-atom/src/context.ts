/**
 * Four-layer context payload returned by `AtomRegistration.contextSummary`.
 *
 * Spec 20 §4 prescribes four layers — `prose`, `typed`, `keyMetrics`,
 * `relatedAtoms` — plus history provenance and a `scopeFiltered` marker
 * that lets the caller know whether the {@link Scope} object actually
 * changed the result. Recon C1: previously a bare `Promise<string>` in
 * the Empressa Demo; A0 lifts the typed shape to the canonical contract.
 */

import type { AtomReference } from "./registration";
import type { Scope } from "./scope";

/**
 * One row of the `keyMetrics` layer. `unit` is optional because some
 * metrics (counts, dates) don't have one; render bindings should display
 * `value` followed by `unit` when present.
 */
export interface KeyMetric {
  label: string;
  value: string | number;
  unit?: string;
}

/**
 * Provenance for the latest event written through
 * {@link EventAnchoringService}. Always present; if the atom has no
 * events yet, set `latestEventId: ""` and `latestEventAt` to the atom's
 * creation timestamp.
 */
export interface HistoryProvenance {
  latestEventId: string;
  latestEventAt: string;
}

/**
 * Spec 20 §4 four-layer context shape.
 *
 * @typeParam TType - Literal entity type of the atom that produced this
 *   payload. Reserved for future per-atom narrowing of the `typed` field;
 *   in A0 the field is `Record<string, unknown>` so any atom can populate
 *   it without introducing a discriminated union per atom type yet.
 */
export interface ContextSummary<_TType extends string = string> {
  /** Human-readable prose summary suitable for AI prompt insertion. */
  prose: string;

  /**
   * Atom-typed payload. A1+ atoms will narrow this with a discriminated
   * union per `entityType`; in A0 it is intentionally open so the
   * framework ships without introducing a per-atom registry-side type
   * map.
   */
  typed: Record<string, unknown>;

  /** Compact key/value tiles surfaced in card and compact modes. */
  keyMetrics: KeyMetric[];

  /** Other atoms this one references; used for crawl + chip rendering. */
  relatedAtoms: AtomReference[];

  /** Provenance of the latest history event (interface-stable in A0). */
  historyProvenance: HistoryProvenance;

  /**
   * `true` when the {@link Scope} object changed the resolved payload
   * relative to the unscoped baseline. Atoms that don't filter by scope
   * should set this to `false`; the {@link httpContextSummary} helper
   * defaults to `false`.
   */
  scopeFiltered: boolean;
}

/**
 * Configuration for {@link httpContextSummary}.
 */
export interface HttpContextSummaryOptions {
  /**
   * Base URL for the API surface that returns the typed payload. Joined
   * with `${slug}/${entityId}/summary`. Defaults to `""` so callers can
   * pass a relative path that the platform proxy resolves.
   */
  baseUrl?: string;

  /**
   * Cache TTL in milliseconds. Recon C6: server-side default was 30s;
   * preserved here so the FE wrapper does not double-charge the server.
   * Pass `0` to disable caching.
   */
  ttlMs?: number;

  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`. Useful
   * for tests and for environments where `credentials: "include"` should
   * not be the default.
   */
  fetchImpl?: typeof fetch;

  /**
   * Forwarded onto the request. Defaults to `"include"` to match the
   * Empressa Demo's behavior; tests may set `"omit"`. Typed as the union
   * of the three valid `RequestInit.credentials` values rather than the
   * DOM lib alias so this file does not require `lib: ["dom"]`.
   */
  credentials?: "include" | "omit" | "same-origin";
}

/**
 * Handle returned by {@link httpContextSummary}. Exposes the typed
 * `contextSummary` function for use in a registration plus an
 * `invalidate` hook the mutation pipeline calls when an entity changes.
 */
export interface HttpContextSummaryHandle<TType extends string> {
  contextSummary: (
    entityId: string,
    scope: Scope,
  ) => Promise<ContextSummary<TType>>;
  /** Drop the cached entry for `entityId`. Idempotent. */
  invalidate: (entityId: string) => void;
  /** Drop every cached entry. Useful for tests. */
  clear: () => void;
}

interface CacheEntry<TType extends string> {
  value: ContextSummary<TType>;
  expiresAt: number;
}

/**
 * Build a `contextSummary` callback that wraps `fetch` against a typed
 * server endpoint. Centralizes the boilerplate every Empressa Demo
 * `.reg.ts` had to write by hand (recon C3) and bakes in the 30s TTL
 * cache (recon C6) plus a mutation-invalidation hook the demo lacked
 * (recon C7). The server is expected to return a JSON body matching
 * {@link ContextSummary}; missing fields are filled with safe defaults.
 *
 * @example
 *   const summary = httpContextSummary<"task">("task", { ttlMs: 30_000 });
 *   const reg: AtomRegistration<"task", ["card"]> = {
 *     entityType: "task",
 *     domain: "sprint",
 *     supportedModes: ["card"],
 *     defaultMode: "card",
 *     contextSummary: summary.contextSummary,
 *   };
 *   // On mutation:
 *   summary.invalidate(taskId);
 */
export function httpContextSummary<TType extends string>(
  slug: TType,
  opts: HttpContextSummaryOptions = {},
): HttpContextSummaryHandle<TType> {
  const baseUrl = opts.baseUrl ?? "";
  const ttlMs = opts.ttlMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const credentials = opts.credentials ?? "include";
  const cache = new Map<string, CacheEntry<TType>>();

  const fillDefaults = (
    raw: Partial<ContextSummary<TType>>,
  ): ContextSummary<TType> => ({
    prose: raw.prose ?? "",
    typed: raw.typed ?? {},
    keyMetrics: raw.keyMetrics ?? [],
    relatedAtoms: raw.relatedAtoms ?? [],
    historyProvenance: raw.historyProvenance ?? {
      latestEventId: "",
      latestEventAt: "",
    },
    scopeFiltered: raw.scopeFiltered ?? false,
  });

  // Build a stable cache key + a stable wire-format string from a Scope.
  // Cache reuse must respect the Scope object: an `internal` audience
  // payload must not be served to an `ai` request, and an as-of-T1
  // payload must not be served for as-of-T2. Keys are produced by
  // serializing the scope's identity-affecting fields with sorted
  // permissions so logically-equivalent scopes hit the same cache row.
  const serializeScope = (scope: Scope): string => {
    const perms = scope.permissions ? [...scope.permissions].sort() : [];
    const requestor = scope.requestor
      ? `${scope.requestor.kind}:${scope.requestor.id}`
      : "";
    const asOf = scope.asOf ? scope.asOf.toISOString() : "";
    return JSON.stringify({
      a: scope.audience,
      r: requestor,
      t: asOf,
      p: perms,
    });
  };
  const cacheKeyFor = (entityId: string, scope: Scope): string =>
    `${entityId}|${serializeScope(scope)}`;

  return {
    async contextSummary(
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<TType>> {
      const now = Date.now();
      const key = cacheKeyFor(entityId, scope);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }
      // Forward the scope to the server as a single `scope` query
      // parameter (URL-encoded JSON). Atoms that ignore scope still
      // receive the same payload because the server is free to ignore
      // the parameter; atoms that filter by scope can decode it.
      const scopeParam = encodeURIComponent(serializeScope(scope));
      const url = `${baseUrl}/atoms/${slug}/${encodeURIComponent(entityId)}/summary?scope=${scopeParam}`;
      const res = await fetchImpl(url, { credentials });
      if (!res.ok) {
        throw new Error(
          `httpContextSummary(${slug}): HTTP ${res.status} fetching ${url}`,
        );
      }
      const body = (await res.json()) as Partial<ContextSummary<TType>>;
      const value = fillDefaults(body);
      if (ttlMs > 0) {
        cache.set(key, { value, expiresAt: now + ttlMs });
      }
      return value;
    },
    invalidate(entityId: string): void {
      // Drop every cached scope variant for this entity. Mutation
      // pipelines do not know which scopes a consumer has fetched, so
      // an entity-level invalidate must clear all of them.
      const prefix = `${entityId}|`;
      for (const k of cache.keys()) {
        if (k.startsWith(prefix)) cache.delete(k);
      }
    },
    clear(): void {
      cache.clear();
    },
  };
}
