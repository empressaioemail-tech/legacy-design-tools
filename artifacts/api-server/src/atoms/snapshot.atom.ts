/**
 * The `snapshot` atom registration — second catalog atom against
 * `@workspace/empressa-atom` (Spec 20 §4 + §6, A2 sprint).
 *
 * A *snapshot* is a single Revit push: one row in `snapshots` plus its
 * child `sheets` rows. Registering snapshot exercises the framework's
 * **composition** layer end-to-end for the first time — `composition`
 * declares `sheet` as a child and `resolveComposition` walks that edge
 * at lookup time to synthesize `AtomReference`s for the child sheets.
 *
 * Like {@link makeSheetAtom} this is a factory so tests can swap in a
 * per-schema `db`. It additionally accepts a `registry` so the
 * composition resolver has a registry view to look up `sheet` against —
 * the production registry passes itself when registering snapshot, the
 * test passes a freshly-built registry containing both atoms.
 */

import { asc, eq } from "drizzle-orm";
import { snapshots, sheets, engagements } from "@workspace/db";
import {
  resolveComposition,
  unwrapFromStorage,
  type AnyAtomRegistration,
  type AtomComposition,
  type AtomReference,
  type AtomRegistration,
  type CompositionRegistryView,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary length so we don't blow up token budget. */
export const SNAPSHOT_PROSE_MAX_CHARS = 600;

/**
 * All five Spec 20 §5 render modes — declared at the type level so
 * future render bindings have the full menu available. Only `card` is
 * wired in the FE today; the others ship as type-only contract per the
 * A2 sprint brief.
 */
export const SNAPSHOT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type SnapshotSupportedModes = typeof SNAPSHOT_SUPPORTED_MODES;

/**
 * Event types this atom is allowed to emit. Wired onto the registration
 * via the `eventTypes` field (Task #26) so the registry catalog and any
 * `describeForPrompt`-driven surface can introspect the vocabulary
 * without sniffing source files. The exported constant is preserved so
 * producers (the snapshot ingest routes in `routes/snapshots.ts` and
 * `routes/sheets.ts`) can reference the same names when calling
 * {@link EventAnchoringService.appendEvent}.
 *
 * - `snapshot.created` — a new snapshot row was inserted (either via the
 *   create-new-engagement branch or by attaching to an existing
 *   engagement, including the GUID-race rebind path).
 * - `snapshot.sheets_attached` — a multipart sheet upload finished
 *   processing for this snapshot. Emitted once per
 *   `POST /api/snapshots/:id/sheets` invocation, regardless of whether
 *   any individual sheet rows were inserts vs. upserts.
 * - `snapshot.replaced` — emitted against the previously-latest
 *   snapshot for an engagement when a fresher snapshot supersedes it
 *   (the new snapshot row also gets its own `snapshot.created` event).
 */
export const SNAPSHOT_EVENT_TYPES = [
  "snapshot.created",
  "snapshot.sheets_attached",
  "snapshot.replaced",
] as const;

/**
 * Typed payload returned by `snapshot`'s `contextSummary.typed`.
 * Nullable Revit identity fields are omitted (rather than emitted as
 * `null`) so the FE renderer can render only the populated rows.
 */
export interface SnapshotTypedPayload {
  id: string;
  found: boolean;
  engagementId?: string;
  engagementName?: string;
  projectName?: string;
  receivedAt?: string;
  sheetCount?: number;
  revitCentralGuid?: string;
  revitDocumentPath?: string;
}

/**
 * Dependencies of {@link makeSnapshotAtom}. `db` and `history` mirror
 * {@link SheetAtomDeps}. `registry` is the registry view the composition
 * resolver consults to look up the `sheet` child registration; when
 * omitted, composition resolves to no child sheet references (engagement
 * parent reference is still surfaced).
 */
export interface SnapshotAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
  registry?: CompositionRegistryView;
}

/**
 * Build the snapshot atom registration. Closure captures the registration
 * itself so {@link resolveComposition} (which needs the parent
 * registration) can be called from inside `contextSummary`.
 */
