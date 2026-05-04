/**
 * /api/engagements/:id/bim-model + /api/bim-models/:id/* — DA-PI-5
 * Revit sensor materialization surface.
 *
 * Four endpoints:
 *
 *   - GET  /engagements/:id/bim-model
 *       Read-side surface for the C# Revit add-in. Returns the
 *       engagement's `bim_models` row (or null) along with the
 *       `materializable_elements` rows derived from the currently-
 *       active briefing.
 *
 *   - POST /engagements/:id/bim-model
 *       The "Push to Revit" affordance writes here. Records (or
 *       updates) the engagement's `bim_models` row to point at the
 *       engagement's currently-active parcel briefing and stamp
 *       `materializedAt` to now. Idempotent at the engagement-id
 *       level via the unique constraint on `engagement_id`.
 *
 *   - GET  /bim-models/:id/refresh
 *       Refresh-diff surface (Spec 53 §3). Computes whether the
 *       bim-model's last materialization is current, stale, or
 *       not-pushed.
 *
 *   - POST /bim-models/:id/divergence
 *       Service-to-service surface the C# add-in calls when its
 *       element-watcher detects an unpin / geometry edit / deletion
 *       against a locked materializable element. HMAC-SHA256
 *       authenticated against `BIM_MODEL_SHARED_SECRET`, mirroring
 *       the DXF converter precedent in `converterClient.ts`.
 *
 * Browser-facing surface: the GET/POST `/engagements/:id/bim-model`
 * pair and `GET /bim-models/:id/refresh` are engagement-scoped (read
 * access via the route's existing auth surface — same pattern as
 * `parcelBriefings.ts`). The divergence POST is the one route that
 * requires HMAC auth because it is the C# add-in's sole writer.
 *
 * Best-effort event emission via the existing event-anchoring
 * service: a transient history outage cannot fail the HTTP request.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  db,
  engagements,
  parcelBriefings,
  bimModels,
  materializableElements,
  briefingDivergences,
  snapshots,
  snapshotIfcFiles,
  BRIEFING_DIVERGENCE_REASONS,
  type BimModel,
  type MaterializableElement,
  type BriefingDivergence,
} from "@workspace/db";
import { eq, desc, sql, and, isNull, isNotNull, inArray } from "drizzle-orm";
import {
  GetEngagementBimModelParams,
  PushEngagementBimModelParams,
  PushEngagementBimModelBody,
  GetBimModelRefreshParams,
  GetMaterializableElementGlbParams,
  ListBimModelDivergencesParams,
  RecordBimModelDivergenceParams,
  RecordBimModelDivergenceBody,
  ResolveBimModelDivergenceParams,
} from "@workspace/api-zod";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";
import { requireArchitectAudience } from "../lib/audienceGuards";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import {
  BIM_MODEL_PUSH_ACTOR_ID,
  BIM_MODEL_REFRESH_ACTOR_ID,
  BIM_MODEL_DIVERGENCE_ACTOR_ID,
  BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR_ID,
} from "@workspace/server-actor-ids";
import { logger } from "../lib/logger";
import { hydrateActors } from "../lib/userLookup";
import { resolveMatchingReviewerRequests } from "../lib/reviewerRequestResolution";
import { getHistoryService } from "../atoms/registry";
import {
  BIM_MODEL_EVENT_TYPES,
  type BimModelEventType,
  type BimModelRefreshStatus,
} from "../atoms/bim-model.atom";
import {
  BRIEFING_DIVERGENCE_EVENT_TYPES,
  type BriefingDivergenceEventType,
} from "../atoms/briefing-divergence.atom";

const router: IRouter = Router();

/**
 * Pinned to the bim-model atom's event-type union so a rename in
 * the atom registration breaks compilation here rather than silently
 * emitting a stale event name.
 */
const BIM_MODEL_MATERIALIZED_EVENT_TYPE: BimModelEventType =
  BIM_MODEL_EVENT_TYPES[0];
const BIM_MODEL_REFRESHED_EVENT_TYPE: BimModelEventType =
  BIM_MODEL_EVENT_TYPES[1];
const BIM_MODEL_DIVERGED_EVENT_TYPE: BimModelEventType =
  BIM_MODEL_EVENT_TYPES[2];
const BIM_MODEL_DIVERGENCE_RESOLVED_EVENT_TYPE: BimModelEventType =
  BIM_MODEL_EVENT_TYPES[3];

const BRIEFING_DIVERGENCE_RECORDED_EVENT_TYPE: BriefingDivergenceEventType =
  BRIEFING_DIVERGENCE_EVENT_TYPES[0];
const BRIEFING_DIVERGENCE_RESOLVED_EVENT_TYPE: BriefingDivergenceEventType =
  BRIEFING_DIVERGENCE_EVENT_TYPES[1];

/** Stable system actor for design-tools-driven bim-model writes. */
const BIM_MODEL_PUSH_ACTOR = {
  kind: "system" as const,
  id: BIM_MODEL_PUSH_ACTOR_ID,
};

/** Stable system actor for the refresh-diff polling path. */
const BIM_MODEL_REFRESH_ACTOR = {
  kind: "system" as const,
  id: BIM_MODEL_REFRESH_ACTOR_ID,
};

/** Stable system actor for divergences the C# add-in records. */
const BIM_MODEL_DIVERGENCE_ACTOR = {
  kind: "system" as const,
  id: BIM_MODEL_DIVERGENCE_ACTOR_ID,
};

/**
 * Fallback actor for the operator-resolve path when the request did
 * not carry a session-bound requestor. Mirrors how
 * `actorFromRequest` in `engagements.ts` falls back to a system
 * actor — the timeline still gets a "this was acknowledged" marker
 * even when attribution was unavailable, instead of dropping the
 * event entirely.
 */
const BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR = {
  kind: "system" as const,
  id: BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR_ID,
};

// ---------------------------------------------------------------------------
// Wire shapes — kept narrow on purpose so a rename in the schema layer breaks
// compilation here rather than silently round-tripping through the wire.
// ---------------------------------------------------------------------------

