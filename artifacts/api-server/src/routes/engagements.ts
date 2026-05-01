import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements, snapshots, submissions } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import {
  CreateEngagementSubmissionBody,
  GetEngagementParams,
  UpdateEngagementBody,
} from "@workspace/api-zod";
import { geocodeAddress } from "@workspace/site-context/server";
import { logger } from "../lib/logger";
import { getHistoryService } from "../atoms/registry";
import {
  ENGAGEMENT_EDIT_ACTOR,
  SUBMISSION_INGEST_ACTOR,
  emitEngagementAddressUpdatedEvent,
  emitEngagementJurisdictionResolvedEvent,
  emitEngagementSubmittedEvent,
  type EngagementEventActor,
} from "../lib/engagementEvents";

/**
 * Resolve the actor to attribute an engagement-edit lifecycle event to.
 *
 * When the request carries a session-bound user identity (set by
 * `sessionMiddleware` from a verified cookie in production, or the
 * `pr_session` cookie / `x-requestor` header in dev/test), the event is
 * attributed to that user/agent so the engagement timeline shows
 * *which* teammate made the edit. Falls back to the route-level system
 * actor (`ENGAGEMENT_EDIT_ACTOR`) for unauthenticated requests so the
 * audit trail still records *that* an edit happened — matching the
 * pre-session behavior.
 */
function actorFromRequest(req: Request): EngagementEventActor {
  const requestor = req.session?.requestor;
  if (requestor && requestor.id) {
    return { kind: requestor.kind, id: requestor.id };
  }
  return ENGAGEMENT_EDIT_ACTOR;
}

const router: IRouter = Router();

interface SnapshotSummaryRow {
  id: string;
  engagementId: string;
  engagementName: string;
  projectName: string;
  sheetCount: number | null;
  roomCount: number | null;
  levelCount: number | null;
  wallCount: number | null;
  receivedAt: string;
}

function toSnapshotSummary(
  row: typeof snapshots.$inferSelect,
  engagementName: string,
): SnapshotSummaryRow {
  return {
    id: row.id,
    engagementId: row.engagementId,
    engagementName,
    projectName: row.projectName,
    sheetCount: row.sheetCount,
    roomCount: row.roomCount,
    levelCount: row.levelCount,
    wallCount: row.wallCount,
    receivedAt: row.receivedAt.toISOString(),
  };
}

type EngagementRow = typeof engagements.$inferSelect;

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildSite(e: EngagementRow) {
  const lat = toNum(e.latitude);
  const lng = toNum(e.longitude);
  const geocode =
    lat !== null && lng !== null
      ? {
          latitude: lat,
          longitude: lng,
          jurisdictionCity: e.jurisdictionCity,
          jurisdictionState: e.jurisdictionState,
          jurisdictionFips: e.jurisdictionFips,
          source: (e.geocodeSource ?? "manual") as "nominatim" | "manual",
          geocodedAt: (e.geocodedAt ?? e.updatedAt).toISOString(),
        }
      : null;

  const projectType = e.projectType as
    | "new_build"
    | "renovation"
    | "addition"
    | "tenant_improvement"
    | "other"
    | null;

  return {
    address: e.address,
    geocode,
    projectType,
    zoningCode: e.zoningCode,
    lotAreaSqft: toNum(e.lotAreaSqft),
  };
}

function toEngagementSummary(
  e: EngagementRow,
  count: number,
  latest: SnapshotSummaryRow | null,
) {
  return {
    id: e.id,
    name: e.name,
    jurisdiction: e.jurisdiction,
    address: e.address,
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    snapshotCount: count,
    latestSnapshot: latest,
    site: buildSite(e),
  };
}

router.get("/engagements", async (_req: Request, res: Response) => {
  try {
    const allEngagements = await db
      .select()
      .from(engagements)
      .orderBy(desc(engagements.updatedAt));

    const result = await Promise.all(
      allEngagements.map(async (e) => {
        const [{ count }] = await db
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(snapshots)
          .where(eq(snapshots.engagementId, e.id));

        const latestRows = await db
          .select()
          .from(snapshots)
          .where(eq(snapshots.engagementId, e.id))
          .orderBy(desc(snapshots.receivedAt))
          .limit(1);

        const latest = latestRows[0]
          ? toSnapshotSummary(latestRows[0], e.name)
          : null;

        return toEngagementSummary(e, Number(count) || 0, latest);
      }),
    );

    res.json(result);
  } catch (err) {
    logger.error({ err }, "list engagements failed");
    res.status(500).json({ error: "Failed to list engagements" });
  }
});

