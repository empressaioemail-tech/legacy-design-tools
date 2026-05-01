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
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  db,
  engagements,
  parcelBriefings,
  bimModels,
  materializableElements,
  briefingDivergences,
  BRIEFING_DIVERGENCE_REASONS,
  type BimModel,
  type MaterializableElement,
  type BriefingDivergence,
} from "@workspace/db";
import { eq, desc, sql, and, isNull } from "drizzle-orm";
import {
  GetEngagementBimModelParams,
  PushEngagementBimModelParams,
  PushEngagementBimModelBody,
  GetBimModelRefreshParams,
  ListBimModelDivergencesParams,
  RecordBimModelDivergenceParams,
  RecordBimModelDivergenceBody,
  ResolveBimModelDivergenceParams,
} from "@workspace/api-zod";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { hydrateActors } from "../lib/userLookup";
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

const BRIEFING_DIVERGENCE_RECORDED_EVENT_TYPE: BriefingDivergenceEventType =
  BRIEFING_DIVERGENCE_EVENT_TYPES[0];
const BRIEFING_DIVERGENCE_RESOLVED_EVENT_TYPE: BriefingDivergenceEventType =
  BRIEFING_DIVERGENCE_EVENT_TYPES[1];

/** Stable system actor for design-tools-driven bim-model writes. */
const BIM_MODEL_PUSH_ACTOR = {
  kind: "system" as const,
  id: "bim-model-push",
};

/** Stable system actor for the refresh-diff polling path. */
const BIM_MODEL_REFRESH_ACTOR = {
  kind: "system" as const,
  id: "bim-model-refresh",
};

/** Stable system actor for divergences the C# add-in records. */
const BIM_MODEL_DIVERGENCE_ACTOR = {
  kind: "system" as const,
  id: "bim-model-divergence",
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
  id: "bim-model-divergence-resolve",
};

// ---------------------------------------------------------------------------
// Wire shapes — kept narrow on purpose so a rename in the schema layer breaks
// compilation here rather than silently round-tripping through the wire.
// ---------------------------------------------------------------------------

interface MaterializableElementWire {
  id: string;
  briefingId: string;
  elementKind: string;
  briefingSourceId: string | null;
  label: string | null;
  geometry: Record<string, unknown>;
  glbObjectPath: string | null;
  locked: boolean;
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
    briefingSourceId: e.briefingSourceId,
    label: e.label,
    // The DB column is a `jsonb` typed as `unknown` by drizzle's
    // inferSelect; the OpenAPI schema declares it as a free-form
    // object so the cast is the wire-contract bridge.
    geometry: (e.geometry ?? {}) as Record<string, unknown>,
    glbObjectPath: e.glbObjectPath,
    locked: e.locked,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function toDivergenceWire(
  d: BriefingDivergence,
  displayNameByUserId?: ReadonlyMap<string, string>,
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
    resolvedByRequestor: toResolvedByRequestor(d, displayNameByUserId),
  };
}

/**
 * Reconstruct the wire `{kind, id}` requestor pair from the two
 * stored columns. Both must be present (and `kind` must be one of
 * the closed `user` / `agent` set the session middleware emits) for
 * the wire field to populate; a half-populated row degrades to
 * `null` so the FE never has to handle a partially-typed actor.
 *
 * When a `displayNameByUserId` map is supplied (the engagement-side
 * surfaces hydrate identities via the `users` table — see
 * `hydrateActors`), a matching `kind === "user"` row gains an
 * optional `displayName` so the FE can render "Resolved by Jane Doe"
 * (Task #212) instead of an opaque user id. The lookup is best
 * effort: an unknown id (e.g. profile deleted) leaves the field
 * absent and the FE falls back to the raw id.
 */
function toResolvedByRequestor(
  d: BriefingDivergence,
  displayNameByUserId?: ReadonlyMap<string, string>,
): RequestorRefWire | null {
  const kind = d.resolvedByRequestorKind;
  const id = d.resolvedByRequestorId;
  if (!kind || !id) return null;
  if (kind !== "user" && kind !== "agent") return null;
  const ref: RequestorRefWire = { kind, id };
  if (kind === "user") {
    const displayName = displayNameByUserId?.get(id);
    if (displayName) ref.displayName = displayName;
  }
  return ref;
}

/**
 * Best-effort batched display-name lookup for the user-kind
 * resolvers across a set of divergence rows (Task #212). The list /
 * resolve endpoints feed the resulting map straight into
 * `toDivergenceWire` so the wire's `resolvedByRequestor.displayName`
 * gets populated in a single round-trip regardless of how many rows
 * we're returning.
 *
 * Mirrors the posture of the snapshot/atom-history hydration paths:
 * a thrown lookup (transient DB hiccup against the `users` table)
 * degrades silently to the empty map so the audit-trail row still
 * renders with the raw id rather than failing the whole request.
 */