interface MaterializableElementWire {
  id: string;
  /**
   * Null only for IFC-derived rows (Track B sprint). The C#-add-in-facing
   * read at `loadElementsForBriefing` filters these out, so the add-in
   * never sees a null here. Web-viewer reads via `loadElementsForEngagement`
   * include them.
   */
  briefingId: string | null;
  elementKind: string;
  /** Provenance lens: 'briefing-derived' | 'as-built-ifc' | 'as-built-ifc-bundle'. */
  sourceKind: string;
  /** Engagement scope. Always set for IFC rows; nullable on legacy briefing rows. */
  engagementId: string | null;
  briefingSourceId: string | null;
  label: string | null;
  geometry: Record<string, unknown>;
  glbObjectPath: string | null;
  locked: boolean;
  /** IFC GlobalId (22-char GUID). Set only on as-built-ifc / as-built-ifc-bundle rows. */
  ifcGlobalId: string | null;
  /** IFC entity type (`IfcWall`, etc.). Set only on as-built-ifc / as-built-ifc-bundle rows. */
  ifcType: string | null;
  /**
   * Flattened IFC `Pset_*Common` property values for IFC rows; null on
   * briefing-derived rows. Track C surfaces this in the viewer's
   * IFC-element-detail panel without a follow-up fetch.
   */
  propertySet: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface BimModelWire {
  id: string;
  engagementId: string;
  activeBriefingId: string | null;
  briefingVersion: number;
  materializedAt: string | null;
  revitDocumentPath: string | null;
  refreshStatus: BimModelRefreshStatus;
  elements: MaterializableElementWire[];
  createdAt: string;
  updatedAt: string;
}

interface RequestorRefWire {
  kind: "user" | "agent";
  id: string;
  /**
   * Best-effort hydration of `users.displayName` (Task #212) when the
   * row was resolved by a `kind === "user"` actor whose profile we
   * can look up. Surfaces such as the design-tools "Resolved by …"
   * badge fall back to `id` when this is absent so a missing or
   * transiently-unavailable profile still renders an attribution.
   */
  displayName?: string;
  /**
   * Best-effort hydration of `users.avatarUrl` (Task #269) for the
   * same `kind === "user"` actor. Lets the design-tools "Resolved by …"
   * chip render the user's avatar image when one is on file; absent
   * when the profile isn't hydrated or the user has no avatar, in
   * which case the FE falls back to an initials chip.
   */
  avatarUrl?: string;
}

interface BriefingDivergenceWire {
  id: string;
  bimModelId: string;
  materializableElementId: string;
  briefingId: string;
  reason: string;
  note: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  /** Set once an operator marks the divergence resolved. */
  resolvedAt: string | null;
  /**
   * Identity of the session-bound caller that recorded the resolve.
   * Null while the row is still Open, or when the resolve was
   * recorded without a session-bound caller (in which case
   * `resolvedAt` is still set so the row still moves out of the
   * Open list).
   */
  resolvedByRequestor: RequestorRefWire | null;
}

/**
 * Wire row for `GET /bim-models/:id/divergences`. Joins each
 * divergence with the parent materializable element so the FE can
 * group rows by `elementKind` / `elementLabel` without a follow-up
 * fetch. Both join fields are nullable: a divergence whose parent
 * element has been deleted out from under the bim-model still
 * surfaces here (we use a left join below) so the audit trail
 * stays whole.
 */
interface BimModelDivergenceListEntryWire extends BriefingDivergenceWire {
  elementKind: string | null;
  elementLabel: string | null;
}

/** Wire row for the element-level diff returned by `/refresh`. */
interface BimModelElementDiffWire {
  id: string;
  elementKind: string;
  label: string | null;
  diffStatus: "added" | "modified" | "unchanged";
  updatedAt: string;
}

interface BimModelRefreshDiffWire {
  elements: BimModelElementDiffWire[];
  addedCount: number;
  modifiedCount: number;
  unchangedCount: number;
}

function toElementWire(e: MaterializableElement): MaterializableElementWire {
  return {
    id: e.id,
    briefingId: e.briefingId,
    elementKind: e.elementKind,
    sourceKind: e.sourceKind,
    engagementId: e.engagementId,
    briefingSourceId: e.briefingSourceId,
    label: e.label,
    // The DB column is a `jsonb` typed as `unknown` by drizzle's
    // inferSelect; the OpenAPI schema declares it as a free-form
    // object so the cast is the wire-contract bridge.
    geometry: (e.geometry ?? {}) as Record<string, unknown>,
    glbObjectPath: e.glbObjectPath,
    locked: e.locked,
    ifcGlobalId: e.ifcGlobalId,
    ifcType: e.ifcType,
    // The DB column is `jsonb` typed as `unknown`; only IFC rows set
    // a non-null value (Track B parser populates Description /
    // ObjectType / PredefinedType today; richer Pset traversal is
    // a Phase 2 follow-up).
    propertySet: (e.propertySet ?? null) as Record<string, unknown> | null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/**
 * Cached profile fields for a `kind === "user"` resolver. Both fields
 * are optional so a hydrated row that only carries a display name
 * (no avatar on file) doesn't pretend to have an `avatarUrl`. The
 * caller treats either field's absence as "fall back to the
 * UI-side default" (raw id / initials chip).
 */
interface ResolverProfile {
  displayName?: string;
  avatarUrl?: string;
}

function toDivergenceWire(
  d: BriefingDivergence,
  profileByUserId?: ReadonlyMap<string, ResolverProfile>,
): BriefingDivergenceWire {
  return {
    id: d.id,
    bimModelId: d.bimModelId,
    materializableElementId: d.materializableElementId,
    briefingId: d.briefingId,
    reason: d.reason,
    note: d.note,
    detail: (d.detail ?? {}) as Record<string, unknown>,
    createdAt: d.createdAt.toISOString(),
    resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    resolvedByRequestor: toResolvedByRequestor(d, profileByUserId),
  };
}

/**
 * Reconstruct the wire `{kind, id}` requestor pair from the two
 * stored columns. Both must be present (and `kind` must be one of
 * the closed `user` / `agent` set the session middleware emits) for
 * the wire field to populate; a half-populated row degrades to
 * `null` so the FE never has to handle a partially-typed actor.
 *
 * When a `profileByUserId` map is supplied (the engagement-side
 * surfaces hydrate identities via the `users` table — see
 * `hydrateActors`), a matching `kind === "user"` row gains an
 * optional `displayName` so the FE can render "Resolved by Jane Doe"
 * (Task #212) instead of an opaque user id, plus an optional
 * `avatarUrl` so the FE can render the user's avatar in the
 * "Resolved by …" chip (Task #269). Both lookups are best effort:
 * an unknown id (e.g. profile deleted) leaves the fields absent and
 * the FE falls back to the raw id / an initials chip.
 */
function toResolvedByRequestor(
  d: BriefingDivergence,
  profileByUserId?: ReadonlyMap<string, ResolverProfile>,
): RequestorRefWire | null {
  const kind = d.resolvedByRequestorKind;
  const id = d.resolvedByRequestorId;
  if (!kind || !id) return null;
  if (kind !== "user" && kind !== "agent") return null;
  const ref: RequestorRefWire = { kind, id };
  if (kind === "user") {
    const profile = profileByUserId?.get(id);
    if (profile?.displayName) ref.displayName = profile.displayName;
    if (profile?.avatarUrl) ref.avatarUrl = profile.avatarUrl;
  }
  return ref;
}

/**
 * Best-effort batched profile lookup for the user-kind resolvers
 * across a set of divergence rows. Originally added for displayName
 * hydration (Task #212) and extended in Task #269 to also surface
 * `avatarUrl` so the design-tools "Resolved by …" chip can render
 * the user's avatar image alongside their name. The list / resolve
 * endpoints feed the resulting map straight into `toDivergenceWire`
 * so the wire's `resolvedByRequestor.{displayName,avatarUrl}` get
 * populated in a single round-trip regardless of how many rows
 * we're returning.
 *
 * Mirrors the posture of the snapshot/atom-history hydration paths:
 * a thrown lookup (transient DB hiccup against the `users` table)
 * degrades silently to the empty map so the audit-trail row still
 * renders with the raw id rather than failing the whole request.
 */
async function lookupResolverProfiles(
  rows: ReadonlyArray<{ divergence: BriefingDivergence }>,
  reqLog: typeof logger,
): Promise<Map<string, ResolverProfile>> {
  const userIds: { kind: "user"; id: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const d = r.divergence;
    if (d.resolvedByRequestorKind !== "user") continue;
    const id = d.resolvedByRequestorId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    userIds.push({ kind: "user", id });
  }
  const out = new Map<string, ResolverProfile>();
  if (userIds.length === 0) return out;
  try {
    const hydrated = await hydrateActors(userIds);
    for (const a of hydrated) {
      if (a.kind !== "user") continue;
      const profile: ResolverProfile = {};
      if (a.displayName) profile.displayName = a.displayName;
      if (a.avatarUrl) profile.avatarUrl = a.avatarUrl;
      // Skip empty entries so the FE-side fall-back path is the
      // only one that handles missing profiles — avoids carrying
      // `{}` placeholders that would muddy assertions.
      if (profile.displayName || profile.avatarUrl) {
        out.set(a.id, profile);
      }
    }
  } catch (err) {
    reqLog.warn(
      { err },
      "bim-model divergence: resolver profile hydration failed",
    );
  }
  return out;
}

/**
 * Compute the refresh-diff status for a bim-model row + its active
 * briefing's `updatedAt`. Centralized so the GET refresh route, the
 * GET bim-model route, and the contextSummary path all agree on the
 * status mapping.
 */
function computeRefreshStatus(
  bm: BimModel,
  activeBriefingUpdatedAt: Date | null,
): BimModelRefreshStatus {
  if (!bm.activeBriefingId || !bm.materializedAt) return "not-pushed";
  if (!activeBriefingUpdatedAt) return "not-pushed";
  return activeBriefingUpdatedAt > bm.materializedAt ? "stale" : "current";
}

/**
 * Compute the per-element delta the C# add-in iterates on refresh.
 *
 * We do not snapshot the materialized element set at push time — the
 * bim-model row only carries `materializedAt` — so the diff is a
 * timestamp comparison against the briefing's current element rows:
 *
 *   - `added`     — the row's `createdAt` is newer than `materializedAt`
 *     (the C# add-in has never seen this element).
 *   - `modified`  — the row existed at materialization time but its
 *     `updatedAt` is newer than `materializedAt`.
 *   - `unchanged` — `updatedAt <= materializedAt`.
 *
 * When the bim-model has never been pushed (`materializedAt === null`)
 * every element is reported as `added`.
 *
 * Deletions are deliberately not represented here — see the
 * `BimModelElementDiffStatus` enum docstring in the OpenAPI spec.
 */
function computeElementDiff(
  bm: BimModel,
  elements: ReadonlyArray<MaterializableElement>,
): BimModelRefreshDiffWire {
  const materializedAt = bm.materializedAt;
  let addedCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;
  const wire: BimModelElementDiffWire[] = elements.map((e) => {
    let diffStatus: BimModelElementDiffWire["diffStatus"];
    if (!materializedAt || e.createdAt > materializedAt) {
      diffStatus = "added";
      addedCount += 1;
    } else if (e.updatedAt > materializedAt) {
      diffStatus = "modified";
      modifiedCount += 1;
    } else {
      diffStatus = "unchanged";
      unchangedCount += 1;
    }
    return {
      id: e.id,
      elementKind: e.elementKind,
      label: e.label,
      diffStatus,
      updatedAt: e.updatedAt.toISOString(),
    };
  });
  return {
    elements: wire,
    addedCount,
    modifiedCount,
    unchangedCount,
  };
}

/**
 * Per-file 403 error string for the architect-audience gate. The
 * shared guard in `lib/audienceGuards.ts` takes the error string as
 * a parameter so each route file can attribute a 403 back to its
 * own surface; this constant pins the value the existing test
 * suite asserts on (`bim-models.test.ts`).
 *
 * The S2S divergence route is exempt from the gate: it carries its
 * own HMAC-SHA256 trust contract and runs as a system actor, not a
 * browser session.
 */
const BIM_MODEL_AUDIENCE_ERROR = "bim_model_requires_architect_audience";

/**
 * Load the active briefing's `updatedAt` (if any) for a bim-model.
 * Returns null when the bim-model has no activeBriefingId or the
 * briefing was deleted out from under it.
 */
async function loadActiveBriefingUpdatedAt(
  bm: BimModel,
): Promise<Date | null> {
  if (!bm.activeBriefingId) return null;
  const rows = await db
    .select({ updatedAt: parcelBriefings.updatedAt })
    .from(parcelBriefings)
    .where(eq(parcelBriefings.id, bm.activeBriefingId))
    .limit(1);
  return rows[0]?.updatedAt ?? null;
}

/**
 * Load the materializable elements attached to a briefing, kind-
 * grouped order so the C# add-in can iterate in a predictable order.
 *
 * Track B sprint: filter to `source_kind = 'briefing-derived'` so the
 * C#-facing read does NOT surface IFC-derived rows the add-in cannot
 * materialize. IFC rows are surfaced via the engagement-level read in
 * {@link loadAsBuiltIfcElementsForEngagement}.
 */
async function loadElementsForBriefing(
  briefingId: string,
): Promise<MaterializableElement[]> {
  return db
    .select()
    .from(materializableElements)
    .where(
      and(
        eq(materializableElements.briefingId, briefingId),
        eq(materializableElements.sourceKind, "briefing-derived"),
      ),
    )
    .orderBy(materializableElements.elementKind, materializableElements.createdAt);
}

/**
 * Load the as-built-ifc rows for an engagement's most-recently-parsed
 * snapshot IFC ingest (Track B sprint). Returns the bundle row first
 * (the one carrying the consolidated glTF `glb_object_path`) so the
 * viewer's "first row with glb_object_path wins" preference picks it
 * up, followed by the per-IFC-entity rows.
 *
 * Returns `null` if the engagement has no parsed IFC. Returns `[]` if
 * the most-recent IFC parsed cleanly but produced zero entities (a
 * legitimate edge case for an empty / shell-only IFC).
 */
async function loadAsBuiltIfcElementsForEngagement(
  engagementId: string,
): Promise<{
  ifcFile: { snapshotId: string; parsedAt: Date | null; gltfObjectPath: string | null } | null;
  elements: MaterializableElement[];
}> {
  const ifcRows = await db
    .select({
      snapshotId: snapshotIfcFiles.snapshotId,
      parsedAt: snapshotIfcFiles.parsedAt,
      gltfObjectPath: snapshotIfcFiles.gltfObjectPath,
    })
    .from(snapshotIfcFiles)
    .innerJoin(snapshots, eq(snapshots.id, snapshotIfcFiles.snapshotId))
    .where(
      and(
        eq(snapshots.engagementId, engagementId),
        isNotNull(snapshotIfcFiles.parsedAt),
      ),
    )
    .orderBy(desc(snapshotIfcFiles.parsedAt))
    .limit(1);
  const ifcFile = ifcRows[0] ?? null;
  if (!ifcFile) return { ifcFile: null, elements: [] };

  const elements = await db
    .select()
    .from(materializableElements)
    .where(
      and(
        eq(materializableElements.engagementId, engagementId),
        eq(materializableElements.sourceSnapshotId, ifcFile.snapshotId),
        inArray(materializableElements.sourceKind, [
          "as-built-ifc-bundle",
          "as-built-ifc",
        ]),
      ),
    )
    // Bundle first (it carries the GLB), then per-entity rows.
    .orderBy(
      sql`CASE WHEN ${materializableElements.sourceKind} = 'as-built-ifc-bundle' THEN 0 ELSE 1 END`,
      materializableElements.createdAt,
    );

  return { ifcFile, elements };
}

async function toBimModelWire(bm: BimModel): Promise<BimModelWire> {
  const activeBriefingUpdatedAt = await loadActiveBriefingUpdatedAt(bm);
  const briefingElements = bm.activeBriefingId
    ? await loadElementsForBriefing(bm.activeBriefingId)
    : [];
  const ifcView = await loadAsBuiltIfcElementsForEngagement(bm.engagementId);
  // Order: IFC bundle first (so the viewer's "first row with glb wins"
  // picks it up), then briefing-derived elements, then per-IFC-entity rows.
  const ifcBundle = ifcView.elements.filter(
    (e) => e.sourceKind === "as-built-ifc-bundle",
  );
  const ifcEntities = ifcView.elements.filter(
    (e) => e.sourceKind === "as-built-ifc",
  );
  const elements = [...ifcBundle, ...briefingElements, ...ifcEntities];
  return {
    id: bm.id,
    engagementId: bm.engagementId,
    activeBriefingId: bm.activeBriefingId,
    briefingVersion: bm.briefingVersion,
    materializedAt: bm.materializedAt ? bm.materializedAt.toISOString() : null,
    revitDocumentPath: bm.revitDocumentPath,
    refreshStatus: computeRefreshStatus(bm, activeBriefingUpdatedAt),
    elements: elements.map(toElementWire),
    createdAt: bm.createdAt.toISOString(),
    updatedAt: bm.updatedAt.toISOString(),
  };
}

/**
 * Resolve the engagement's most-recent IFC ingest state for the
 * `ifcStatus` field on `EngagementBimModelResponse` (Track C). The FE
 * uses the status to drive an empty-state-vs-progress copy split + a
 * 2-second polling cadence while a parse is in flight.
 *
 *   - `idle`         — no IFC ever pushed for this engagement, OR the
 *                      most recent IFC parsed cleanly (in which case
 *                      bimModel will be non-null and the status is
 *                      moot but harmless).
 *   - `parsing`      — most recent IFC has `parsed_at` null AND no
 *                      `parse_error`.
 *   - `parse_failed` — most recent IFC has `parse_error` non-null.
 *                      The blob is preserved for re-push triage.
 */
async function loadIfcIngestStatusForEngagement(
  engagementId: string,
): Promise<{ status: "idle" | "parsing" | "parse_failed"; error: string | null }> {
  const rows = await db
    .select({
      parsedAt: snapshotIfcFiles.parsedAt,
      parseError: snapshotIfcFiles.parseError,
      uploadedAt: snapshotIfcFiles.uploadedAt,
    })
    .from(snapshotIfcFiles)
    .innerJoin(snapshots, eq(snapshots.id, snapshotIfcFiles.snapshotId))
    .where(eq(snapshots.engagementId, engagementId))
    // Most-recent push wins: a re-upload supersedes the prior row's
    // parse_error / parsed_at, so we read against `uploaded_at desc`
    // not `parsed_at desc` (a still-parsing re-push of a previously-
    // failed snapshot would otherwise stay stuck on `parse_failed`).
    .orderBy(desc(snapshotIfcFiles.uploadedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "idle", error: null };
  if (row.parseError !== null) {
    return { status: "parse_failed", error: row.parseError };
  }
  if (row.parsedAt === null) {
    return { status: "parsing", error: null };
  }
  return { status: "idle", error: null };
}

/**
 * Synthesize a BimModelWire for an engagement that has no `bim_models`
 * row but does have a parsed IFC ingest (Track B sprint). The viewer
 * doesn't care about the bim_models row identity per se — it only needs
 * the `elements` array to render the GLB. We invent a non-DB id so the
 * wire shape is stable and downstream consumers can branch on
 * `activeBriefingId === null && ifc-derived elements present`.
 */
async function synthesizeBimModelWireFromIfc(
  engagementId: string,
): Promise<BimModelWire | null> {
  const ifcView = await loadAsBuiltIfcElementsForEngagement(engagementId);
  if (!ifcView.ifcFile) return null;
  const ifcBundle = ifcView.elements.filter(
    (e) => e.sourceKind === "as-built-ifc-bundle",
  );
  const ifcEntities = ifcView.elements.filter(
    (e) => e.sourceKind === "as-built-ifc",
  );
  const elements = [...ifcBundle, ...ifcEntities];
  const parsedAt = ifcView.ifcFile.parsedAt;
  const stamp = parsedAt ? parsedAt.toISOString() : new Date(0).toISOString();
  return {
    // Synthetic id — `<ifc:snapshotId>` so admin tools can recognize the
    // row as a viewer-side fallback rather than a real bim_models row.
    id: `ifc:${ifcView.ifcFile.snapshotId}`,
    engagementId,
    activeBriefingId: null,
    briefingVersion: 0,
    materializedAt: parsedAt ? parsedAt.toISOString() : null,
    revitDocumentPath: null,
    refreshStatus: "current",
    elements: elements.map(toElementWire),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// ---------------------------------------------------------------------------
// HMAC verification — mirrors `converterClient.ts` (Task #113 contract):
// signature input is `requestId.bimModelId`, hex-digest of HMAC-SHA256.
// ---------------------------------------------------------------------------

/**
 * Result of {@link verifyDivergenceHmac}.
 *
 * - `ok: true`  — signature matches; the route may proceed.
 * - `ok: false` — surfaces the failure code the route uses to return
 *   401 vs 400 (`missing_secret` is a server misconfiguration → 500
 *   so an unauthorized caller can't probe it; `missing_headers` is a
 *   400 because the body parse already passed).
 */
type HmacVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "missing_secret"
        | "missing_headers"
        | "invalid_signature";
    };

function verifyDivergenceHmac(args: {
  requestId: string;
  signatureHeader: string;
  bimModelId: string;
}): HmacVerifyResult {
  const secret = process.env.BIM_MODEL_SHARED_SECRET;
  if (!secret || secret.length === 0) {
    return { ok: false, code: "missing_secret" };
  }
  if (!args.requestId || !args.signatureHeader) {
    return { ok: false, code: "missing_headers" };
  }
  const expected = createHmac("sha256", secret)
    .update(`${args.requestId}.${args.bimModelId}`)
    .digest("hex");

  const provided = args.signatureHeader.toLowerCase();
  // timingSafeEqual requires equal-length buffers — reject upfront
  // on a length mismatch so a length-only oracle can't leak which
  // hash family we're using.
  if (expected.length !== provided.length) {
    return { ok: false, code: "invalid_signature" };
  }
  const eq = timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  return eq ? { ok: true } : { ok: false, code: "invalid_signature" };
}

// ---------------------------------------------------------------------------
// Best-effort event emission helpers. Failures are swallowed and logged so
// the row is the source of truth — see file header.
// ---------------------------------------------------------------------------

async function emitBimModelEvent(
  history: EventAnchoringService,
  eventType: BimModelEventType,
  bm: BimModel,
  payload: Record<string, unknown>,
  reqLog: typeof logger,
): Promise<string | null> {
  try {
    const event = await history.appendEvent({
      entityType: "bim-model",
      entityId: bm.id,
      eventType,
      actor:
        eventType === BIM_MODEL_REFRESHED_EVENT_TYPE
          ? BIM_MODEL_REFRESH_ACTOR
          : eventType === BIM_MODEL_DIVERGED_EVENT_TYPE
            ? BIM_MODEL_DIVERGENCE_ACTOR
            : BIM_MODEL_PUSH_ACTOR,
      payload,
    });
    reqLog.info(
      {
        bimModelId: bm.id,
        engagementId: bm.engagementId,
        eventType,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      `${eventType} event appended`,
    );
    return event.id;
  } catch (err) {
    reqLog.error(
      { err, bimModelId: bm.id, engagementId: bm.engagementId, eventType },
      `${eventType} event append failed — row write kept`,
    );
    return null;
  }
}

async function emitDivergenceRecordedEvent(
  history: EventAnchoringService,
  divergence: BriefingDivergence,
  reqLog: typeof logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "briefing-divergence",
      entityId: divergence.id,
      eventType: BRIEFING_DIVERGENCE_RECORDED_EVENT_TYPE,
      actor: BIM_MODEL_DIVERGENCE_ACTOR,
      payload: {
        bimModelId: divergence.bimModelId,
        materializableElementId: divergence.materializableElementId,
        briefingId: divergence.briefingId,
        reason: divergence.reason,
        note: divergence.note,
      },
    });
    reqLog.info(
      {
        divergenceId: divergence.id,
        bimModelId: divergence.bimModelId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "briefing-divergence.recorded event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        divergenceId: divergence.id,
        bimModelId: divergence.bimModelId,
      },
      "briefing-divergence.recorded event append failed — row insert kept",
    );
  }
}

/**
 * Build the (actor, attributedActor) pair the two resolve-fan-out
 * emits share. `attributedActor` is the session-bound requestor when
 * the resolve was attributed; otherwise null. `actor` falls back to
 * a stable system actor so the timeline still gets a marker for the
 * acknowledgement when attribution was unavailable.
 */
function resolveDivergenceActor(divergence: BriefingDivergence): {
  actor: { kind: "user" | "agent" | "system"; id: string };
  attributedActor: { kind: "user" | "agent"; id: string } | null;
} {
  const requestorKind = divergence.resolvedByRequestorKind;
  const requestorId = divergence.resolvedByRequestorId;
  const attributedActor:
    | { kind: "user" | "agent"; id: string }
    | null =
    (requestorKind === "user" || requestorKind === "agent") && requestorId
      ? { kind: requestorKind, id: requestorId }
      : null;
  return {
    actor: attributedActor ?? BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR,
    attributedActor,
  };
}

/**
 * Emit `briefing-divergence.resolved` for the engagement timeline.
 *
 * Called only after a *fresh* resolve transaction (the row's
 * `resolvedAt` was null going in) so idempotent re-resolves do not
 * double-emit. `actor` is the session-bound requestor when the
 * resolve was attributed; otherwise we fall back to a stable system
 * actor so the timeline still gets a marker for the acknowledgement.
 */
async function emitDivergenceResolvedEvent(
  history: EventAnchoringService,
  divergence: BriefingDivergence,
  reqLog: typeof logger,
): Promise<void> {
  const { actor, attributedActor } = resolveDivergenceActor(divergence);
  try {
    const event = await history.appendEvent({
      entityType: "briefing-divergence",
      entityId: divergence.id,
      eventType: BRIEFING_DIVERGENCE_RESOLVED_EVENT_TYPE,
      actor,
      payload: {
        bimModelId: divergence.bimModelId,
        materializableElementId: divergence.materializableElementId,
        briefingId: divergence.briefingId,
        resolvedAt: divergence.resolvedAt
          ? divergence.resolvedAt.toISOString()
          : null,
        resolvedByRequestor: attributedActor,
      },
    });
    reqLog.info(
      {
        divergenceId: divergence.id,
        bimModelId: divergence.bimModelId,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "briefing-divergence.resolved event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        divergenceId: divergence.id,
        bimModelId: divergence.bimModelId,
      },
      "briefing-divergence.resolved event append failed — row update kept",
    );
  }
}

/**
 * Emit `bim-model.divergence-resolved` for the engagement-level
 * timeline (Task #267). The per-divergence
 * `briefing-divergence.resolved` event lands on the divergence row
 * itself; this fan-in mirror lands on the *parent* bim-model so the
 * engagement view picks the acknowledgement up without walking each
 * divergence chain — the same fan-out contract the record path uses
 * (`briefing-divergence.recorded` + `bim-model.diverged`).
 *
 * Called only after a *fresh* resolve transaction (gated on the same
 * `freshlyResolved` flag as the per-divergence emit) so an
 * idempotent re-resolve never double-emits on either timeline. Actor
 * attribution mirrors the per-divergence event so the two timelines
 * agree on *who* acknowledged the override.
 */
async function emitBimModelDivergenceResolvedEvent(
  history: EventAnchoringService,
  bm: BimModel,
  divergence: BriefingDivergence,
  reqLog: typeof logger,
): Promise<void> {
  const { actor, attributedActor } = resolveDivergenceActor(divergence);
  try {
    const event = await history.appendEvent({
      entityType: "bim-model",
      entityId: bm.id,
      eventType: BIM_MODEL_DIVERGENCE_RESOLVED_EVENT_TYPE,
      actor,
      payload: {
        divergenceId: divergence.id,
        materializableElementId: divergence.materializableElementId,
        briefingId: divergence.briefingId,
        reason: divergence.reason,
        resolvedAt: divergence.resolvedAt
          ? divergence.resolvedAt.toISOString()
          : null,
        resolvedByRequestor: attributedActor,
      },
    });
    reqLog.info(
      {
        bimModelId: bm.id,
        engagementId: bm.engagementId,
        divergenceId: divergence.id,
        eventType: BIM_MODEL_DIVERGENCE_RESOLVED_EVENT_TYPE,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "bim-model.divergence-resolved event appended",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        bimModelId: bm.id,
        engagementId: bm.engagementId,
        divergenceId: divergence.id,
      },
      "bim-model.divergence-resolved event append failed — row update kept",
    );
  }
}

// ---------------------------------------------------------------------------
// Object storage — lazy singleton mirroring the briefingSources route. The
// constructor reads env on first call and tests inject env via the harness
// rather than at module load, so we can't construct it eagerly at import time.
// ---------------------------------------------------------------------------

let cachedObjectStorage: ObjectStorageService | null = null;
function objectStorage(): ObjectStorageService {
  if (!cachedObjectStorage) cachedObjectStorage = new ObjectStorageService();
  return cachedObjectStorage;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /materializable-elements/:id/glb — Plan Review BIM viewport bytes
 * endpoint (Task #379).
 *
 * Streams the `model/gltf-binary` bytes for one materializable element whose
 * `glbObjectPath` points at a glb in object storage. Mirrors the
 * `GET /briefing-sources/:id/glb` contract (same ETag / cache-header /
 * If-None-Match short-circuit) but is keyed by the materializable-element row
 * id rather than its briefing-source parent.
 *
 * Why this endpoint exists alongside the briefing-source one: an element row
 * is allowed to advertise a `glbObjectPath` without a `briefingSourceId`
 * (e.g. an architect-supplied mesh that didn't go through the briefing-source
 * converter pipeline). Before this route, those "orphan" elements were
 * counted as renderable in the viewport but the viewer had no way to fetch
 * the bytes — a glb-orphan hint surfaced instead. With this route the
 * viewport can pull the bytes by element id and render the mesh in scene,
 * which is what the reviewer expects when they jump to a terrain / setback
 * / neighbor-mass element from a finding.
 *
 * Auth posture: gated by `requireArchitectAudience`, matching the rest of
 * `bimModels.ts`. Per the security review on V1-3, content-addressing the
 * bytes by row id is not sufficient — the row id is leaked in the briefing
 * payload alongside the engagement context, and an applicant who reaches
 * that payload should not be able to fetch the materialized geometry. The
 * gate is the same audience check the parent `bim-model` GET applies; the
 * divergence S2S route remains exempt because of its HMAC contract.
 */
router.get(
  "/materializable-elements/:id/glb",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BIM_MODEL_AUDIENCE_ERROR)) return;
    const paramsParse = GetMaterializableElementGlbParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_materializable_element_id" });
      return;
    }
    const { id } = paramsParse.data;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    try {
      const rows = await db
        .select({
          id: materializableElements.id,
          glbObjectPath: materializableElements.glbObjectPath,
        })
        .from(materializableElements)
        .where(eq(materializableElements.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "materializable_element_not_found" });
        return;
      }
      // No glb attached — element is either inline-ring (geometry suffices
      // on the C# side) or hasn't been backed by a converted mesh yet.
      // Uniform 404 so the viewer renders a single fallback branch.
      if (!row.glbObjectPath) {
        res.status(404).json({ error: "glb_not_attached" });
        return;
      }

      let bytes: Buffer;
      try {
        bytes = await objectStorage().getObjectEntityBytes(row.glbObjectPath);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          // The row points at bytes the bucket no longer holds — same drift
          // posture as the briefing-source route: surface as 404 so the
          // viewer renders its "not available" hint and log loudly so an
          // operator sees the row-vs-bucket mismatch.
          reqLog.error(
            { id, glbObjectPath: row.glbObjectPath },
            "glb bytes missing for materializable element with glbObjectPath",
          );
          res.status(404).json({ error: "glb_bytes_missing" });
          return;
        }
        throw err;
      }

      const etag = `"${createHash("sha1").update(bytes).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("Content-Type", "model/gltf-binary");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("ETag", etag);
      res.end(bytes);
    } catch (err) {
      reqLog.error({ err, id }, "serve materializable element glb failed");
      res.status(500).json({ error: "Failed to load materializable element glb" });
    }
  },
);

router.get(
  "/engagements/:id/bim-model",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BIM_MODEL_AUDIENCE_ERROR)) return;
    const paramsParse = GetEngagementBimModelParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    try {
      const eng = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (eng.length === 0) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      const rows = await db
        .select()
        .from(bimModels)
        .where(eq(bimModels.engagementId, engagementId))
        .limit(1);
      const bm = rows[0];
      // Resolve the IFC ingest status alongside the row read so the
      // FE Snapshots tab can render "Processing IFC export…" / parse-
      // failed copy without a second round-trip (Track C).
      const ifcIngest = await loadIfcIngestStatusForEngagement(engagementId);
      if (!bm) {
        // Fallback: no bim_models row, but the engagement may have a
        // parsed IFC ingest (Track B sprint). Surface that as a
        // synthetic BimModelWire so the viewer can render IFC geometry
        // without the C# add-in having registered a row first.
        const synthesized = await synthesizeBimModelWireFromIfc(engagementId);
        res.json({
          bimModel: synthesized ?? null,
          ifcStatus: ifcIngest.status,
          ifcError: ifcIngest.error,
        });
        return;
      }
      res.json({
        bimModel: await toBimModelWire(bm),
        ifcStatus: ifcIngest.status,
        ifcError: ifcIngest.error,
      });
    } catch (err) {
      reqLog.error({ err, engagementId }, "get engagement bim-model failed");
      res.status(500).json({ error: "Failed to load bim-model" });
    }
  },
);

router.post(
  "/engagements/:id/bim-model",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BIM_MODEL_AUDIENCE_ERROR)) return;
    const paramsParse = PushEngagementBimModelParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;

    // Body is optional (the only field is a nullable revitDocumentPath);
    // when missing we feed the parser an empty object so the success
    // branch always lands and `body.revitDocumentPath` falls through
    // as undefined.
    const bodyParse = PushEngagementBimModelBody.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      res.status(400).json({ error: "invalid_push_bim_model_body" });
      return;
    }
    const body = bodyParse.data;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    let upserted: BimModel;
    try {
      upserted = await db.transaction(async (tx) => {
        const eng = await tx
          .select({ id: engagements.id })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .limit(1);
        if (eng.length === 0) {
          throw new EngagementNotFoundError(engagementId);
        }

        // Resolve the engagement's currently-active briefing on the
        // server side. The C#-side push intent is "materialize whatever
        // is current right now" — trusting the client to name the
        // briefing would invite a TOCTOU race against a concurrent
        // briefing-source upload that supersedes the named row.
        const briefingRows = await tx
          .select({ id: parcelBriefings.id })
          .from(parcelBriefings)
          .where(eq(parcelBriefings.engagementId, engagementId))
          .limit(1);
        const activeBriefing = briefingRows[0];
        if (!activeBriefing) {
          throw new BimModelMissingBriefingError(engagementId);
        }

        const now = new Date();
        const revitDocumentPath = body.revitDocumentPath ?? null;

        // ON CONFLICT DO UPDATE keyed on the engagement_id unique
        // constraint — this is the idempotency contract: a re-push
        // for the same engagement updates the existing row in place.
        // briefingVersion is not bumped here because the briefing-
        // version column will become meaningful once DA-PI-3 lands
        // its monotonic version stamp on parcel_briefings; until
        // then we keep it at 0 so a never-rewritten row stays a
        // valid stale-detection input.
        const [row] = await tx
          .insert(bimModels)
          .values({
            engagementId,
            activeBriefingId: activeBriefing.id,
            materializedAt: now,
            revitDocumentPath,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: bimModels.engagementId,
            set: {
              activeBriefingId: activeBriefing.id,
              materializedAt: now,
              revitDocumentPath,
              updatedAt: now,
            },
          })
          .returning();
        return row;
      });
    } catch (err) {
      if (err instanceof EngagementNotFoundError) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      if (err instanceof BimModelMissingBriefingError) {
        res
          .status(400)
          .json({ error: "engagement_has_no_active_briefing" });
        return;
      }
      reqLog.error(
        { err, engagementId },
        "push engagement bim-model failed",
      );
      res.status(500).json({ error: "Failed to push bim-model" });
      return;
    }

    await emitBimModelEvent(
      getHistoryService(),
      BIM_MODEL_MATERIALIZED_EVENT_TYPE,
      upserted,
      {
        engagementId: upserted.engagementId,
        activeBriefingId: upserted.activeBriefingId,
        materializedAt: upserted.materializedAt
          ? upserted.materializedAt.toISOString()
          : null,
        revitDocumentPath: upserted.revitDocumentPath,
      },
      reqLog,
    );

    // POST also returns the same envelope as GET (Track C — `ifcStatus`
    // is part of the `EngagementBimModelResponse` contract). The IFC
    // ingest is independent of bim-model push, but a push that lands
    // while a parse is in flight should still surface the parsing copy
    // to whoever observes the POST response — they're rare in practice
    // (the C# add-in pushes; the parsing is server-side ingest from a
    // separate snapshot upload), but the wire shape must include the
    // field unconditionally.
    const ifcIngest = await loadIfcIngestStatusForEngagement(engagementId);
    res.status(200).json({
      bimModel: await toBimModelWire(upserted),
      ifcStatus: ifcIngest.status,
      ifcError: ifcIngest.error,
    });
  },
);

router.get(
  "/bim-models/:id/refresh",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BIM_MODEL_AUDIENCE_ERROR)) return;
    const paramsParse = GetBimModelRefreshParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_bim_model_id" });
      return;
    }
    const bimModelId = paramsParse.data.id;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    try {
      const rows = await db
        .select()
        .from(bimModels)
        .where(eq(bimModels.id, bimModelId))
        .limit(1);
      const bm = rows[0];
      if (!bm) {
        res.status(404).json({ error: "bim_model_not_found" });
        return;
      }
      const activeBriefingUpdatedAt = await loadActiveBriefingUpdatedAt(bm);
      const refreshStatus = computeRefreshStatus(bm, activeBriefingUpdatedAt);

      // Element-level diff for the C# re-materialization protocol —
      // see `computeElementDiff` for the timestamp rules.
      const elements = bm.activeBriefingId
        ? await loadElementsForBriefing(bm.activeBriefingId)
        : [];
      const diff = computeElementDiff(bm, elements);

      // Best-effort refresh-poll audit. The poll is what the C# add-in
      // calls on focus; the timeline preserves a row per poll so an
      // operator can reconstruct when the architect saw the stale
      // badge vs. the current pill.
      const refreshedEventId = await emitBimModelEvent(
        getHistoryService(),
        BIM_MODEL_REFRESHED_EVENT_TYPE,
        bm,
        {
          engagementId: bm.engagementId,
          activeBriefingId: bm.activeBriefingId,
          refreshStatus,
          activeBriefingUpdatedAt: activeBriefingUpdatedAt
            ? activeBriefingUpdatedAt.toISOString()
            : null,
          materializedAt: bm.materializedAt
            ? bm.materializedAt.toISOString()
            : null,
          addedCount: diff.addedCount,
          modifiedCount: diff.modifiedCount,
          unchangedCount: diff.unchangedCount,
        },
        reqLog,
      );

      // V1-2 implicit-resolve hook: a `bim-model.refreshed` emit closes
      // every `pending` reviewer-request whose target tuple matches
      // this bim-model. Best-effort — never fails the in-flight poll.
      if (refreshedEventId) {
        await resolveMatchingReviewerRequests({
          targetEntityType: "bim-model",
          targetEntityId: bm.id,
          triggeredActionEventId: refreshedEventId,
          log: reqLog,
        });
      }

      res.json({
        bimModelId: bm.id,
        engagementId: bm.engagementId,
        refreshStatus,
        materializedAt: bm.materializedAt
          ? bm.materializedAt.toISOString()
          : null,
        briefingVersion: bm.briefingVersion,
        activeBriefingId: bm.activeBriefingId,
        activeBriefingUpdatedAt: activeBriefingUpdatedAt
          ? activeBriefingUpdatedAt.toISOString()
          : null,
        diff,
      });
    } catch (err) {
      reqLog.error({ err, bimModelId }, "get bim-model refresh failed");
      res.status(500).json({ error: "Failed to compute bim-model refresh" });
    }
  },
);

/**
 * GET /bim-models/:id/divergences — newest-first list of recorded
 * architect overrides against this bim-model's locked materializable
 * elements. Joins each divergence with its parent element so the
 * design-tools Site Context tab can group by element kind/label
 * without a follow-up fetch.
 *
 * Browser-facing — gated by the architect-audience guard the rest
 * of the bim-model surface uses; the S2S divergence POST is the
 * only writer and carries its own HMAC trust contract.
 *
 * The join is intentionally a left join: the
 * `briefing_divergences.materializable_element_id` FK has
 * `onDelete: cascade`, so today the materializable element will
 * always be present at query time, but a follow-up that softens
 * that cascade (e.g. tombstoning instead of deleting) would
 * surface here as null `elementKind`/`elementLabel` rather than
 * silently dropping the audit row.
 */
router.get(
  "/bim-models/:id/divergences",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BIM_MODEL_AUDIENCE_ERROR)) return;
    const paramsParse = ListBimModelDivergencesParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_bim_model_id" });
      return;
    }
    const bimModelId = paramsParse.data.id;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    try {
      const bmRows = await db
        .select({ id: bimModels.id })
        .from(bimModels)
        .where(eq(bimModels.id, bimModelId))
        .limit(1);
      if (bmRows.length === 0) {
        res.status(404).json({ error: "bim_model_not_found" });
        return;
      }

      // Open rows first (NULLS FIRST on `resolvedAt`), then within
      // each group newest-first by `createdAt`. The FE partitions
      // into Open / Resolved sections (Task #191) and a server-side
      // primary sort on `resolvedAt` keeps the order the operator
      // sees stable across mounts without a client-side re-sort.
      const rows = await db
        .select({
          divergence: briefingDivergences,
          elementKind: materializableElements.elementKind,
          elementLabel: materializableElements.label,
        })
        .from(briefingDivergences)
        .leftJoin(
          materializableElements,
          eq(
            materializableElements.id,
            briefingDivergences.materializableElementId,
          ),
        )
        .where(eq(briefingDivergences.bimModelId, bimModelId))
        .orderBy(
          sql`${briefingDivergences.resolvedAt} ASC NULLS FIRST`,
          desc(briefingDivergences.createdAt),
        );

      // Batched profile hydration so each Resolved row's
      // `resolvedByRequestor.{displayName,avatarUrl}` is populated
      // without a per-row round-trip. Best-effort: a failed lookup
      // degrades to the raw id / initials chip (the helper logs and
      // returns an empty map).
      const profileByUserId = await lookupResolverProfiles(rows, reqLog);

      const divergences: BimModelDivergenceListEntryWire[] = rows.map((r) => ({
        ...toDivergenceWire(r.divergence, profileByUserId),
        elementKind: r.elementKind ?? null,
        elementLabel: r.elementLabel ?? null,
      }));

      res.json({ divergences });
    } catch (err) {
      reqLog.error(
        { err, bimModelId },
        "list bim-model divergences failed",
      );
      res.status(500).json({ error: "Failed to list divergences" });
    }
  },
);

/**
 * POST /bim-models/:id/divergences/:divergenceId/resolve — operator
 * acknowledgement (Task #191). Marks a recorded divergence as
 * Resolved so the Site Context tab can move it out of the "open
 * overrides" list.
 *
 * Idempotent: re-resolving an already-resolved row is a no-op
 * (returns 200 with the existing `resolvedAt` / `resolvedByRequestor`
 * unchanged). Resolution is a *soft* acknowledgement layered on
 * the append-only record — the row is never removed, and a
 * follow-up `POST /bim-models/:id/divergence` for the same element
 * lands as a fresh row.
 *
 * Timeline emit (Task #213): the *first* successful resolve appends
 * a `briefing-divergence.resolved` atom event so the engagement
 * timeline can show "operator X acknowledged the override at 3pm"
 * — closing the loop on the existing
 * `briefing-divergence.recorded` + `bim-model.diverged` pair the
 * record path emits. The emit is gated on a freshly-resolved flag
 * the transaction returns so an idempotent re-resolve never
 * double-emits.
 *
 * Engagement-scoped: gated by the same architect-audience guard
 * the rest of the bim-model browser surface uses. The resolve is
 * attributed to `req.session.requestor` when present so the
 * timeline can show who acknowledged it; an unauthenticated dev
 * request still resolves the row but lands with
 * `resolvedByRequestor: null` (mirrors how
 * `actorFromRequest` in `engagements.ts` falls back to a system
 * actor for unauthenticated callers).
 */
router.post(
  "/bim-models/:id/divergences/:divergenceId/resolve",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res, BIM_MODEL_AUDIENCE_ERROR)) return;
    const paramsParse = ResolveBimModelDivergenceParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_divergence_path" });
      return;
    }
    const { id: bimModelId, divergenceId } = paramsParse.data;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    // Resolve the requestor *before* the transaction so a missing
    // session shape never blocks the write — the resolve still
    // lands, but `resolvedByRequestor` ends up null so the FE can
    // distinguish a system-side resolve from an attributed one.
    const requestor = req.session?.requestor;
    const resolvedByKind =
      requestor && requestor.id ? requestor.kind : null;
    const resolvedById =
      requestor && requestor.id ? requestor.id : null;

    let resolved: {
      divergence: BriefingDivergence;
      bimModel: BimModel;
      elementKind: string | null;
      elementLabel: string | null;
      /**
       * True only when this transaction flipped the row from Open
       * to Resolved. The post-transaction timeline emit gates on
       * this flag so an idempotent re-resolve never double-emits
       * (on either the per-divergence or the per-bim-model timeline).
       */
      freshlyResolved: boolean;
    };
    try {
      resolved = await db.transaction(async (tx) => {
        // Select the full bim-model row, not just the id — the
        // post-transaction fan-in emit (Task #267) needs
        // `engagementId` for log-context parity with the recorded
        // path's `bim-model.diverged` emit.
        const bmRows = await tx
          .select()
          .from(bimModels)
          .where(eq(bimModels.id, bimModelId))
          .limit(1);
        if (bmRows.length === 0) {
          throw new BimModelNotFoundError(bimModelId);
        }
        const bm = bmRows[0];

        const existingRows = await tx
          .select()
          .from(briefingDivergences)
          .where(eq(briefingDivergences.id, divergenceId))
          .limit(1);
        const existing = existingRows[0];
        // The divergence must belong to the bim-model named in the
        // path. Crossing bim-models would let an architect on
        // engagement A acknowledge an override recorded on
        // engagement B — refuse explicitly so that scenario surfaces
        // as a 404 rather than a silent state change.
        if (!existing || existing.bimModelId !== bimModelId) {
          throw new DivergenceNotFoundError(divergenceId, bimModelId);
        }

        let row = existing;
        let freshlyResolved = false;
        // Idempotent re-resolve: leave the original timestamp +
        // requestor in place. The first acknowledger keeps the
        // attribution.
        //
        // Conditional UPDATE (`WHERE resolvedAt IS NULL`) — combined
        // with deriving `freshlyResolved` from the affected row
        // count — guarantees emit-once even under concurrent
        // resolves. Two simultaneous first-resolve requests would
        // both observe `existing.resolvedAt === null` on read, but
        // Postgres serializes the two UPDATEs through the row lock;
        // the second one re-checks the predicate against the
        // committed value and matches zero rows, so its `updated`
        // array comes back empty and the post-tx emit is skipped.
        if (!existing.resolvedAt) {
          const updated = await tx
            .update(briefingDivergences)
            .set({
              resolvedAt: new Date(),
              resolvedByRequestorKind: resolvedByKind,
              resolvedByRequestorId: resolvedById,
            })
            .where(
              and(
                eq(briefingDivergences.id, divergenceId),
                isNull(briefingDivergences.resolvedAt),
              ),
            )
            .returning();
          if (updated.length === 1) {
            row = updated[0];
            freshlyResolved = true;
          } else {
            // A concurrent resolve beat us to it. Re-read the row
            // so the response carries the *winning* attribution
            // (preserves "first acknowledger keeps the audit
            // trail") instead of the now-stale snapshot.
            const reReadRows = await tx
              .select()
              .from(briefingDivergences)
              .where(eq(briefingDivergences.id, divergenceId))
              .limit(1);
            row = reReadRows[0] ?? existing;
          }
        }

        // Pull element kind+label so the FE can splice the response
        // into the list cache without a follow-up fetch (mirrors
        // the join the list route does).
        const elemRows = await tx
          .select({
            elementKind: materializableElements.elementKind,
            elementLabel: materializableElements.label,
          })
          .from(materializableElements)
          .where(eq(materializableElements.id, row.materializableElementId))
          .limit(1);
        const elem = elemRows[0];
        return {
          divergence: row,
          bimModel: bm,
          elementKind: elem?.elementKind ?? null,
          elementLabel: elem?.elementLabel ?? null,
          freshlyResolved,
        };
      });
    } catch (err) {
      if (err instanceof BimModelNotFoundError) {
        res.status(404).json({ error: "bim_model_not_found" });
        return;
      }
      if (err instanceof DivergenceNotFoundError) {
        res.status(404).json({ error: "divergence_not_found" });
        return;
      }
      reqLog.error(
        { err, bimModelId, divergenceId },
        "resolve bim-model divergence failed",
      );
      res.status(500).json({ error: "Failed to resolve divergence" });
      return;
    }

    // Only the *first* resolve emits the timeline event — an
    // idempotent re-resolve must not double-emit (a single
    // acknowledgement marker is the audit-trail intent).
    //
    // Two-event fan-out (Task #267): the per-divergence event lands
    // on the divergence row's own timeline; the per-bim-model
    // fan-in event lands on the parent bim-model so the engagement
    // view picks the acknowledgement up without walking each
    // divergence chain. Mirrors the record path's
    // `briefing-divergence.recorded` + `bim-model.diverged` pair.
    if (resolved.freshlyResolved) {
      const history = getHistoryService();
      await emitDivergenceResolvedEvent(
        history,
        resolved.divergence,
        reqLog,
      );
      await emitBimModelDivergenceResolvedEvent(
        history,
        resolved.bimModel,
        resolved.divergence,
        reqLog,
      );
    }

    // Hydrate the resolver's profile so the splice the FE performs
    // against its cached list (Task #212 / Task #269) carries the
    // friendly attribution and avatar rather than a raw id. The
    // lookup is best-effort — a failed hydration degrades to the
    // raw id / initials chip on the FE side.
    const profileByUserId = await lookupResolverProfiles(
      [{ divergence: resolved.divergence }],
      reqLog,
    );

    const wire: BimModelDivergenceListEntryWire = {
      ...toDivergenceWire(resolved.divergence, profileByUserId),
      elementKind: resolved.elementKind,
      elementLabel: resolved.elementLabel,
    };
    res.json({ divergence: wire });
  },
);

router.post(
  "/bim-models/:id/divergence",
  async (req: Request, res: Response) => {
    const paramsParse = RecordBimModelDivergenceParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_bim_model_id" });
      return;
    }
    const bimModelId = paramsParse.data.id;

    const requestIdHeader = req.header("x-bim-model-request-id") ?? "";
    const signatureHeader = req.header("x-bim-model-signature") ?? "";
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    const verify = verifyDivergenceHmac({
      requestId: requestIdHeader,
      signatureHeader,
      bimModelId,
    });
    if (!verify.ok) {
      if (verify.code === "missing_secret") {
        // Server misconfiguration is a 500: surfacing it as a 401
        // would let an unauthorized probe distinguish "not set up
        // here" from "wrong key", which is the wrong tradeoff.
        reqLog.error(
          { bimModelId },
          "BIM_MODEL_SHARED_SECRET not configured — refusing divergence write",
        );
        res
          .status(500)
          .json({ error: "bim_model_divergence_secret_not_configured" });
        return;
      }
      if (verify.code === "missing_headers") {
        res.status(400).json({ error: "missing_bim_model_signature_headers" });
        return;
      }
      res.status(401).json({ error: "invalid_bim_model_signature" });
      return;
    }

    const bodyParse = RecordBimModelDivergenceBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({ error: "invalid_divergence_body" });
      return;
    }
    const body = bodyParse.data;
    const trimmedNote = body.note?.trim() ?? null;
    const note = trimmedNote && trimmedNote.length > 0 ? trimmedNote : null;
    const detail = (body.detail ?? {}) as Record<string, unknown>;

    // Defensive: the zod enum already gates this, but mirror the
    // schema-side closed set so a future enum drift here surfaces as
    // a TypeScript error rather than a runtime constraint violation.
    if (
      !(BRIEFING_DIVERGENCE_REASONS as ReadonlyArray<string>).includes(
        body.reason,
      )
    ) {
      res.status(400).json({ error: "invalid_divergence_reason" });
      return;
    }

    let inserted: { divergence: BriefingDivergence; bimModel: BimModel };
    try {
      inserted = await db.transaction(async (tx) => {
        const bmRows = await tx
          .select()
          .from(bimModels)
          .where(eq(bimModels.id, bimModelId))
          .limit(1);
        const bm = bmRows[0];
        if (!bm) {
          throw new BimModelNotFoundError(bimModelId);
        }

        // The element must belong to a briefing that's actually
        // current for the bim-model. Refusing cross-briefing
        // divergences keeps the audit trail coherent: a divergence
        // dangling against a long-superseded briefing would be a
        // surfacing surprise on every "show me what the architect
        // overrode" query.
        const elemRows = await tx
          .select()
          .from(materializableElements)
          .where(
            eq(materializableElements.id, body.materializableElementId),
          )
          .limit(1);
        const elem = elemRows[0];
        if (!elem) {
          throw new MaterializableElementNotFoundError(
            body.materializableElementId,
          );
        }
        if (!bm.activeBriefingId || elem.briefingId !== bm.activeBriefingId) {
          throw new ElementBriefingMismatchError(
            elem.id,
            bm.id,
            elem.briefingId,
            bm.activeBriefingId,
          );
        }

        const [row] = await tx
          .insert(briefingDivergences)
          .values({
            bimModelId: bm.id,
            materializableElementId: elem.id,
            // Element's briefing matches the bim-model's active briefing
            // post-guard (line 1712); use bm.activeBriefingId since TS has
            // narrowed it non-null whereas elem.briefingId stays
            // `string | null` from the schema-level relaxation.
            briefingId: bm.activeBriefingId,
            reason: body.reason,
            note,
            detail,
          })
          .returning();

        // Bump the bim-model's updatedAt so a downstream cache key
        // derived from updatedAt (or a timeline-fold sort) sees the
        // divergence write without needing an out-of-band poke.
        await tx
          .update(bimModels)
          .set({ updatedAt: new Date() })
          .where(eq(bimModels.id, bm.id));

        return { divergence: row, bimModel: bm };
      });
    } catch (err) {
      if (err instanceof BimModelNotFoundError) {
        res.status(404).json({ error: "bim_model_not_found" });
        return;
      }
      if (err instanceof MaterializableElementNotFoundError) {
        res
          .status(404)
          .json({ error: "materializable_element_not_found" });
        return;
      }
      if (err instanceof ElementBriefingMismatchError) {
        res.status(400).json({
          error: "element_does_not_belong_to_active_briefing",
        });
        return;
      }
      reqLog.error(
        {
          err,
          bimModelId,
          materializableElementId: body.materializableElementId,
        },
        "record bim-model divergence failed",
      );
      res.status(500).json({ error: "Failed to record divergence" });
      return;
    }

    await emitDivergenceRecordedEvent(
      getHistoryService(),
      inserted.divergence,
      reqLog,
    );
    // Also emit the parent-bim-model fan-in so the engagement
    // timeline picks up "the architect overrode something here"
    // without having to walk per-element chains.
    await emitBimModelEvent(
      getHistoryService(),
      BIM_MODEL_DIVERGED_EVENT_TYPE,
      inserted.bimModel,
      {
        divergenceId: inserted.divergence.id,
        materializableElementId: inserted.divergence.materializableElementId,
        briefingId: inserted.divergence.briefingId,
        reason: inserted.divergence.reason,
      },
      reqLog,
    );

    res.status(201).json({ divergence: toDivergenceWire(inserted.divergence) });
  },
);

// ---------------------------------------------------------------------------
// Tagged sentinels — let the catch blocks above map to the right HTTP code
// without leaking generic 500s for known business errors.
// ---------------------------------------------------------------------------

class EngagementNotFoundError extends Error {
  constructor(engagementId: string) {
    super(`engagement ${engagementId} not found`);
    this.name = "EngagementNotFoundError";
    Object.setPrototypeOf(this, EngagementNotFoundError.prototype);
  }
}

class BimModelMissingBriefingError extends Error {
  constructor(engagementId: string) {
    super(`engagement ${engagementId} has no active briefing`);
    this.name = "BimModelMissingBriefingError";
    Object.setPrototypeOf(this, BimModelMissingBriefingError.prototype);
  }
}

class BimModelNotFoundError extends Error {
  constructor(bimModelId: string) {
    super(`bim-model ${bimModelId} not found`);
    this.name = "BimModelNotFoundError";
    Object.setPrototypeOf(this, BimModelNotFoundError.prototype);
  }
}

class MaterializableElementNotFoundError extends Error {
  constructor(elementId: string) {
    super(`materializable-element ${elementId} not found`);
    this.name = "MaterializableElementNotFoundError";
    Object.setPrototypeOf(this, MaterializableElementNotFoundError.prototype);
  }
}

class DivergenceNotFoundError extends Error {
  constructor(divergenceId: string, bimModelId: string) {
    super(
      `divergence ${divergenceId} not found under bim-model ${bimModelId}`,
    );
    this.name = "DivergenceNotFoundError";
    Object.setPrototypeOf(this, DivergenceNotFoundError.prototype);
  }
}

class ElementBriefingMismatchError extends Error {
  constructor(
    elementId: string,
    bimModelId: string,
    elementBriefingId: string | null,
    bimModelBriefingId: string | null,
  ) {
    super(
      `element ${elementId} belongs to briefing ${elementBriefingId ?? "(none)"} but bim-model ${bimModelId} is active against ${bimModelBriefingId ?? "(none)"}`,
    );
    this.name = "ElementBriefingMismatchError";
    Object.setPrototypeOf(this, ElementBriefingMismatchError.prototype);
  }
}

export default router;
