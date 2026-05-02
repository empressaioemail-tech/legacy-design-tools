/**
 * /api/engagements/:id/generate-layers — DA-PI-4 unified adapter run.
 *
 * One endpoint that:
 *   1. Resolves the engagement's jurisdiction (state + local key) from
 *      the existing site-context columns (`jurisdiction_city`,
 *      `jurisdiction_state`, the freeform `jurisdiction`, and the
 *      address line as a last-resort scan).
 *   2. Filters {@link ALL_ADAPTERS} down to the ones whose
 *      `appliesTo(ctx)` returns true.
 *   3. Runs them in parallel through the `@workspace/adapters` runner
 *      with per-adapter failure isolation + a 15s soft timeout.
 *   4. Persists every successful result as a `briefing_sources` row,
 *      reusing the same supersession contract the manual-upload route
 *      uses (Spec 51 §4 / parcelBriefings.ts):
 *         - `layer_kind` is the per-layer key the partial unique index
 *           gates on.
 *         - The prior current row's `superseded_at` is stamped, then
 *           the new row is inserted, then the prior row's
 *           `superseded_by_id` is backfilled with the new id.
 *         - Per locked decision #4 ("re-runs always supersede"), a
 *           re-run always writes a new row even if the upstream
 *           payload is byte-identical.
 *   5. Returns a single envelope carrying the post-run briefing (with
 *      `sources` re-projected from the canonical "current" view) +
 *      a per-adapter outcomes array so the UI can render OK / failed
 *      / no-coverage state alongside the data.
 *
 * Best-effort `briefing-source.fetched` event emission per persisted
 * row, mirroring the contract used by parcelBriefings.ts: a transient
 * history outage cannot fail the HTTP request — the row is the source
 * of truth, the event chain is observability.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  engagements,
  parcelBriefings,
  briefingSources,
  type ParcelBriefing,
  type BriefingSource,
} from "@workspace/db";
import {
  ALL_ADAPTERS,
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
  resolveJurisdiction,
  runAdapters,
  type AdapterContext,
  type AdapterRunOutcome,
} from "@workspace/adapters";
import { GenerateEngagementLayersParams } from "@workspace/api-zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { EventAnchoringService } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { createAdapterResponseCache } from "../lib/adapterCache";
import { resolveMatchingReviewerRequests } from "../lib/reviewerRequestResolution";
import { getHistoryService } from "../atoms/registry";
import {
  BRIEFING_SOURCE_EVENT_TYPES,
  type BriefingSourceEventType,
} from "../atoms/briefing-source.atom";

/**
 * Pinned to the briefing-source atom's event-type union so a rename
 * in the atom registration breaks compilation here rather than
 * silently emitting a stale event name.
 */
const BRIEFING_SOURCE_FETCHED_EVENT_TYPE: BriefingSourceEventType =
  BRIEFING_SOURCE_EVENT_TYPES[0];
const BRIEFING_SOURCE_REFRESHED_EVENT_TYPE: BriefingSourceEventType =
  BRIEFING_SOURCE_EVENT_TYPES[1];

/** Distinct system actor for adapter-driven inserts. */
const BRIEFING_ADAPTER_ACTOR = {
  kind: "system" as const,
  id: "briefing-generate-layers",
};

/**
 * Wire shape mirrors `BriefingSourceWire` in parcelBriefings.ts. Kept
 * as a sibling rather than imported so a cosmetic refactor of one
 * route's projection cannot accidentally break the other.
 */
interface BriefingSourceWire {
  id: string;
  layerKind: string;
  sourceKind:
    | "manual-upload"
    | "federal-adapter"
    | "state-adapter"
    | "local-adapter";
  provider: string | null;
  snapshotDate: string;
  note: string | null;
  /**
   * Structured producer payload — for an adapter row this is the
   * adapter's `AdapterResult.payload` (preserved verbatim so the
   * Site Context "view layer details" expander can switch on
   * `payload.kind`); for a manual upload the column defaults to
   * `{}`. Treated as opaque on the wire — see openapi.yaml's
   * EngagementBriefingSource schema for the contract.
   */
  payload: Record<string, unknown>;
  uploadObjectPath: string | null;
  uploadOriginalFilename: string | null;
  uploadContentType: string | null;
  uploadByteSize: number | null;
  dxfObjectPath: string | null;
  glbObjectPath: string | null;
  conversionStatus:
    | "pending"
    | "converting"
    | "ready"
    | "failed"
    | "dxf-only"
    | null;
  conversionError: string | null;
  supersededAt: string | null;
  supersededById: string | null;
  createdAt: string;
}