async function fetchEngagementDetail(id: string) {
  const rows = await db
    .select()
    .from(engagements)
    .where(eq(engagements.id, id))
    .limit(1);
  const e = rows[0];
  if (!e) return null;

  const snapshotRows = await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.engagementId, e.id))
    .orderBy(desc(snapshots.receivedAt));

  const summaries = snapshotRows.map((s) => toSnapshotSummary(s, e.name));
  const latest = summaries[0] ?? null;

  return {
    e,
    detail: {
      ...toEngagementSummary(e, summaries.length, latest),
      snapshots: summaries,
    },
  };
}

router.get("/engagements/:id", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const out = await fetchEngagementDetail(params.data.id);
    if (!out) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }
    res.json(out.detail);
  } catch (err) {
    logger.error({ err, id: params.data.id }, "get engagement failed");
    res.status(500).json({ error: "Failed to fetch engagement" });
  }
});

router.patch("/engagements/:id", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const bodyParse = UpdateEngagementBody.safeParse(req.body ?? {});
  if (!bodyParse.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const body = bodyParse.data;

  try {
    const existingRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, params.data.id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) {
      update["name"] = body.name;
      update["nameLower"] = body.name.trim().toLowerCase();
    }
    if (body.jurisdiction !== undefined) update["jurisdiction"] = body.jurisdiction;
    if (body.status !== undefined) update["status"] = body.status;
    if (body.projectType !== undefined) update["projectType"] = body.projectType;
    if (body.zoningCode !== undefined) update["zoningCode"] = body.zoningCode;
    if (body.lotAreaSqft !== undefined) {
      update["lotAreaSqft"] =
        body.lotAreaSqft === null ? null : String(body.lotAreaSqft);
    }

    const warnings: string[] = [];

    // Track whether the address payload represents a real change (not
    // just a no-op PATCH that sent the same value). The history emit
    // below uses this so a same-value PATCH does not pollute the
    // engagement timeline with redundant `engagement.address-updated`
    // events.
    let addressChanged = false;
    let priorAddress: string | null = null;
    let nextAddress: string | null = null;

    // Track whether the geocode resolved a (potentially new) jurisdiction
    // city/state pair. The helper itself guards against re-emitting on
    // identical pairs, but we only call it when we actually ran a geocode.
    let geocodeProducedJurisdiction = false;
    let resolvedJurisdictionCity: string | null = null;
    let resolvedJurisdictionState: string | null = null;
    let resolvedJurisdictionFips: string | null = null;

    if (body.address !== undefined) {
      update["address"] = body.address;
      const trimmed = body.address.trim();
      const existingTrimmed = (existing.address ?? "").trim();
      if (trimmed !== existingTrimmed) {
        addressChanged = true;
        priorAddress = existingTrimmed.length > 0 ? existingTrimmed : null;
        nextAddress = trimmed.length > 0 ? trimmed : null;
      }
      if (trimmed && trimmed !== existingTrimmed) {
        try {
          const geo = await geocodeAddress(trimmed);
          if (geo) {
            update["latitude"] = String(geo.latitude);
            update["longitude"] = String(geo.longitude);
            update["geocodedAt"] = new Date(geo.geocodedAt);
            update["geocodeSource"] = geo.source;
            update["jurisdictionCity"] = geo.jurisdictionCity;
            update["jurisdictionState"] = geo.jurisdictionState;
            update["jurisdictionFips"] = geo.jurisdictionFips;
            update["siteContextRaw"] = geo.raw ?? null;
            if (geo.jurisdictionCity && geo.jurisdictionState) {
              geocodeProducedJurisdiction = true;
              resolvedJurisdictionCity = geo.jurisdictionCity;
              resolvedJurisdictionState = geo.jurisdictionState;
              resolvedJurisdictionFips = geo.jurisdictionFips;
            }
          } else {
            warnings.push(
              "Geocoding didn't find this address — map view will be unavailable until corrected.",
            );
          }
        } catch (err) {
          logger.warn({ err, address: trimmed }, "geocode failed during PATCH");
          warnings.push(
            "Geocoding service unavailable — saved address without map data.",
          );
        }
      }
    }

    await db
      .update(engagements)
      .set(update)
      .where(eq(engagements.id, existing.id));

    // Best-effort lifecycle events. Per-request logger (carries
    // pino-http's request id when wired) so emit log lines correlate
    // with the originating request; falls back to the singleton when
    // the route is reached outside an HTTP request lifecycle (tests,
    // synthetic calls). Mirrors the pattern in `routes/snapshots.ts`.
    const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
    if (addressChanged) {
      const history = getHistoryService();
      // Attribute the edit to the session-bound user when one is
      // attached (so the timeline shows *which* teammate edited the
      // engagement); falls back to the system actor otherwise.
      const actor = actorFromRequest(req);
      await emitEngagementAddressUpdatedEvent(
        history,
        {
          engagementId: existing.id,
          fromAddress: priorAddress,
          toAddress: nextAddress,
          actor,
        },
        reqLog,
      );
      if (geocodeProducedJurisdiction) {
        await emitEngagementJurisdictionResolvedEvent(
          history,
          {
            engagementId: existing.id,
            jurisdictionCity: resolvedJurisdictionCity,
            jurisdictionState: resolvedJurisdictionState,
            jurisdictionFips: resolvedJurisdictionFips,
            previousJurisdictionCity: existing.jurisdictionCity,
            previousJurisdictionState: existing.jurisdictionState,
            actor,
          },
          reqLog,
        );
      }
    }

    const out = await fetchEngagementDetail(existing.id);
    if (!out) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }
    res.json(warnings.length ? { ...out.detail, warnings } : out.detail);
  } catch (err) {
    logger.error({ err, id: params.data.id }, "patch engagement failed");
    res.status(500).json({ error: "Failed to update engagement" });
  }
});

