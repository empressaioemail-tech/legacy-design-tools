/**
 * The `sheet` atom registration — first catalog atom against
 * `@workspace/empressa-atom` (Spec 20 §4 + §6, A1 sprint).
 *
 * A Revit *sheet* (one drawing in a snapshot's sheet set) is a natural
 * first atom because:
 *   1. it already has a stable DB row identified by a UUID,
 *   2. the chat layer already accepts `referencedSheetIds` — so resolving
 *      sheets through the registry immediately replaces an ad-hoc
 *      `<reference_sheet_thumbnails>` style block with a typed, four-layer
 *      `ContextSummary`,
 *   3. it has no children today, so `composition: []` keeps the first
 *      registration scoped — composition arrives when the snapshot atom
 *      lands and declares `sheet` as a child.
 *
 * The registration is built by a factory so tests can inject a different
 * Drizzle instance and (optionally) an `EventAnchoringService`. Production
 * code calls {@link makeSheetAtom} once at boot from the registry module.
 */

import { eq } from "drizzle-orm";
import { sheets } from "@workspace/db";
import type {
  AtomRegistration,
  ContextSummary,
  EventAnchoringService,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";
import {
  extractSheetCrossRefs,
  type SheetCrossRef,
} from "../lib/sheetCrossRefs";

/** Hard cap on the prose summary length so we don't blow up token budget. */
export const SHEET_PROSE_MAX_CHARS = 600;

/** Modes future render bindings will implement for `sheet`. */
export const SHEET_SUPPORTED_MODES = ["card", "compact", "expanded"] as const;

export type SheetSupportedModes = typeof SHEET_SUPPORTED_MODES;

/**
 * Event types this atom is allowed to emit. Wired onto the registration
 * via the `eventTypes` field so the registry catalog (and any
 * `describeForPrompt`-driven surface) can introspect the vocabulary
 * without sniffing source files. Producers (notably the snapshot sheet
 * ingest path in `routes/sheets.ts`) reference these names when
 * appending events.
 *
 * - `sheet.created` — a fresh sheet row was inserted (snapshot ingest).
 * - `sheet.updated` — placeholder for a future re-upload / metadata
 *   producer (Task #20 territory; declared so the contract is
 *   discoverable today).
 * - `sheet.removed` — placeholder for the future "sheet disappeared in a
 *   newer snapshot" producer.
 */
export const SHEET_EVENT_TYPES = [
  "sheet.created",
  "sheet.updated",
  "sheet.removed",
] as const;

/**
 * Typed payload returned by `sheet`'s `contextSummary.typed`. Kept narrow
 * (per A0 the `typed` field is `Record<string, unknown>`, but a real shape
 * here lets the FE render a card without `as` casts).
 */
export interface SheetTypedPayload {
  id: string;
  found: boolean;
  sheetNumber?: string;
  sheetName?: string;
  viewCount?: number | null;
  revisionNumber?: string | null;
  revisionDate?: string | null;
  fullWidth?: number;
  fullHeight?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  engagementId?: string;
  snapshotId?: string;
  sortOrder?: number;
  /**
   * Free-text body of in-sheet notes/callouts as captured by the Revit
   * add-in OR the server-side vision pipeline (Task #477). `null` when
   * neither path has populated the column yet.
   */
  contentBody?: string | null;
  /**
   * Structured cross-references parsed from {@link contentBody} via
   * {@link extractSheetCrossRefs}. Empty array when there is no body or
   * no recognisable references — never `undefined` on a found sheet so
   * downstream consumers can iterate without a guard.
   */
  crossRefs?: SheetCrossRef[];
}

/**
 * Dependencies of {@link makeSheetAtom}. `db` must point at a Drizzle
 * instance that knows the same `sheets` table this module imports from
 * `@workspace/db`. `history` is optional — when omitted, history
 * provenance falls back to the sheet row's `created_at` timestamp with
 * an empty `latestEventId`, which the framework treats as "no events yet"
 * (see `ContextSummary.historyProvenance`).
 */
export interface SheetAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the sheet atom registration. Factory style so tests can swap in
 * a per-schema `db` and a deterministic in-memory `EventAnchoringService`.
 */
export function makeSheetAtom(
  deps: SheetAtomDeps,
): AtomRegistration<"sheet", SheetSupportedModes> {
  return {
    entityType: "sheet",
    domain: "plan-review",
    supportedModes: SHEET_SUPPORTED_MODES,
    defaultMode: "card",
    composition: [],
    eventTypes: SHEET_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"sheet">> {
      const rows = await deps.db
        .select({
          id: sheets.id,
          snapshotId: sheets.snapshotId,
          engagementId: sheets.engagementId,
          sheetNumber: sheets.sheetNumber,
          sheetName: sheets.sheetName,
          viewCount: sheets.viewCount,
          revisionNumber: sheets.revisionNumber,
          revisionDate: sheets.revisionDate,
          thumbnailWidth: sheets.thumbnailWidth,
          thumbnailHeight: sheets.thumbnailHeight,
          fullWidth: sheets.fullWidth,
          fullHeight: sheets.fullHeight,
          sortOrder: sheets.sortOrder,
          contentBody: sheets.contentBody,
          createdAt: sheets.createdAt,
        })
        .from(sheets)
        .where(eq(sheets.id, entityId))
        .limit(1);

      const row = rows[0];

      // Not-found is a normal control-flow case (the chat layer may
      // reference a stale id from history). Surface it via the `typed`
      // payload + a clear prose so the LLM never invents details.
      if (!row) {
        return {
          prose: `Sheet ${entityId} could not be found. It may have been removed in a newer snapshot.`,
          typed: { id: entityId, found: false } satisfies SheetTypedPayload,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: new Date(0).toISOString(),
          },
          scopeFiltered: false,
        };
      }

      const dimensions = `${row.fullWidth} × ${row.fullHeight} px`;
      const revisionFragment = row.revisionNumber
        ? ` Revision ${row.revisionNumber}${row.revisionDate ? ` dated ${row.revisionDate}` : ""}.`
        : "";
      const viewsFragment =
        typeof row.viewCount === "number"
          ? ` ${row.viewCount} view${row.viewCount === 1 ? "" : "s"} placed.`
          : "";

      const crossRefs = extractSheetCrossRefs(row.contentBody ?? "");
      const crossRefFragment =
        crossRefs.length > 0
          ? ` Cross-references: ${crossRefs
              .map((r) => r.sheetNumber)
              .join(", ")}.`
          : "";

      const proseRaw =
        `Sheet ${row.sheetNumber} — "${row.sheetName}". ` +
        `Drawing dimensions ${dimensions}.` +
        revisionFragment +
        viewsFragment +
        crossRefFragment;
      const prose =
        proseRaw.length > SHEET_PROSE_MAX_CHARS
          ? proseRaw.slice(0, SHEET_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      // History provenance: try to read the latest atom_event for this
      // (entityType, entityId). If the history service is absent or the
      // sheet has no events yet, fall back to the row's created_at —
      // the framework requires a non-null latestEventAt and treats an
      // empty latestEventId as "no events yet" (see context.ts).
      let latestEventId = "";
      let latestEventAt = row.createdAt.toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "sheet",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History is best-effort here — a transient read failure must
          // not break the chat path. Fallback already populated above.
        }
      }

      return {
        prose,
        typed: {
          id: row.id,
          found: true,
          sheetNumber: row.sheetNumber,
          sheetName: row.sheetName,
          viewCount: row.viewCount,
          revisionNumber: row.revisionNumber,
          revisionDate: row.revisionDate,
          fullWidth: row.fullWidth,
          fullHeight: row.fullHeight,
          thumbnailWidth: row.thumbnailWidth,
          thumbnailHeight: row.thumbnailHeight,
          engagementId: row.engagementId,
          snapshotId: row.snapshotId,
          sortOrder: row.sortOrder,
          contentBody: row.contentBody,
          crossRefs,
        } satisfies SheetTypedPayload,
        keyMetrics: [
          { label: "Sheet number", value: row.sheetNumber },
          ...(typeof row.viewCount === "number"
            ? [{ label: "Views", value: row.viewCount }]
            : []),
          ...(row.revisionNumber
            ? [{ label: "Revision", value: row.revisionNumber }]
            : []),
          { label: "Width", value: row.fullWidth, unit: "px" },
          { label: "Height", value: row.fullHeight, unit: "px" },
        ],
        relatedAtoms: [],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };
}