interface BriefingWire {
  id: string;
  engagementId: string;
  createdAt: string;
  updatedAt: string;
  sources: BriefingSourceWire[];
}

function toBriefingSourceWire(s: BriefingSource): BriefingSourceWire {
  return {
    id: s.id,
    layerKind: s.layerKind,
    // Cast to the closed wire enum: the column is `text` so the
    // database technically allows any value, but the writers in this
    // codebase are this route + parcelBriefings.ts which all stamp
    // one of the four enum values. Anything else would be a schema-
    // violation we want to surface as a TS error here rather than
    // silently round-trip.
    sourceKind: s.sourceKind as BriefingSourceWire["sourceKind"],
    provider: s.provider,
    snapshotDate: s.snapshotDate.toISOString(),
    note: s.note,
    // Cast: the column is `jsonb` typed as `unknown` by drizzle but
    // the writers in this codebase always insert a `Record<string,
    // unknown>` (the adapter `AdapterResult.payload` shape, or an
    // empty object). Anything else would be a producer bug we want
    // surfaced as a `Object.keys` crash on render rather than a
    // silent string-leak through the wire.
    payload: (s.payload ?? {}) as Record<string, unknown>,
    uploadObjectPath: s.uploadObjectPath,
    uploadOriginalFilename: s.uploadOriginalFilename,
    uploadContentType: s.uploadContentType,
    uploadByteSize: s.uploadByteSize,
    dxfObjectPath: s.dxfObjectPath,
    glbObjectPath: s.glbObjectPath,
    conversionStatus: s.conversionStatus as BriefingSourceWire["conversionStatus"],
    conversionError: s.conversionError,
    supersededAt: s.supersededAt ? s.supersededAt.toISOString() : null,
    supersededById: s.supersededById,
    createdAt: s.createdAt.toISOString(),
  };
}

function toBriefingWire(
  briefing: ParcelBriefing,
  sources: BriefingSource[],
): BriefingWire {
  return {
    id: briefing.id,
    engagementId: briefing.engagementId,
    createdAt: briefing.createdAt.toISOString(),
    updatedAt: briefing.updatedAt.toISOString(),
    sources: sources.map(toBriefingSourceWire),
  };
}

async function loadCurrentSources(
  briefingId: string,
): Promise<BriefingSource[]> {
  return db
    .select()
    .from(briefingSources)
    .where(
      and(
        eq(briefingSources.briefingId, briefingId),
        isNull(briefingSources.supersededAt),
      ),
    )
    .orderBy(desc(briefingSources.createdAt));
}

/**
 * Mirror of parcelBriefings.ts's helper, with the source-actor swapped
 * for the adapter-driven actor so audit-trail readers can tell apart
 * a manual upload from an automatic adapter fetch.
 */
