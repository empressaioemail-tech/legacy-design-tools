/**
 * Process-wide atom registry for the api-server.
 *
 * Built once at module load (idempotent) and exported as a singleton so
 * route handlers (`chat.ts`, `atoms.ts`) and the boot script all see the
 * same set of registrations.
 *
 * Boot-time contract per `lib/empressa-atom/README.md`: every consumer
 * MUST call {@link bootstrapAtomRegistry} once at startup and fail-fast
 * when `validate()` returns `{ ok: false }`. The registry does not
 * re-validate composition on every `register()` call (a parent may
 * legitimately register before its child) so the bootstrapper is the
 * only place dangling references are caught.
 */

import {
  createAtomRegistry,
  type AtomRegistry,
  PostgresEventAnchoringService,
  type EventAnchoringService,
} from "@workspace/empressa-atom";
import { db } from "@workspace/db";
import { makeSheetAtom } from "./sheet.atom";
import { makeEngagementAtom } from "./engagement.atom";
import { makeSnapshotAtom } from "./snapshot.atom";
import { makeSubmissionAtom } from "./submission.atom";
import { makeParcelBriefingAtom } from "./parcel-briefing.atom";
import { makeIntentAtom } from "./intent.atom";
import { makeBriefingSourceAtom } from "./briefing-source.atom";
import { makeNeighboringContextAtom } from "./neighboring-context.atom";
import { makeBimModelAtom } from "./bim-model.atom";
import { makeMaterializableElementAtom } from "./materializable-element.atom";
import { makeBriefingDivergenceAtom } from "./briefing-divergence.atom";
import { makeReviewerAnnotationAtom } from "./reviewer-annotation.atom";
import { makeViewpointRenderAtom } from "./viewpoint-render.atom";
import { makeRenderOutputAtom } from "./render-output.atom";

/**
 * Lightweight logger interface accepted by {@link bootstrapAtomRegistry}.
 * Matches the shape of the project's pino logger without forcing a hard
 * dependency on the singleton — the test suite passes `console`.
 */
export interface BootstrapAtomsLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * The process-wide registry. Created lazily on first access so importing
 * this module from a test file that mocks `@workspace/db` doesn't capture
 * the real db at module load time.
 */
let _registry: AtomRegistry | null = null;
let _history: EventAnchoringService | null = null;

/**
 * Lazily-constructed process-wide {@link EventAnchoringService} singleton
 * backed by the prod Postgres `db`. Exposed (in addition to being injected
 * into atom factories) so consumer code paths — most notably the snapshot
 * sheet ingest route — can append `*.created`/`*.updated` events through
 * the same instance the atoms read from in `contextSummary`.
 *
 * Idempotent: repeated calls return the same instance. Tests can drop the
 * cache via {@link resetAtomRegistryForTests}.
 */
export function getHistoryService(): EventAnchoringService {
  if (_history) return _history;
  // The Postgres history service is structurally typed against drizzle's
  // execute() shape; the prod `db` satisfies that contract.
  _history = new PostgresEventAnchoringService(
    db as unknown as ConstructorParameters<
      typeof PostgresEventAnchoringService
    >[0],
  );
  return _history;
}

/**
 * Build (or return the existing) registry, registering every catalog
 * atom owned by api-server. Idempotent — repeated calls return the same
 * instance without re-registering, which would otherwise throw on the
 * duplicate `entityType`.
 *
 * Catalog atoms registered today:
 *   - `sheet` (domain: `plan-review`)
 *   - `engagement` (domain: `plan-review`) — composes `snapshot` and
 *     `submission` as concrete children plus a concrete edge to the
 *     (DA-PI-1) `parcel-briefing` atom; its registration receives the
 *     registry so `resolveComposition` can look every edge up at
 *     lookup time.
 *   - `snapshot` (domain: `plan-review`) — composes `sheet` as a child;
 *     its registration receives the registry as a dep so the
 *     composition resolver can look up `sheet` at lookup time.
 *   - `submission` (domain: `plan-review`) — leaf atom backed by the
 *     `submissions` table populated by
 *     `POST /api/engagements/:id/submissions` (sprint A4 / Task #63).
 *   - `parcel-briefing` (DA-PI-1, shape-only) — composes `intent`,
 *     `briefing-source`, and forward-ref edges to `parcel` (DA-PI-2/4)
 *     and `code-section` (Code Library catalog atom not yet shimmed).
 *     The data engine that fills `contextSummary` ships in DA-PI-3.
 *   - `intent` (DA-PI-1, shape-only) — composes a forward-ref `parcel`
 *     edge.
 *   - `briefing-source` (DA-PI-1, shape-only) — composes
 *     `parcel-briefing` and a forward-ref `parcel` edge.
 *   - `neighboring-context` (DA-PI-1, shape-only) — composes
 *     `briefing-source` and a forward-ref `parcel` edge.
 *   - `bim-model` (DA-PI-5) — design-tools-side record of the
 *     architect's active Revit model bound to an engagement; composes
 *     `engagement`, `parcel-briefing` (activeBriefing), forward-ref
 *     `materializable-element`, and concrete `briefing-divergence`.
 *   - `materializable-element` (DA-PI-5) — one piece of geometry
 *     (terrain, setback plane, buildable envelope, …) the C# Revit
 *     add-in materializes; composes `parcel-briefing`,
 *     `briefing-source`, and `briefing-divergence`. The
 *     briefing-generate route also emits one
 *     `materializable-element.identified` event per requirement
 *     extracted from the C/D/F sections of every generation
 *     (Task #175).
 *   - `briefing-divergence` (DA-PI-5) — audit-trail row for an
 *     architect override against a locked materializable element;
 *     composes `bim-model`, `materializable-element`,
 *     `parcel-briefing`.
 *   - `reviewer-annotation` (Wave 2 Sprint C / Spec 307) — declarative
 *     reviewer note bound to one of multiple potential target types
 *     (submission, briefing-source, materializable-element,
 *     briefing-divergence, sheet, parcel-briefing); only the matching
 *     target edge is populated at lookup time.
 *   - `viewpoint-render` (DA-RP-0, shape-only) — the render the
 *     architect requested from mnml.ai for an engagement that has a
 *     `parcel-briefing` and a `bim-model`; composes `engagement`,
 *     `parcel-briefing` (briefingAtRender), `bim-model`
 *     (bimModelAtRender), and `neighboring-context`
 *     (neighboringContextAtRender, optional). All four edges concrete.
 *     The renders persistence layer ships in DA-RP-1.
 *   - `render-output` (DA-RP-0, shape-only) — a single output file
 *     produced by a `viewpoint-render` (e.g. one of an elevation set's
 *     four images, the mp4 of a video render); composes
 *     `viewpoint-render` (concrete). Persistence ships in DA-RP-1.
 */
