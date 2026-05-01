/**
 * /api/atoms/:slug/:id/summary — server-side endpoint that exposes an
 * atom's four-layer `ContextSummary` to FE consumers (notably the
 * plan-review UI's atom card and the chat panel's inline-reference
 * resolver).
 *
 * The endpoint resolves the atom through the process-wide registry, so
 * adding a new atom (registered in `src/atoms/registry.ts`) automatically
 * surfaces here without touching this file. Mirrors the URL shape baked
 * into `httpContextSummary` from `@workspace/empressa-atom`:
 *   GET /atoms/:slug/:id/summary?scope=<urlencoded JSON>
 *
 * Scope handling: the body of the `scope` query param is decoded as
 * JSON and forwarded verbatim to the atom (atoms that ignore scope
 * receive an unfiltered payload). Decode failures fall back to
 * `defaultScope()` rather than 400ing — the server's stance is "scope
 * unknown → assume internal" so a misformed FE call never breaks the UI.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { defaultScope, type Scope } from "@workspace/empressa-atom";
import { getAtomRegistry, getHistoryService } from "../atoms/registry";
import { hydrateActors } from "../lib/userLookup";
import { logger } from "../lib/logger";

/** Default and hard cap for the history endpoint's page size. Mirrors the
 *  OpenAPI contract for `GET /atoms/:slug/:id/history?limit=`. */
const HISTORY_DEFAULT_LIMIT = 5;
const HISTORY_MAX_LIMIT = 50;

const router: IRouter = Router();

interface SerializedScope {
  a?: Scope["audience"];
  r?: string;
  t?: string;
  p?: ReadonlyArray<string>;
}

/**
 * Decode the `scope` query parameter. The wire format mirrors the
 * `serializeScope` helper inside `httpContextSummary` (compact keys to
 * keep URL length down: `a`/`r`/`t`/`p`). Unknown keys are ignored and
 * any decode error falls back to {@link defaultScope}.
 */
function parseScopeParam(raw: unknown): Scope {
  if (typeof raw !== "string" || raw.length === 0) return defaultScope();
  let parsed: SerializedScope;
  try {
    parsed = JSON.parse(raw) as SerializedScope;
  } catch {
    return defaultScope();
  }
  if (!parsed || typeof parsed !== "object") return defaultScope();

  const audience: Scope["audience"] =
    parsed.a === "ai" || parsed.a === "user" || parsed.a === "internal"
      ? parsed.a
      : "internal";
  const scope: Scope = { audience };
  if (parsed.r && typeof parsed.r === "string") {
    const [kind, ...rest] = parsed.r.split(":");
    if ((kind === "user" || kind === "agent") && rest.length > 0) {
      scope.requestor = { kind, id: rest.join(":") };
    }
  }
  if (parsed.t && typeof parsed.t === "string") {
    const d = new Date(parsed.t);
    if (!Number.isNaN(d.getTime())) scope.asOf = d;
  }
  if (Array.isArray(parsed.p)) {
    scope.permissions = parsed.p.filter(
      (x): x is string => typeof x === "string",
    );
  }
  return scope;
}

/**
 * GET /atoms/catalog — read-only directory of every atom registered in
 * the process-wide registry. Returns the same shape `describeForPrompt()`
 * exposes (entityType, domain, supportedModes, defaultMode, composes,
 * eventTypes), so operator surfaces (the Dev Atoms Probe page's
 * "Registered atoms" panel) can introspect the framework's vocabulary
 * without sniffing source files. No auth — the catalog is metadata about
 * the running server, not data, and it powers a dev-time UI that
 * already lives behind operator-only routes.
 *
 * Listed BEFORE the parametric `:slug` route so Express doesn't match
 * `/atoms/catalog` against the `:slug=catalog, :id=undefined` shape.
 */
router.get("/atoms/catalog", (_req: Request, res: Response) => {
  const registry = getAtomRegistry();
  res.json({ atoms: registry.describeForPrompt() });
});