export function makeSnapshotAtom(
  deps: SnapshotAtomDeps,
): AtomRegistration<"snapshot", SnapshotSupportedModes> {
  const composition: ReadonlyArray<AtomComposition> = [
    { childEntityType: "sheet", childMode: "compact", dataKey: "sheets" },
  ];

  const registration: AtomRegistration<"snapshot", SnapshotSupportedModes> = {
    entityType: "snapshot",
    domain: "plan-review",
    supportedModes: SNAPSHOT_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    eventTypes: SNAPSHOT_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"snapshot">> {
      const rows = await deps.db
        .select({
          id: snapshots.id,
          engagementId: snapshots.engagementId,
          projectName: snapshots.projectName,
          payload: snapshots.payload,
          sheetCount: snapshots.sheetCount,
          roomCount: snapshots.roomCount,
          levelCount: snapshots.levelCount,
          wallCount: snapshots.wallCount,
          receivedAt: snapshots.receivedAt,
          engagementName: engagements.name,
          revitCentralGuid: engagements.revitCentralGuid,
          revitDocumentPath: engagements.revitDocumentPath,
        })
        .from(snapshots)
        .innerJoin(engagements, eq(engagements.id, snapshots.engagementId))
        .where(eq(snapshots.id, entityId))
        .limit(1);

      const row = rows[0];

      // Not-found mirrors sheet exactly: 200-style return with
      // `typed.found: false` so chat can reference stale ids without
      // crashing the FE on a 404.
      if (!row) {
        return {
          prose: `Snapshot ${entityId} could not be found. It may have been deleted or never existed.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies SnapshotTypedPayload,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: new Date(0).toISOString(),
          },
          scopeFiltered: false,
        };
      }

      // Forward-compat: A0 VDA is a no-op envelope. No current write
      // path wraps snapshot rows, but `unwrapFromStorage` tolerates the
      // unwrapped shape, so threading it here means the day a producer
      // adopts `wrapForStorage`, this read keeps working unchanged.
      void unwrapFromStorage(row.payload as Record<string, unknown>);

      // Load child sheets for composition resolution. The resolver
      // looks up `parentData[dataKey]` (here: `parentData["sheets"]`)
      // and synthesizes a child reference per row using its `id` field.
      // Only the fields the resolver and our prose need are selected —
      // PNG bytes are deliberately excluded so the composition lookup
      // doesn't pay for image bytes it never inspects.
      const childSheetRows = await deps.db
        .select({
          id: sheets.id,
          sheetNumber: sheets.sheetNumber,
        })
        .from(sheets)
        .where(eq(sheets.snapshotId, entityId))
        .orderBy(asc(sheets.sortOrder));

      // Compose prose. 1–3 sentences per the brief; the headline counts
      // come from the snapshot row.
      const countFragments: string[] = [];
      if (typeof row.sheetCount === "number") {
        countFragments.push(
          `${row.sheetCount} sheet${row.sheetCount === 1 ? "" : "s"}`,
        );
      }
      if (typeof row.levelCount === "number") {
        countFragments.push(
          `${row.levelCount} level${row.levelCount === 1 ? "" : "s"}`,
        );
      }
      if (typeof row.roomCount === "number") {
        countFragments.push(
          `${row.roomCount} room${row.roomCount === 1 ? "" : "s"}`,
        );
      }
      if (typeof row.wallCount === "number") {
        countFragments.push(
          `${row.wallCount} wall${row.wallCount === 1 ? "" : "s"}`,
        );
      }
      const countsSentence =
        countFragments.length > 0
          ? ` Includes ${countFragments.join(", ")}.`
          : "";
      const proseRaw =
        `Snapshot of "${row.projectName}" for engagement ${row.engagementName}, ` +
        `received ${row.receivedAt.toISOString()}.` +
        countsSentence;
      const prose =
        proseRaw.length > SNAPSHOT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, SNAPSHOT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      // Build keyMetrics, omitting any null counts rather than emitting
      // `value: null` (KeyMetric.value is typed as string | number).
      const keyMetrics: KeyMetric[] = [];
      if (typeof row.sheetCount === "number") {
        keyMetrics.push({ label: "Sheets", value: row.sheetCount });
      }
      if (typeof row.levelCount === "number") {
        keyMetrics.push({ label: "Levels", value: row.levelCount });
      }
      if (typeof row.roomCount === "number") {
        keyMetrics.push({ label: "Rooms", value: row.roomCount });
      }
      if (typeof row.wallCount === "number") {
        keyMetrics.push({ label: "Walls", value: row.wallCount });
      }

      // Composition resolution: hand the sheet rows to the framework so
      // `relatedAtoms` is what `resolveComposition` produces, not a
      // hand-rolled list. When `deps.registry` is omitted (e.g. the
      // contract test's bare `makeSnapshotAtom({ db, history })` call)
      // the resolver step is skipped — engagement parent ref still ships.
      const parentRef: AtomReference = {
        kind: "atom",
        entityType: "snapshot",
        entityId: row.id,
      };
      const sheetRefs: AtomReference[] = [];
      if (deps.registry) {
        const resolved = resolveComposition(
          registration as unknown as AnyAtomRegistration,
          parentRef,
          { sheets: childSheetRows },
          deps.registry,
        );
        if (resolved.ok) {
          for (const c of resolved.children) sheetRefs.push(c.reference);
        }
        // resolved.ok === false would mean `sheet` is unregistered in the
        // passed registry view — we don't throw because the snapshot
        // summary is still useful without children. The boot-time
        // `validate()` call is the canonical place that surfaces this.
      }

      const engagementRef: AtomReference = {
        kind: "atom",
        entityType: "engagement",
        entityId: row.engagementId,
      };

      // History provenance: identical fallback to sheet — try the latest
      // atom_event row, fall back to `row.receivedAt` (snapshot's
      // creation timestamp) and an empty `latestEventId` to signal "no
      // events yet".
      let latestEventId = "";
      let latestEventAt = row.receivedAt.toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "snapshot",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History is best-effort here — fallback already populated.
        }
      }

      const typed: SnapshotTypedPayload = {
        id: row.id,
        found: true,
        engagementId: row.engagementId,
        engagementName: row.engagementName,
        projectName: row.projectName,
        receivedAt: row.receivedAt.toISOString(),
      };
      if (typeof row.sheetCount === "number") {
        typed.sheetCount = row.sheetCount;
      }
      if (row.revitCentralGuid) typed.revitCentralGuid = row.revitCentralGuid;
      if (row.revitDocumentPath)
        typed.revitDocumentPath = row.revitDocumentPath;

      return {
        prose,
        // ContextSummary.typed is `Record<string, unknown>`; our narrow
        // SnapshotTypedPayload doesn't carry an index signature so we
        // route through `unknown` (per ts2352) without leaking the
        // index-signature requirement back into the typed payload.
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [engagementRef, ...sheetRefs],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