export function getAtomRegistry(): AtomRegistry {
  if (_registry) return _registry;
  const registry = createAtomRegistry();
  const history = getHistoryService();
  // Registration order does not matter for `register()` itself — the
  // registry validates lazily and `resolveComposition` looks up children
  // at lookup time, by which point all atoms are present. The order
  // below mirrors the parent → child reading order for clarity.
  registry.register(makeSheetAtom({ db, history }));
  registry.register(makeEngagementAtom({ db, history, registry }));
  registry.register(makeSnapshotAtom({ db, history, registry }));
  registry.register(makeSubmissionAtom({ db, history }));
  // DA-PI-1 parcel-intelligence atoms — shape-only, no DB lookup yet.
  // Registered in child → parent reading order so that any future
  // operator surface tailing the boot log sees children before parents.
  registry.register(makeIntentAtom({ history }));
  registry.register(makeBriefingSourceAtom({ history }));
  registry.register(makeParcelBriefingAtom({ history }));
  registry.register(makeNeighboringContextAtom({ history }));
  // DA-PI-5 Revit sensor materialization atoms. Registered after
  // their child types (parcel-briefing, briefing-source, engagement)
  // so the boot-log tail surfaces the dependency order naturally;
  // `register()` itself does not care about order. Task #175 also
  // turns on per-requirement `materializable-element.identified`
  // emission from the briefing-generate route — those events anchor
  // against this same `materializable-element` registration.
  registry.register(makeMaterializableElementAtom({ db, history }));
  registry.register(makeBriefingDivergenceAtom({ db, history }));
  registry.register(makeBimModelAtom({ db, history }));
  // Wave 2 Sprint C / Spec 307 — reviewer-annotation composes every
  // potential target type (submission, briefing-source,
  // materializable-element, briefing-divergence, sheet,
  // parcel-briefing) declaratively; only the matching edge is
  // populated at lookup time. Registered after every target so the
  // boot-log tail makes the dependency order obvious.
  registry.register(makeReviewerAnnotationAtom({ db, history }));
  // DA-RP-0 mnml.ai render-pipeline atoms — shape-only, no DB lookup
  // yet. Both registered before any consumer references their slugs;
  // `register()` itself does not care about order, but the boot-log
  // tail surfaces the dependency order naturally (render-output
  // composes viewpoint-render).
  registry.register(makeViewpointRenderAtom({ history }));
  registry.register(makeRenderOutputAtom({ history }));
  _registry = registry;
  return registry;
}

/**
 * Boot-time hook. Constructs the registry (if not already built) and
 * runs `validate()`. Throws when validation fails — the caller is
 * expected to surface the error and exit, matching the README's
 * "fail to start when the result is `{ ok: false }`" contract.
 */
export function bootstrapAtomRegistry(
  logger: BootstrapAtomsLogger,
): AtomRegistry {
  const registry = getAtomRegistry();
  const result = registry.validate();
  if (!result.ok) {
    logger.error(
      { errors: result.errors },
      "atom registry validation failed — refusing to boot",
    );
    throw new Error(
      `Atom registry validation failed: ${JSON.stringify(result.errors)}`,
    );
  }
  const list = registry.list();
  logger.info(
    {
      count: list.length,
      atoms: list.map((r) => ({
        entityType: r.entityType,
        domain: r.domain,
        defaultMode: r.defaultMode,
        // Surface the declared event vocabulary in the boot log so
        // operators tailing logs can see what each atom is allowed to
        // emit without grepping the source. `?? []` mirrors the
        // catalog's "missing field = no declared events" convention.
        eventTypes: r.eventTypes ?? [],
      })),
    },
    "atom registry ready",
  );
  return registry;
}

/**
 * Test-only escape hatch: drop the cached registry so a new
 * `getAtomRegistry()` call rebuilds against the (mocked) `db` import.
 * Production code never calls this.
 */
export function resetAtomRegistryForTests(): void {
  _registry = null;
  _history = null;
}