router.get(
  "/atoms/:slug/:id/summary",
  async (req: Request, res: Response) => {
    const slug = String(req.params["slug"] ?? "");
    const id = String(req.params["id"] ?? "");
    if (!slug || !id) {
      res.status(400).json({ error: "Missing slug or id" });
      return;
    }

    const registry = getAtomRegistry();
    const resolved = registry.resolve(slug);
    if (!resolved.ok) {
      res.status(404).json({ error: "atom_type_not_registered", slug });
      return;
    }

    const scope = parseScopeParam(req.query["scope"]);
    try {
      const summary = await resolved.registration.contextSummary(id, scope);
      // ContextSummary is JSON-safe by construction (no Buffers, no Dates
      // — the framework requires `historyProvenance.latestEventAt` to be
      // a string).
      res.json(summary);
    } catch (err) {
      logger.error(
        { err, slug, id },
        "atoms summary: contextSummary threw",
      );
      res.status(500).json({ error: "summary_failed" });
    }
  },
);

/**
 * GET /atoms/:slug/:id/history — most-recent atom_events for one atom,
 * newest first. Used by the plan-review sheet card's inline mini-
 * timeline so reviewers can see the last few events without leaving
 * the list view.
 *
 * 404s when the slug is not a registered atom (mirrors the summary
 * route — the registry is the single source of truth for which atom
 * types exist). The id is not validated against the entity table:
 * `atom_events` stores `(entity_type, entity_id)` as opaque text and
 * an unknown id legitimately yields an empty list.
 *
 * Registration order relative to `/atoms/:slug/:id/summary` does not
 * matter — Express matches by path structure (the trailing segment
 * differs), so the two routes never overlap.
 */
router.get(
  "/atoms/:slug/:id/history",
  async (req: Request, res: Response) => {
    const slug = String(req.params["slug"] ?? "");
    const id = String(req.params["id"] ?? "");
    if (!slug || !id) {
      res.status(400).json({ error: "Missing slug or id" });
      return;
    }

    const registry = getAtomRegistry();
    const resolved = registry.resolve(slug);
    if (!resolved.ok) {
      res.status(404).json({ error: "atom_type_not_registered", slug });
      return;
    }

    // Parse + clamp `limit`: invalid input falls back to the default
    // rather than 400ing (matches the rest of the route's "be liberal
    // in what you accept from FE callers" stance).
    const rawLimit = req.query["limit"];
    let limit = HISTORY_DEFAULT_LIMIT;
    if (typeof rawLimit === "string" && rawLimit.length > 0) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        limit = Math.min(parsed, HISTORY_MAX_LIMIT);
      }
    }

    try {
      const history = getHistoryService();
      const events = await history.readHistory(
        { kind: "atom", entityType: slug, entityId: id },
        { limit, reverse: true },
      );
      // Hydrate user actors with display-name metadata from the
      // `users` profile table so timeline UIs can render
      // "Jane Doe changed the address" instead of "user:u_abc123 …".
      // Best-effort: if the lookup throws (transient DB hiccup) fall
      // back to the raw actors so the timeline still renders — the
      // raw `kind:id` label is uglier but accurate, which is better
      // than a 500 from an audit-trail endpoint.
      const rawActors = events.map((e) => e.actor);
      let hydrated = rawActors;
      try {
        hydrated = await hydrateActors(rawActors);
      } catch (err) {
        logger.warn(
          { err, slug, id },
          "atoms history: actor hydration failed, returning raw actors",
        );
      }
      // Strip chain hashes — they're an implementation detail of the
      // anchoring service and not part of the public contract. Keep
      // ISO strings for the timestamp fields per the OpenAPI schema.
      res.json({
        events: events.map((e, i) => ({
          id: e.id,
          eventType: e.eventType,
          actor: hydrated[i] ?? e.actor,
          occurredAt: e.occurredAt.toISOString(),
          recordedAt: e.recordedAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error({ err, slug, id }, "atoms history: readHistory threw");
      res.status(500).json({ error: "history_failed" });
    }
  },
);

export default router;
