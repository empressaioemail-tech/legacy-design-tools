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
 *   - `engagement` (domain: `plan-review`)
 *   - `snapshot` (domain: `plan-review`) — composes `sheet` as a child;
 *     its registration receives the registry as a dep so the
 *     composition resolver can look up `sheet` at lookup time.
 */
export function getAtomRegistry(): AtomRegistry {
  if (_registry) return _registry;
  const registry = createAtomRegistry();
  const history = getHistoryService();
  // Sheet must register first so snapshot's composition edge to `sheet`
  // is non-dangling when boot-time `validate()` runs. The order doesn't
  // matter for `register()` itself (the registry validates lazily), but
  // matters for clarity.
  registry.register(makeSheetAtom({ db, history }));
  registry.register(makeEngagementAtom({ db, history }));
  registry.register(makeSnapshotAtom({ db, history, registry }));
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