async function emitBriefingSourceFetchedEvent(
  history: EventAnchoringService,
  source: BriefingSource,
  engagementId: string,
  supersededSourceId: string | null,
  adapterKey: string,
  reqLog: typeof logger,
): Promise<void> {
  try {
    const event = await history.appendEvent({
      entityType: "briefing-source",
      entityId: source.id,
      eventType: BRIEFING_SOURCE_FETCHED_EVENT_TYPE,
      actor: BRIEFING_ADAPTER_ACTOR,
      payload: {
        briefingId: source.briefingId,
        engagementId,
        layerKind: source.layerKind,
        sourceKind: source.sourceKind,
        adapterKey,
        supersededSourceId,
      },
    });
    reqLog.info(
      {
        briefingSourceId: source.id,
        briefingId: source.briefingId,
        engagementId,
        layerKind: source.layerKind,
        adapterKey,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "briefing-source.fetched event appended (adapter-driven)",
    );
  } catch (err) {
    reqLog.error(
      {
        err,
        briefingSourceId: source.id,
        briefingId: source.briefingId,
        engagementId,
        layerKind: source.layerKind,
        adapterKey,
      },
      "briefing-source.fetched event append failed — row insert kept",
    );
  }
}

/**
 * V1-2 — emit a `briefing-source.refreshed` event against the
 * SUPERSEDED row whenever a forceRefresh run replaces an existing
 * briefing-source. Pairs with the `briefing-source.fetched` emit on
 * the new row: `.fetched` opens the new row's lifecycle, `.refreshed`
 * closes the old row's lifecycle.
 *
 * Anchoring on the superseded row's id (not the new row's) is what
 * lets the reviewer-request implicit-resolve helper key off the
 * UUID the reviewer originally filed against — the reviewer sees the
 * pre-refresh row in the UI, files a request bound to that row's id,
 * and the architect's force-refresh closes it via this emit's
 * matching target tuple.
 *
 * Decision Phase 1A ask (a-ii): the atom already declared
 * `briefing-source.refreshed` in `BRIEFING_SOURCE_EVENT_TYPES` but
 * no producer was wired. V1-2 wires the producer here, and the
 * implicit-resolve hook below keys off it. Returns the event id (or
 * `null` on failure) so the caller can pass it to
 * `resolveMatchingReviewerRequests`.
 */
async function emitBriefingSourceRefreshedEvent(
  history: EventAnchoringService,
  supersededSourceId: string,
  newSource: BriefingSource,
  engagementId: string,
  adapterKey: string,
  reqLog: typeof logger,
): Promise<string | null> {
  try {
    const event = await history.appendEvent({
      entityType: "briefing-source",
      // Anchor .refreshed on the SUPERSEDED row's id, not the new row.
      // Reviewer-requests carry target_entity_id = pre-refresh UUID,
      // and the implicit-resolve helper matches on target_entity_id.
      // Anchoring on the new id would orphan all pending requests.
      entityId: supersededSourceId,
      eventType: BRIEFING_SOURCE_REFRESHED_EVENT_TYPE,
      actor: BRIEFING_ADAPTER_ACTOR,
      payload: {
        briefingId: newSource.briefingId,
        engagementId,
        layerKind: newSource.layerKind,
        sourceKind: newSource.sourceKind,
        adapterKey,
        replacedByBriefingSourceId: newSource.id,
      },
    });
    reqLog.info(
      {
        supersededBriefingSourceId: supersededSourceId,
        replacedByBriefingSourceId: newSource.id,
        briefingId: newSource.briefingId,
        engagementId,
        layerKind: newSource.layerKind,
        adapterKey,
        eventId: event.id,
        chainHash: event.chainHash,
      },
      "briefing-source.refreshed event appended (forceRefresh path)",
    );
    return event.id;
  } catch (err) {
    reqLog.error(
      {
        err,
        supersededBriefingSourceId: supersededSourceId,
        replacedByBriefingSourceId: newSource.id,
        briefingId: newSource.briefingId,
        engagementId,
        layerKind: newSource.layerKind,
        adapterKey,
      },
      "briefing-source.refreshed event append failed — row insert kept",
    );
    return null;
  }
}

/**
 * Wire shape for one entry in the response `outcomes` array — pinned
 * to the OpenAPI `GenerateLayersOutcome` schema. Kept as a structural
 * type rather than importing the generated type so a generated-code
 * regeneration cycle that hasn't run yet can't break this file's
 * typecheck.
 */
interface GenerateLayersOutcomeWire {
  adapterKey: string;
  tier: "federal" | "state" | "local";
  sourceKind: "manual-upload" | "federal-adapter" | "state-adapter" | "local-adapter";
  layerKind: string;
  status: "ok" | "no-coverage" | "failed";
  error: { code: string; message: string } | null;
  sourceId: string | null;
  /**
   * Task #204: true when the runner replayed a cached AdapterResult
   * instead of re-fetching live from the upstream feed. The Site
   * Context tab uses this (with {@link cachedAt}) to render a
   * "cached <n>h ago" pill on per-source rows so an architect knows
   * when to consider a "Force refresh".
   */
  fromCache: boolean;
  /**
   * Task #204: ISO8601 timestamp of when the cached row was written
   * (i.e. when the underlying upstream lookup actually ran). Always
   * `null` when {@link fromCache} is false.
   */
  cachedAt: string | null;
  /**
   * Task #227: verdict from the adapter's optional
   * `getUpstreamFreshness()` hook. `null` for live runs, for non-`ok`
   * outcomes, and for cache hits whose adapter doesn't implement the
   * hook. The Site Context tab branches on `status === "stale"` to
   * render a warning pill instead of the existing "cached <n>h ago"
   * variant.
   */
  upstreamFreshness: {
    status: "fresh" | "stale" | "unknown";
    reason: string | null;
  } | null;
}

const router: IRouter = Router();

router.post(
  "/engagements/:id/generate-layers",
  async (req: Request, res: Response) => {
    const paramsParse = GenerateEngagementLayersParams.safeParse(req.params);
    if (!paramsParse.success) {
      res.status(400).json({ error: "invalid_engagement_id" });
      return;
    }
    const engagementId = paramsParse.data.id;
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;

    let engRow:
      | {
          id: string;
          jurisdiction: string | null;
          jurisdictionCity: string | null;
          jurisdictionState: string | null;
          address: string | null;
          latitude: string | null;
          longitude: string | null;
        }
      | undefined;
    try {
      const rows = await db
        .select({
          id: engagements.id,
          jurisdiction: engagements.jurisdiction,
          jurisdictionCity: engagements.jurisdictionCity,
          jurisdictionState: engagements.jurisdictionState,
          address: engagements.address,
          latitude: engagements.latitude,
          longitude: engagements.longitude,
        })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      engRow = rows[0];
    } catch (err) {
      reqLog.error({ err, engagementId }, "generate-layers: load engagement failed");
      res.status(500).json({ error: "Failed to load engagement" });
      return;
    }
    if (!engRow) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    // Resolve the jurisdiction from whatever site-context fields the
    // engagement happens to have populated. The resolver is permissive
    // — it accepts city + state, the freeform jurisdiction string, or
    // an address scan. A miss returns `{ stateKey: null, localKey: null }`,
    // in which case `appliesTo` will reject every adapter and we 422.
    const jurisdiction = resolveJurisdiction({
      jurisdictionCity: engRow.jurisdictionCity,
      jurisdictionState: engRow.jurisdictionState,
      jurisdiction: engRow.jurisdiction,
      address: engRow.address,
    });

    // Adapters that do their work over a lat/lng (every spatial query
    // adapter in this sprint) cannot run without coordinates. We do
    // not 422 here: a non-spatial adapter could still apply (none in
    // P0, but the contract should accommodate them). The runner
    // surfaces the per-adapter no-coverage outcome on its own.
    const lat = engRow.latitude ? Number(engRow.latitude) : NaN;
    const lng = engRow.longitude ? Number(engRow.longitude) : NaN;
    const haveCoords = Number.isFinite(lat) && Number.isFinite(lng);

    const ctx: AdapterContext = {
      parcel: haveCoords
        ? { latitude: lat, longitude: lng }
        : // Pass NaN through deliberately — adapters that need coords
          // call `appliesTo` first and return no-coverage, so the
          // runner's outcome is still deterministic. We log the gap
          // so an operator can correlate "all adapters reported no-
          // coverage" with "engagement was missing a geocode".
          { latitude: NaN, longitude: NaN },
      jurisdiction,
      timeoutMs: 15_000,
    };

    if (!haveCoords) {
      reqLog.warn(
        { engagementId },
        "generate-layers: engagement has no geocode — every adapter will report no-coverage",
      );
    }

    // Apply the jurisdiction gate eagerly so an out-of-pilot
    // engagement can be 422'd without spinning up a no-op runner.
    // The filter + message helpers live in `@workspace/adapters`'s
    // `eligibility` module — the Site Context tab calls into the
    // exact same helpers to disable the Generate Layers button +
    // show the empty-pilot banner proactively, so the FE pre-flight
    // gate cannot disagree with this 422 (Task #189). `ALL_ADAPTERS`
    // is passed explicitly (rather than relying on the helper's
    // default) so the route's own test suite, which `vi.mock`'s the
    // package barrel's `ALL_ADAPTERS` export to swap in fake
    // adapters, still sees its mock honored — the helper imports
    // from `./registry` directly to avoid an internal circular
    // import, which would bypass that mock if we let it default.
    const applicable = filterApplicableAdapters(ctx, ALL_ADAPTERS);
    if (applicable.length === 0) {
      res.status(422).json({
        error: "no_applicable_adapters",
        message: noApplicableAdaptersMessage(jurisdiction),
      });
      return;
    }

    // Task #228 — `?adapterKey=<key>` narrows the run to a single
    // adapter (still subject to the jurisdiction gate above). The
    // architect uses this from the per-row "Refresh this layer"
    // affordance to re-fetch one upstream feed (e.g. just FEMA flood
    // zone) without paying every other adapter's per-run timeout
    // budget. We validate against `applicable` rather than
    // `ALL_ADAPTERS` so an off-jurisdiction key (e.g. a Utah-only
    // adapter on a Texas engagement) cannot silently no-op the run.
    const adapterKeyScope = parseAdapterKeyQuery(req.query["adapterKey"]);
    let scopedApplicable = applicable;
    if (adapterKeyScope !== null) {
      scopedApplicable = applicable.filter(
        (a) => a.adapterKey === adapterKeyScope,
      );
      if (scopedApplicable.length === 0) {
        res.status(422).json({
          error: "unknown_adapter_key",
          message: `No applicable adapter matches adapterKey "${adapterKeyScope}" for this engagement's jurisdiction.`,
        });
        return;
      }
      reqLog.info(
        { engagementId, adapterKey: adapterKeyScope },
        "generate-layers: adapterKey scope — running a single adapter",
      );
    }

    // Federal lookups (FEMA NFHL, USGS EPQS, EPA EJScreen, FCC
    // broadband) are slow / rate-limited. Wire a Postgres-backed
    // result cache through the runner so a re-run against the same
    // parcel within the TTL replays the cached envelope instead of
    // re-hitting the upstream feed. The cache predicate defaults to
    // "federal tier only" inside the runner — see Task #180. A `0`
    // TTL (`ADAPTER_CACHE_TTL_MS=0`) returns `undefined` here so the
    // runner skips the cache entirely.
    const cache = createAdapterResponseCache({ log: reqLog });

    // Task #204 — `?forceRefresh=true` punches through the cache so
    // the architect can confirm the upstream hasn't moved (e.g. after
    // FEMA publishes a new flood-zone snapshot). The flag only skips
    // the cache `get`; successful runs are still written back through
    // so the next non-forced run hits the freshly-warmed entry. Any
    // other value (including absent) means "honor the cache".
    const forceRefresh = parseForceRefreshQuery(req.query["forceRefresh"]);
    if (forceRefresh) {
      reqLog.info(
        { engagementId },
        "generate-layers: forceRefresh=true — bypassing adapter cache for this run",
      );
    }

    let outcomes: AdapterRunOutcome[];
    try {
      outcomes = await runAdapters({
        adapters: scopedApplicable,
        context: ctx,
        cache,
        forceRefresh,
      });
    } catch (err) {
      // The runner contract is "never throws" — a thrown error here
      // is a programming bug rather than a runtime upstream failure.
      reqLog.error({ err, engagementId }, "generate-layers: runner threw unexpectedly");
      res.status(500).json({ error: "Failed to run adapters" });
      return;
    }

    // Persist every OK outcome inside one transaction so a partial
    // commit cannot leave the briefing in a half-updated state. We
    // collect (outcome, persisted source row) pairs so the post-
    // commit event emission has the row id for each.
    interface PersistedRow {
      outcome: AdapterRunOutcome;
      newSource: BriefingSource;
      supersededSourceId: string | null;
    }
    let persisted: PersistedRow[] = [];
    let briefingRow: ParcelBriefing | null = null;
    try {
      ({ briefingRow, persisted } = await db.transaction(async (tx) => {
        // First-fetch-creates-briefing: same upsert pattern the
        // manual-upload route uses (engagement_id is unique on
        // parcel_briefings).
        const [briefing] = await tx
          .insert(parcelBriefings)
          .values({ engagementId })
          .onConflictDoUpdate({
            target: parcelBriefings.engagementId,
            set: { updatedAt: new Date() },
          })
          .returning();

        const persistedLocal: PersistedRow[] = [];
        const supersededAt = new Date();
        for (const outcome of outcomes) {
          if (outcome.status !== "ok" || !outcome.result) continue;
          const result = outcome.result;
          // Per-layer supersession: stamp the prior current row,
          // insert the new one, then backfill superseded_by_id —
          // matching the strict order parcelBriefings.ts uses.
          const priorRows = await tx
            .select({ id: briefingSources.id })
            .from(briefingSources)
            .where(
              and(
                eq(briefingSources.briefingId, briefing.id),
                eq(briefingSources.layerKind, result.layerKind),
                isNull(briefingSources.supersededAt),
              ),
            )
            .limit(1);
          const priorId = priorRows[0]?.id ?? null;
          if (priorId) {
            await tx
              .update(briefingSources)
              .set({ supersededAt })
              .where(eq(briefingSources.id, priorId));
          }
          const [newSource] = await tx
            .insert(briefingSources)
            .values({
              briefingId: briefing.id,
              layerKind: result.layerKind,
              // The wire enum was extended in DA-PI-4 to admit
              // `state-adapter` / `local-adapter` — the adapter
              // contract's `sourceKind` carries the chosen value.
              sourceKind: result.sourceKind,
              // Pack `<jurisdiction-key>:<source-name>` (the adapter
              // key) into `provider` so the UI can render it as a
              // stable identifier without a schema migration. The
              // human-readable provider name is folded into the
              // adapter result's `provider` field too — we prefer
              // adapterKey because it round-trips to the adapter
              // module unambiguously.
              provider: `${result.adapterKey} (${result.provider})`,
              snapshotDate: new Date(result.snapshotDate),
              note: result.note ?? null,
              // Persist the adapter's structured payload verbatim so
              // the Site Context "view layer details" expander can
              // read it back through the briefing wire shape. Without
              // this assignment the column would default to `{}` and
              // the FE would render an empty details panel even
              // though the adapter actually returned data.
              payload: result.payload,
              // Adapter rows do not carry an upload — every upload
              // field stays null so the wire shape's discriminated
              // union reads cleanly.
              uploadObjectPath: null,
              uploadOriginalFilename: null,
              uploadContentType: null,
              uploadByteSize: null,
              dxfObjectPath: null,
              glbObjectPath: null,
              conversionStatus: null,
              conversionError: null,
            })
            .returning();
          if (priorId) {
            await tx
              .update(briefingSources)
              .set({ supersededById: newSource.id })
              .where(eq(briefingSources.id, priorId));
          }
          persistedLocal.push({
            outcome,
            newSource,
            supersededSourceId: priorId,
          });
        }
        return { briefingRow: briefing, persisted: persistedLocal };
      }));
    } catch (err) {
      reqLog.error(
        { err, engagementId },
        "generate-layers: persist transaction failed",
      );
      res.status(500).json({ error: "Failed to persist adapter results" });
      return;
    }

    // Best-effort event emission per persisted row, awaited but never
    // throws (see emitBriefingSourceFetchedEvent above).
    const history = getHistoryService();
    for (const row of persisted) {
      await emitBriefingSourceFetchedEvent(
        history,
        row.newSource,
        engagementId,
        row.supersededSourceId,
        row.outcome.adapterKey,
        reqLog,
      );
      // V1-2 — when a forceRefresh run replaces an existing row,
      // also emit `briefing-source.refreshed` against the SUPERSEDED
      // row (the one the reviewer was looking at) and run the
      // implicit-resolve hook so any pending reviewer-request keyed
      // on that old row's id closes onto this action.
      //
      // Skip first-pulls (no supersededSourceId) — there is nothing
      // to refresh and a reviewer cannot have a pending request
      // bound to a row that didn't exist yet.
      if (row.supersededSourceId) {
        const refreshedEventId = await emitBriefingSourceRefreshedEvent(
          history,
          row.supersededSourceId,
          row.newSource,
          engagementId,
          row.outcome.adapterKey,
          reqLog,
        );
        if (refreshedEventId) {
          await resolveMatchingReviewerRequests({
            targetEntityType: "briefing-source",
            targetEntityId: row.supersededSourceId,
            triggeredActionEventId: refreshedEventId,
            log: reqLog,
          });
        }
      }
    }

    const persistedByAdapterKey = new Map<string, string>(
      persisted.map((p) => [p.outcome.adapterKey, p.newSource.id]),
    );
    const outcomesWire: GenerateLayersOutcomeWire[] = outcomes.map((o) => ({
      adapterKey: o.adapterKey,
      tier: o.tier,
      // Either the runner's hint, or fall back to the adapter's tier-
      // derived sourceKind for no-coverage outcomes.
      sourceKind:
        (o.result?.sourceKind as GenerateLayersOutcomeWire["sourceKind"]) ??
        (o.tier === "state"
          ? "state-adapter"
          : o.tier === "local"
            ? "local-adapter"
            : "federal-adapter"),
      layerKind: o.layerKind,
      status: o.status,
      error: o.error
        ? { code: o.error.code, message: o.error.message }
        : null,
      sourceId: persistedByAdapterKey.get(o.adapterKey) ?? null,
      // Task #204: surface the cache hint on the wire. The runner
      // populates `fromCache`/`cachedAt` on every "ok" outcome; we
      // collapse to the strict `false` / `null` defaults for non-`ok`
      // outcomes so the FE never has to handle `undefined`.
      fromCache: o.fromCache === true,
      cachedAt: o.fromCache === true ? o.cachedAt ?? null : null,
      // Task #227: only attach the freshness verdict for cache hits
      // — for live runs and non-ok outcomes the runner returns null
      // and we forward that. Normalize the optional `reason` field
      // to `null` so the wire shape is always strict.
      upstreamFreshness:
        o.fromCache === true && o.upstreamFreshness
          ? {
              status: o.upstreamFreshness.status,
              reason: o.upstreamFreshness.reason ?? null,
            }
          : null,
    }));

    if (!briefingRow) {
      // Defensive: the transaction above always returns a briefing,
      // but TS doesn't know that. Surface a 500 rather than a
      // misleading null briefing on the wire.
      res.status(500).json({ error: "Failed to project briefing" });
      return;
    }
    const sources = await loadCurrentSources(briefingRow.id);
    res.json({
      briefing: toBriefingWire(briefingRow, sources),
      outcomes: outcomesWire,
    });
  },
);

/**
 * Parse the `?forceRefresh` query param into a strict boolean. Accepts
 * the strings `"true"` / `"1"` (case-insensitive) as truthy; everything
 * else (missing, `"false"`, `"0"`, repeated values, garbage) is false.
 * Express decodes repeated `?forceRefresh=true&forceRefresh=...` query
 * params into an array — we only honor the flag when the canonical
 * single-value form was supplied.
 */
function parseForceRefreshQuery(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Task #228 — parse `?adapterKey=<key>` into a trimmed string or
 * `null` ("no scope, run every applicable adapter"). Express
 * decodes repeated `?adapterKey=a&adapterKey=b` into an array; we
 * only honor the canonical single-string form so an architect
 * cannot accidentally smuggle a multi-adapter scope through the
 * single-layer affordance. An empty / whitespace-only value is
 * also treated as `null` so a `?adapterKey=` typo behaves like the
 * flag is absent rather than 422-ing on an "" lookup.
 */
function parseAdapterKeyQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

export default router;
