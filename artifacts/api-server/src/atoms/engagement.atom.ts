/**
 * The `engagement` atom registration — Spec 20 §4 / sprint A3.
 *
 * An engagement is the project-context container every other plan-review
 * atom eventually composes into (snapshot, sheet, submission, …). It
 * already has a stable Drizzle row, so this sprint is a pure registration
 * pass — no schema changes, no producer wiring (event types are declared
 * in {@link ENGAGEMENT_EVENT_TYPES} as the single source of truth for
 * future producers, but nobody emits them yet).
 *
 * Mirrors the structural choices made by `sheet.atom.ts`:
 *   - factory style so tests can inject a per-schema `db` and an
 *     in-memory `EventAnchoringService`,
 *   - explicit prose-budget constant capping `prose` length,
 *   - explicit supported-modes tuple driving `defaultMode`,
 *   - typed payload interface (`EngagementTypedPayload`) so the FE card
 *     never has to `as`-cast,
 *   - history-provenance fallback to the row's `updated_at` when the
 *     history service is absent or has no events for this entity yet.
 *
 * Composition decision (Phase 1 recon, path A):
 *   The spec's locked decision #3 says composition declarations may
 *   reference unregistered atom types and the registry validates at
 *   lookup time. The current framework (`lib/empressa-atom/src/registry.ts:
 *   159-173`) walks every composition edge at `validate()` time and treats
 *   an unregistered child as a boot error. Because invariant 9 forbids
 *   changes to `@workspace/empressa-atom` this sprint, and because
 *   `snapshot` is not registered yet, we declare `composition: []` with a
 *   TODO and emit snapshot references via `relatedAtoms` directly. The
 *   framework gap is filed as an A0 follow-up.
 */

import { desc, eq } from "drizzle-orm";
import { engagements, snapshots } from "@workspace/db";
import type {
  AtomReference,
  AtomRegistration,
  ContextSummary,
  EventAnchoringService,
  KeyMetric,
  Scope,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary length so we don't blow up token budget. */
export const ENGAGEMENT_PROSE_MAX_CHARS = 800;

/** Modes future render bindings will implement for `engagement`. */
export const ENGAGEMENT_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type EngagementSupportedModes = typeof ENGAGEMENT_SUPPORTED_MODES;

/**
 * Single source of truth for engagement-domain event types. Declared here
 * (not in `@workspace/empressa-atom`, which is per-atom-agnostic) so that
 * future producers — `chat.ts`, snapshot ingest, jurisdiction resolver,
 * submission flow — can import the same constant rather than open-coding
 * the strings. No producers wired this sprint (out of scope per task A3).
 */
export const ENGAGEMENT_EVENT_TYPES = [
  "engagement.created",
  "engagement.address-updated",
  "engagement.jurisdiction-resolved",
  "engagement.snapshot-received",
  "engagement.submitted",
] as const;

export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];

/**
 * Typed payload returned by `engagement`'s `contextSummary.typed`. Mirrors
 * the `SheetTypedPayload` pattern: kept narrow so the FE card can render
 * without `as` casts, but with `found` discriminating the not-found path.
 *
 * Internal-only fields (`revitCentralGuid`, `revitDocumentPath`) are
 * present on the type but are omitted from the payload when scope.audience
 * is "user" without an architect-permission claim — see scope handling in
 * `contextSummary` below.
 */
export interface EngagementTypedPayload {
  id: string;
  found: boolean;
  name?: string;
  address?: string | null;
  jurisdiction?: string | null;
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdictionFips?: string | null;
  projectType?: string | null;
  status?: string;
  zoningCode?: string | null;
  lotAreaSqft?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  geocodedAt?: string | null;
  geocodeSource?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Internal-only: omitted from user-audience scope. */
  revitCentralGuid?: string | null;
  /** Internal-only: omitted from user-audience scope. */
  revitDocumentPath?: string | null;
}

/**
 * Dependencies of {@link makeEngagementAtom}. Same shape as
 * `SheetAtomDeps`; `history` falls back to "no events" when omitted.
 */
export interface EngagementAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the engagement atom registration. Factory style mirrors
 * `makeSheetAtom` so tests can swap in a per-schema `db` and a
 * deterministic in-memory `EventAnchoringService`.
 */