router.post("/engagements/:id/geocode", async (req: Request, res: Response) => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const existingRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, params.data.id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const address = (existing.address ?? "").trim();
    if (!address) {
      res.status(400).json({
        error: "Engagement has no address to geocode",
      });
      return;
    }

    const warnings: string[] = [];
    let resolvedGeo: Awaited<ReturnType<typeof geocodeAddress>> = null;
    // Only emit the timeline event after the row UPDATE has actually
    // committed. If the geocode succeeds but the row update throws, we
    // would otherwise create audit drift (timeline says "jurisdiction
    // resolved to X" while the row still says the prior jurisdiction).
    let updateSucceeded = false;
    try {
      resolvedGeo = await geocodeAddress(address);
      if (resolvedGeo) {
        await db
          .update(engagements)
          .set({
            latitude: String(resolvedGeo.latitude),
            longitude: String(resolvedGeo.longitude),
            geocodedAt: new Date(resolvedGeo.geocodedAt),
            geocodeSource: resolvedGeo.source,
            jurisdictionCity: resolvedGeo.jurisdictionCity,
            jurisdictionState: resolvedGeo.jurisdictionState,
            jurisdictionFips: resolvedGeo.jurisdictionFips,
            siteContextRaw: resolvedGeo.raw ?? null,
            updatedAt: new Date(),
          })
          .where(eq(engagements.id, existing.id));
        updateSucceeded = true;
      } else {
        warnings.push(
          "Geocoding didn't find this address — map view will be unavailable until corrected.",
        );
      }
    } catch (err) {
      logger.warn({ err, address }, "regeocode failed");
      warnings.push("Geocoding service unavailable — try again in a moment.");
    }

    // Best-effort `engagement.jurisdiction-resolved` event. The helper
    // is a no-op when the geocode produced no city/state pair OR when
    // the resolved pair matches the engagement's prior pair, so manual
    // re-geocodes that don't move the needle don't pollute the
    // engagement timeline. Gated on `updateSucceeded` so a row-update
    // failure doesn't leave a misleading "resolved" event in the audit
    // log pointing at a jurisdiction the row never actually adopted.
    if (resolvedGeo && updateSucceeded) {
      const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
      await emitEngagementJurisdictionResolvedEvent(
        getHistoryService(),
        {
          engagementId: existing.id,
          jurisdictionCity: resolvedGeo.jurisdictionCity,
          jurisdictionState: resolvedGeo.jurisdictionState,
          jurisdictionFips: resolvedGeo.jurisdictionFips,
          previousJurisdictionCity: existing.jurisdictionCity,
          previousJurisdictionState: existing.jurisdictionState,
          actor: actorFromRequest(req),
        },
        reqLog,
      );
    }

    const out = await fetchEngagementDetail(existing.id);
    if (!out) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }
    res.json(warnings.length ? { ...out.detail, warnings } : out.detail);
  } catch (err) {
    logger.error({ err, id: params.data.id }, "regeocode engagement failed");
    res.status(500).json({ error: "Failed to re-geocode engagement" });
  }
});

