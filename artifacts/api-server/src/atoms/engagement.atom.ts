/**
 * The `engagement` atom registration — Spec 20 §4 / sprint A3.
 *
 * An engagement is the project-context container every other plan-review
 * atom eventually composes into (snapshot, sheet, submission, …). It
 * already has a stable Drizzle row, so this file owns the registration,
 * the typed payload contract, and the canonical event vocabulary. The
 * event vocabulary is declared in {@link ENGAGEMENT_EVENT_TYPES} as the
 * single source of truth and is wired onto the registration's
 * `eventTypes` field so the catalog endpoint surfaces it; today the
 * snapshot ingest's create-new branch emits `engagement.created`, with
 * the rest of the vocabulary pending wiring as the relevant routes
 * adopt the history service.
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
 * Composition declaration:
 *   Spec 20 locked decision #3 — composition declarations may reference
 *   atom types that aren't registered yet, with the registry validating
 *   at lookup time rather than at boot. The framework supports this via
 *   the per-edge `forwardRef: true` opt-out on `AtomComposition`, so
 *   `engagement` declares its real children (`snapshot` directly,
 *   `submission` as a forward ref pending the submission sprint) and
 *   the framework's `resolveComposition` resolver — not hand-written
 *   code — drives the parent/child wiring.
 */

import { desc, eq } from "drizzle-orm";
import {
  engagements,
  snapshots,
  submissions,
  viewpointRenders,
} from "@workspace/db";
import {
  resolveComposition,
  type AnyAtomRegistration,
  type AtomComposition,
  type AtomReference,
  type AtomRegistration,
  type CompositionRegistryView,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
  type Scope,
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
 * producers — snapshot ingest's create-new branch, the jurisdiction
 * resolver, the submission flow — can import the same constant rather
 * than open-coding the strings. The full vocabulary is also surfaced via
 * the registration's `eventTypes` field, so `GET /api/atoms/catalog`
 * (and the Dev Atoms Probe) reflect it without grepping.
 *
 * Producers wired so far:
 *   - `engagement.created` — emitted by `routes/snapshots.ts` on the
 *     create-new-engagement branch of the snapshot ingest.
 *   - `engagement.snapshot-received` — emitted by `routes/snapshots.ts`
 *     on every snapshot ingest, against the parent engagement.
 *   - `engagement.address-updated` — emitted by `routes/engagements.ts`
 *     PATCH when a request actually changes the address, via the
 *     `lib/engagementEvents.ts` helper.
 *   - `engagement.jurisdiction-resolved` — emitted by
 *     `routes/engagements.ts` (PATCH + POST `/:id/geocode`) and by
 *     `routes/snapshots.ts`'s `fireGeocodeAndWarmup` on the
 *     create-new-engagement branch, via the same helper. The PATCH/
 *     regeocode emissions use the `engagement-edit` system actor; the
 *     snapshot-ingest emission uses the `snapshot-ingest` actor so the
 *     timeline can attribute resolutions to the right producer.
 *   - `engagement.submitted` — emitted by `routes/engagements.ts`'s
 *     POST `/:id/submissions` handler via the
 *     `lib/engagementEvents.ts` helper. Uses the `submission-ingest`
 *     system actor so the timeline can attribute submissions to the
 *     submission ingest path rather than the engagement-edit surface.
 *     As of Task #63 the route also inserts a row into the
 *     `submissions` table and the event's `submissionId` payload field
 *     points at the inserted row's id — the row is the source of
 *     truth, the event is the audit-trail surface, and both share the
 *     same identity. The `submission` composition edge below is
 *     correspondingly concrete now (no `forwardRef`).
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
 * `SheetAtomDeps` plus an optional `registry` view passed to
 * {@link resolveComposition} so the framework — not hand-written code —
 * synthesizes the child snapshot references. When `registry` is omitted
 * (e.g. the bare contract test), the composition resolver step is
 * skipped and `relatedAtoms` returns empty rather than throwing.
 */
export interface EngagementAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
  registry?: CompositionRegistryView;
}

/**
 * Build the engagement atom registration. Factory style mirrors
 * `makeSheetAtom` so tests can swap in a per-schema `db` and a
 * deterministic in-memory `EventAnchoringService`. The closure also
 * captures the registration object itself so `contextSummary` can hand
 * it to {@link resolveComposition}.
 */