export function makeEngagementAtom(
  deps: EngagementAtomDeps,
): AtomRegistration<"engagement", EngagementSupportedModes> {
  return {
    entityType: "engagement",
    domain: "plan-review",
    supportedModes: ENGAGEMENT_SUPPORTED_MODES,
    defaultMode: "card",
    // Composition path A (see file header). Snapshot composition will be
    // declared once the snapshot atom registers.
    composition: [],
    async contextSummary(
      entityId: string,
      scope: Scope,
    ): Promise<ContextSummary<"engagement">> {
      const rows = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, entityId))
        .limit(1);

      const row = rows[0];

      // Not-found mirrors `sheet.atom.ts`: the chat layer may reference a
      // stale id from history, so the path returns 200 with a typed flag
      // rather than throwing. This keeps the LLM from inventing details.
      if (!row) {
        return {
          prose: `Engagement ${entityId} could not be found. It may have been removed or merged into another project.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies EngagementTypedPayload,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: {
            latestEventId: "",
            latestEventAt: new Date(0).toISOString(),
          },
          scopeFiltered: false,
        };
      }

      // Resolve children declaratively: most-recent-first snapshot rows
      // produce the `relatedAtoms` list. Path A above explains why this
      // is hand-built here instead of via `composition`.
      const snapshotRows = await deps.db
        .select({
          id: snapshots.id,
          receivedAt: snapshots.receivedAt,
          sheetCount: snapshots.sheetCount,
        })
        .from(snapshots)
        .where(eq(snapshots.engagementId, row.id))
        .orderBy(desc(snapshots.receivedAt));

      const relatedAtoms: AtomReference[] = snapshotRows.map((s) => ({
        kind: "atom",
        entityType: "snapshot",
        entityId: s.id,
        mode: "compact",
      }));

      const sheetCountTotal = snapshotRows.reduce(
        (acc, s) => acc + (s.sheetCount ?? 0),
        0,
      );

      const latestSnapshotAt = snapshotRows[0]?.receivedAt ?? null;
      const mostRecentActivity =
        latestSnapshotAt && latestSnapshotAt > row.updatedAt
          ? latestSnapshotAt
          : row.updatedAt;

      // Jurisdiction-not-yet-resolved branch: honest about what's missing
      // when the geocoder has not run / hasn't matched a known city.
      const jurisdictionResolved =
        Boolean(row.jurisdiction) ||
        Boolean(row.jurisdictionCity) ||
        Boolean(row.jurisdictionState);
      const jurisdictionLabel = jurisdictionResolved
        ? row.jurisdiction ??
          [row.jurisdictionCity, row.jurisdictionState]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join(", ")
        : "jurisdiction not yet resolved";

      // Scope-awareness. The default `internal` (and the AI-prompt
      // `ai`) audience receives the full payload. A `user`-audience
      // request without an architect permission claim is treated as the
      // applicant view: internal-only Revit binding fields are omitted
      // and the prose drops the "bound to Revit document …" sentence.
      // Setting `scopeFiltered: true` lets the framework / FE know the
      // payload is a redacted variant.
      const audience = scope.audience;
      const claimsArchitect =
        scope.permissions?.includes("plan-review:architect") ?? false;
      const showInternalDetails =
        audience === "internal" || audience === "ai" || claimsArchitect;

      const addressFragment = row.address ? ` at ${row.address}` : "";
      const projectTypeFragment = row.projectType
        ? ` (${row.projectType})`
        : "";
      const snapshotsFragment =
        snapshotRows.length === 0
          ? "0 snapshots received"
          : `${snapshotRows.length} snapshot${snapshotRows.length === 1 ? "" : "s"} received, ${sheetCountTotal} sheet${sheetCountTotal === 1 ? "" : "s"} total`;

      let proseRaw =
        `Engagement "${row.name}"${addressFragment}${projectTypeFragment}. ` +
        `Status: ${row.status}. Jurisdiction: ${jurisdictionLabel}. ` +
        `${snapshotsFragment}.`;

      if (showInternalDetails && row.revitDocumentPath) {
        proseRaw += ` Bound to Revit document "${row.revitDocumentPath}".`;
      }

      const prose =
        proseRaw.length > ENGAGEMENT_PROSE_MAX_CHARS
          ? proseRaw.slice(0, ENGAGEMENT_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Snapshots", value: snapshotRows.length },
        { label: "Sheet count", value: sheetCountTotal },
        {
          label: "Most recent activity",
          value: mostRecentActivity.toISOString(),
        },
      ];
      if (row.zoningCode) {
        keyMetrics.push({ label: "Zoning", value: row.zoningCode });
      }
      if (row.lotAreaSqft) {
        keyMetrics.push({
          label: "Lot area",
          value: row.lotAreaSqft,
          unit: "sqft",
        });
      }

      // Use `satisfies` (not an explicit annotation) so the inferred
      // literal-object type widens to Record<string, unknown> — required
      // by ContextSummary.typed. An explicit `: EngagementTypedPayload`
      // would keep the optional-field shape and fail TS2322 against the
      // Record signature (because `EngagementTypedPayload` has no index).
      const typedBase = {
        id: row.id,
        found: true,
        name: row.name,
        address: row.address,
        jurisdiction: row.jurisdiction,
        jurisdictionCity: row.jurisdictionCity,
        jurisdictionState: row.jurisdictionState,
        jurisdictionFips: row.jurisdictionFips,
        projectType: row.projectType,
        status: row.status,
        zoningCode: row.zoningCode,
        lotAreaSqft: row.lotAreaSqft,
        latitude: row.latitude,
        longitude: row.longitude,
        geocodedAt: row.geocodedAt ? row.geocodedAt.toISOString() : null,
        geocodeSource: row.geocodeSource,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      } satisfies EngagementTypedPayload;

      const typed = showInternalDetails
        ? ({
            ...typedBase,
            revitCentralGuid: row.revitCentralGuid,
            revitDocumentPath: row.revitDocumentPath,
          } satisfies EngagementTypedPayload)
        : typedBase;

      // History provenance: best-effort lookup against atom_event chain.
      // Fallback uses `mostRecentActivity` (already computed above) so the
      // FE renders a sensible "as-of" timestamp even pre-event-emit.
      let latestEventId = "";
      let latestEventAt = mostRecentActivity.toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "engagement",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // History is best-effort; transient read failures must not
          // break the chat path. Fallback already populated above.
        }
      }

      return {
        prose,
        typed,
        keyMetrics,
        relatedAtoms,
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: !showInternalDetails,
      };
    },
  };
}