/**
 * POST /engagements/:id/submissions — record that a plan-review package
 * has been submitted to the jurisdiction.
 *
 * Persistence (Task #63): the handler inserts a row into the
 * `submissions` table — capturing the engagement's jurisdiction labels
 * at the moment of submission so the row is self-contained for future
 * timeline / audit rendering — and uses the inserted row's id as the
 * `submissionId` field on the `engagement.submitted` event payload.
 * The event-payload shape is unchanged from the pre-table version
 * (`submissionId` is still a uuid string, just now backed by a real row
 * rather than a one-off `randomUUID()`) so existing event consumers
 * keep working.
 *
 * Best-effort emit by the same contract as the sibling lifecycle routes:
 * a transient history outage cannot fail the submission HTTP request —
 * the response 201s either way once the row is inserted, the event-
 * append failure is logged, and the audit chain self-heals on the next
 * successful append. Event being best-effort while the row is the
 * source of truth follows locked decision #5 (rows over events).
 *
 * Body shape and the 2 KB note cap live in the OpenAPI contract
 * (`CreateEngagementSubmissionBody`); the generated zod schema rejects
 * over-cap notes with a 400 here so callers see a contract-level error
 * instead of a silently-truncated payload. The parsed `note` is then
 * trimmed and stored alongside the submission row so both the row and
 * the event payload carry the same canonical value.
 */
/**
 * GET /engagements/:id/submissions — list prior plan-review
 * submissions for an engagement, newest-first.
 *
 * Reads straight from the `submissions` table (indexed by
 * `engagement_id`, see `lib/db/src/schema/submissions.ts`). The
 * returned shape matches the `EngagementSubmissionSummary` OpenAPI
 * schema and intentionally omits the captured city/state/FIPS columns
 * — the denormalized `jurisdiction` label is what consumers render in
 * the past-submissions list today; the structured columns are still
 * available via the per-submission atom (`submission.atom.ts`) when
 * a future surface needs them.
 *
 * Returns 404 when the parent engagement does not exist (rather than
 * an empty array) so the front-end can distinguish "no submissions
 * yet" from "stale engagement id"; this mirrors the contract of
 * `GET /engagements/:id`.
 */
router.get(
  "/engagements/:id/submissions",
  async (req: Request, res: Response) => {
    const params = GetEngagementParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    try {
      const existingRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, params.data.id))
        .limit(1);
      if (!existingRows[0]) {
        res.status(404).json({ error: "Engagement not found" });
        return;
      }

      const rows = await db
        .select({
          id: submissions.id,
          submittedAt: submissions.submittedAt,
          jurisdiction: submissions.jurisdiction,
          note: submissions.note,
        })
        .from(submissions)
        .where(eq(submissions.engagementId, params.data.id))
        .orderBy(desc(submissions.submittedAt));

      res.json(
        rows.map((r) => ({
          id: r.id,
          submittedAt: r.submittedAt.toISOString(),
          jurisdiction: r.jurisdiction,
          note: r.note,
        })),
      );
    } catch (err) {
      logger.error(
        { err, id: params.data.id },
        "list submissions failed",
      );
      res.status(500).json({ error: "Failed to list submissions" });
    }
  },
);

router.post(
  "/engagements/:id/submissions",
  async (req: Request, res: Response) => {
    const params = GetEngagementParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const bodyParse = CreateEngagementSubmissionBody.safeParse(req.body ?? {});
    if (!bodyParse.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    try {
      const existingRows = await db
        .select()
        .from(engagements)
        .where(eq(engagements.id, params.data.id))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        res.status(404).json({ error: "Engagement not found" });
        return;
      }

      const rawNote = bodyParse.data.note;
      const note =
        typeof rawNote === "string" && rawNote.trim().length > 0
          ? rawNote.trim()
          : null;

      // Persist the submission row first. The row id (and its
      // `submittedAt` default) become the canonical fields surfaced on
      // both the HTTP response and the event payload — so the row, the
      // response, and the event all agree on the submission identity.
      const [inserted] = await db
        .insert(submissions)
        .values({
          engagementId: existing.id,
          jurisdiction: existing.jurisdiction,
          jurisdictionCity: existing.jurisdictionCity,
          jurisdictionState: existing.jurisdictionState,
          jurisdictionFips: existing.jurisdictionFips,
          note,
        })
        .returning();
      if (!inserted) {
        // .returning() should always yield a row when the insert
        // succeeded; bail loudly if the driver violates that.
        throw new Error("submission insert returned no row");
      }

      const reqLog = (req as unknown as { log?: typeof logger }).log ?? logger;
      await emitEngagementSubmittedEvent(
        getHistoryService(),
        {
          engagementId: existing.id,
          submissionId: inserted.id,
          jurisdiction: existing.jurisdiction,
          jurisdictionCity: existing.jurisdictionCity,
          jurisdictionState: existing.jurisdictionState,
          note,
          actor: SUBMISSION_INGEST_ACTOR,
        },
        reqLog,
      );

      res.status(201).json({
        submissionId: inserted.id,
        engagementId: existing.id,
        submittedAt: inserted.submittedAt.toISOString(),
      });
    } catch (err) {
      logger.error(
        { err, id: params.data.id },
        "create submission failed",
      );
      res.status(500).json({ error: "Failed to record submission" });
    }
  },
);

export default router;