export function makeEngagementAtom(
  deps: EngagementAtomDeps,
): AtomRegistration<"engagement", EngagementSupportedModes> {
  // Engagement's real children:
  //   - snapshot: registered alongside engagement in the api-server
  //     bootstrap, so this edge is concrete and validated at boot.
  //   - submission: now backed by a real `submissions` table and a
  //     registered catalog atom (sprint A4 / Task #63), so the edge
  //     is concrete (no `forwardRef`) and submissions surface through
  //     `resolveComposition` like snapshots do. The framework's
  //     boot-time `validate()` step now requires the `submission`
  //     atom to be registered.
  //   - parcel-briefing (DA-PI-1): the engagement's currently-active
  //     parcel briefing, per Spec 51a §2.10's "composed by:
  //     engagement.activeBriefing(1)" relation. Concrete (not forward-
  //     ref) because the parcel-briefing atom registers in the same
  //     sprint as this edge. The data lookup that populates
  //     `parentData["activeBriefing"]` ships in DA-PI-3 with the
  //     briefing engine; until then `parentData` does not carry that
  //     key, so `resolveComposition` naturally produces zero
  //     parcel-briefing children — the same lazy pattern submissions
  //     used before they had a real table.
  // The `viewpoint-render` edge (DA-RP-0) is concrete because the
  // `viewpoint-render` atom registers in the same sprint as this edge.
  // `parentData["renders"]` is intentionally left unpopulated until
  // DA-RP-1 wires the renders table — `resolveComposition` produces
  // zero children for an absent / empty `renders` key, the same lazy
  // pattern `activeBriefing` used before DA-PI-3 and `submissions`
  // used before sprint A4 / Task #63.
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "snapshot",
      childMode: "compact",
      dataKey: "snapshots",
    },
    {
      childEntityType: "submission",
      childMode: "compact",
      dataKey: "submissions",
    },
    {
      childEntityType: "parcel-briefing",
      childMode: "card",
      dataKey: "activeBriefing",
    },
    {
      childEntityType: "viewpoint-render",
      childMode: "card",
      dataKey: "renders",
    },
  ];

  const registration: AtomRegistration<"engagement", EngagementSupportedModes> = {
    entityType: "engagement",
    domain: "plan-review",
    supportedModes: ENGAGEMENT_SUPPORTED_MODES,
    defaultMode: "card",
    composition,
    // Wired onto the registration so `GET /api/atoms/catalog` and any
    // operator surface (Dev Atoms Probe, boot-log tail) can introspect
    // the engagement-domain event vocabulary without grepping. Mirrors
    // the pattern Task #26 established for sheet/snapshot. Producers
    // (`routes/snapshots.ts` for `engagement.created`, more to come)
    // import {@link ENGAGEMENT_EVENT_TYPES} so a rename here flows
    // through the catalog and every emit site at once.
    eventTypes: ENGAGEMENT_EVENT_TYPES,
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

      // Load child snapshot rows once. The `id` field is what
      // `resolveComposition` picks up via its id-candidate lookup, and
      // the rest (`receivedAt`, `sheetCount`) feed the keyMetrics +
      // most-recent-activity computation below.
      const snapshotRows = await deps.db
        .select({
          id: snapshots.id,
          receivedAt: snapshots.receivedAt,
          sheetCount: snapshots.sheetCount,
        })
        .from(snapshots)
        .where(eq(snapshots.engagementId, row.id))
        .orderBy(desc(snapshots.receivedAt));

      // Load child submission rows once. Same id-candidate contract as
      // snapshots — `resolveComposition` picks up `id` and synthesizes
      // an `AtomReference` per row. `submittedAt` is loaded so future
      // most-recent-activity logic can fold submissions into the same
      // computation snapshots feed today.
      const submissionRows = await deps.db
        .select({
          id: submissions.id,
          submittedAt: submissions.submittedAt,
        })
        .from(submissions)
        .where(eq(submissions.engagementId, row.id))
        .orderBy(desc(submissions.submittedAt));

      // V1-4 / DA-RP-1: load child viewpoint-render rows so the
      // `renders` composition edge declared at line ~213 surfaces
      // real children. Pre-V1-4 the edge was declared but
      // `parentData["renders"]` was intentionally left unpopulated
      // (the `viewpoint_renders` table did not exist yet);
      // `resolveComposition` produced zero children for the absent
      // key. With the table landed in V1-4 Step 2 we project just
      // the id column — id is what `resolveComposition` picks up via
      // its id-candidate lookup; the rest of the row's fields belong
      // to the viewpoint-render atom's own `contextSummary`, not the
      // engagement's.
      const renderRows = await deps.db
        .select({ id: viewpointRenders.id })
        .from(viewpointRenders)
        .where(eq(viewpointRenders.engagementId, row.id))
        .orderBy(desc(viewpointRenders.createdAt));

      // Composition resolution: hand the snapshot rows to the framework
      // so `relatedAtoms` is what `resolveComposition` produces, not a
      // hand-rolled list. Mirrors the pattern in `snapshot.atom.ts`.
      // When `deps.registry` is omitted (e.g. the bare contract test),
      // the resolver step is skipped and `relatedAtoms` is empty — the
      // framework's boot-time `validate()` is the canonical place that
      // surfaces a missing `snapshot` registration.
      // The `submission` edge is now concrete (sprint A4 / Task #63):
      // `parentData["submissions"]` is populated below so the resolver
      // synthesizes one `AtomReference` per submission row alongside
      // the snapshot references.
      const parentRef: AtomReference = {
        kind: "atom",
        entityType: "engagement",
        entityId: row.id,
      };
      const relatedAtoms: AtomReference[] = [];
      if (deps.registry) {
        const resolved = resolveComposition(
          registration as unknown as AnyAtomRegistration,
          parentRef,
          {
            snapshots: snapshotRows,
            submissions: submissionRows,
            renders: renderRows,
          },
          deps.registry,
        );
        if (resolved.ok) {
          for (const child of resolved.children) {
            relatedAtoms.push(child.reference);
          }
        }
        // resolved.ok === false would mean a non-forward-ref child type
        // is unregistered in the passed registry view. We don't throw —
        // the engagement summary is still useful without children, and
        // the boot-time `validate()` call is the canonical place that
        // surfaces this kind of misconfiguration.
      }

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

  return registration;
}