async function lookupResolverDisplayNames(
  rows: ReadonlyArray<{ divergence: BriefingDivergence }>,
  reqLog: typeof logger,
): Promise<Map<string, string>> {
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
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  try {
    const hydrated = await hydrateActors(userIds);
    for (const a of hydrated) {
      if (a.kind === "user" && a.displayName) {
        out.set(a.id, a.displayName);
      }
    }
  } catch (err) {
    reqLog.warn(
      { err },
      "bim-model divergence: resolver display-name hydration failed",
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
 * Engagement-scoped guard for architect-facing bim-model routes.
 *
 * The bim-model row carries the engagement's Revit binding (active
 * briefing pointer, materialized-at timestamp, optional Revit
 * document path). Per the security review on Task #166, none of
 * those fields should be visible to an anonymous applicant — the
 * `sessionMiddleware` fails closed in production and serves
 * `audience: "user"` to every unverified caller, so an audience
 * check here is the gate that keeps Revit details inside the
 * architect-facing surface. Returns `true` once the guard sent a
 * 403 so the caller can early-return.
 *
 * The S2S divergence route is exempt: it carries its own
 * HMAC-SHA256 trust contract and runs as a system actor, not a
 * browser session.
 */
function requireArchitectAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res
    .status(403)
    .json({ error: "bim_model_requires_architect_audience" });
  return true;
}

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
 */
async function loadElementsForBriefing(
  briefingId: string,
): Promise<MaterializableElement[]> {
  return db
    .select()
    .from(materializableElements)
    .where(eq(materializableElements.briefingId, briefingId))
    .orderBy(materializableElements.elementKind, materializableElements.createdAt);
}

async function toBimModelWire(bm: BimModel): Promise<BimModelWire> {
  const activeBriefingUpdatedAt = await loadActiveBriefingUpdatedAt(bm);
  const elements = bm.activeBriefingId
    ? await loadElementsForBriefing(bm.activeBriefingId)
    : [];
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
): Promise<void> {
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
  } catch (err) {
    reqLog.error(
      { err, bimModelId: bm.id, engagementId: bm.engagementId, eventType },
      `${eventType} event append failed — row write kept`,
    );
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
  const requestorKind = divergence.resolvedByRequestorKind;
  const requestorId = divergence.resolvedByRequestorId;
  const attributedActor:
    | { kind: "user" | "agent"; id: string }
    | null =
    (requestorKind === "user" || requestorKind === "agent") && requestorId
      ? { kind: requestorKind, id: requestorId }
      : null;
  const actor = attributedActor ?? BIM_MODEL_DIVERGENCE_RESOLVE_ACTOR;
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get(
  "/engagements/:id/bim-model",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res)) return;
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
      if (!bm) {
        res.json({ bimModel: null });
        return;
      }
      res.json({ bimModel: await toBimModelWire(bm) });
    } catch (err) {
      reqLog.error({ err, engagementId }, "get engagement bim-model failed");
      res.status(500).json({ error: "Failed to load bim-model" });
    }
  },
);

router.post(
  "/engagements/:id/bim-model",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res)) return;
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

    res.status(200).json({ bimModel: await toBimModelWire(upserted) });
  },
);

router.get(
  "/bim-models/:id/refresh",
  async (req: Request, res: Response) => {
    if (requireArchitectAudience(req, res)) return;
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
      await emitBimModelEvent(
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
    if (requireArchitectAudience(req, res)) return;
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

      // Batched display-name hydration so each Resolved row's
      // `resolvedByRequestor.displayName` is populated without a
      // per-row round-trip. Best-effort: a failed lookup degrades
      // to the raw id (the helper logs and returns an empty map).
      const displayNameByUserId = await lookupResolverDisplayNames(
        rows,
        reqLog,
      );

      const divergences: BimModelDivergenceListEntryWire[] = rows.map((r) => ({
        ...toDivergenceWire(r.divergence, displayNameByUserId),
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
    if (requireArchitectAudience(req, res)) return;
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
      elementKind: string | null;
      elementLabel: string | null;
      /**
       * True only when this transaction flipped the row from Open
       * to Resolved. The post-transaction timeline emit gates on
       * this flag so an idempotent re-resolve never double-emits.
       */
      freshlyResolved: boolean;
    };
    try {
      resolved = await db.transaction(async (tx) => {
        const bmRows = await tx
          .select({ id: bimModels.id })
          .from(bimModels)
          .where(eq(bimModels.id, bimModelId))
          .limit(1);
        if (bmRows.length === 0) {
          throw new BimModelNotFoundError(bimModelId);
        }

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
    if (resolved.freshlyResolved) {
      await emitDivergenceResolvedEvent(
        getHistoryService(),
        resolved.divergence,
        reqLog,
      );
    }

    // Hydrate the resolver's display name so the splice the FE
    // performs against its cached list (Task #212) carries the
    // friendly attribution rather than a raw id. The lookup is
    // best-effort — a failed hydration degrades to the raw id.
    const displayNameByUserId = await lookupResolverDisplayNames(
      [{ divergence: resolved.divergence }],
      reqLog,
    );

    const wire: BimModelDivergenceListEntryWire = {
      ...toDivergenceWire(resolved.divergence, displayNameByUserId),
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
            briefingId: elem.briefingId,
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
    elementBriefingId: string,
    bimModelBriefingId: string | null,
  ) {
    super(
      `element ${elementId} belongs to briefing ${elementBriefingId} but bim-model ${bimModelId} is active against ${bimModelBriefingId ?? "(none)"}`,
    );
    this.name = "ElementBriefingMismatchError";
    Object.setPrototypeOf(this, ElementBriefingMismatchError.prototype);
  }
}

export default router;
