/**
 * Onboarding ledger events read, OPS-9 S1 follow-on.
 *
 * The CC County Ledger v2 panel (GET /api/county-ledger, countyLedger.ts)
 * shows `rows[].focusedFixCount` per registry row but deliberately did not
 * expose the underlying per-finding list. This route closes that gap
 * additively: a per-rowId, filterable, paginated read over
 * `onboarding_ledger_event`, the same table onboardingLedgerIngest.ts
 * writes.
 *
 * Wire contract:
 *   GET /api/onboarding-ledger/events?rowId=<id>&status=open&limit=100&offset=0
 *   Auth: `requireServiceToken` (Bearer, same idiom as the ingest route in
 *     this directory — no session fallback).
 *   Query params:
 *     - rowId (required): matches `onboarding_ledger_event.row_id` exactly.
 *     - status (optional): "open" | "resolved". Omitted -> no status filter
 *       (both). Any other value 422s.
 *     - limit (optional): default 100, clamped to [1, 500].
 *     - offset (optional): default 0, clamped to >=0.
 *   Response 200:
 *     {
 *       rowId: string,
 *       total: number,        // unfiltered-by-page count matching rowId+status
 *       limit: number,
 *       offset: number,
 *       events: Array<{
 *         id: string,
 *         ts: string,               // ISO, first-observed-occurrence time
 *         fips: string,
 *         rowId: string,
 *         parcelNodeId: string | null,
 *         sourceKind: string,
 *         railOrCheck: string | null,
 *         checkId: string | null,
 *         sweepId: string | null,
 *         declineReason: string | null,
 *         defectClass: string,
 *         severity: string | null,
 *         evidence: unknown,
 *         artifactRef: string | null,
 *         status: string,
 *         firstSeenAt: string,      // ISO
 *         lastSeenAt: string,       // ISO
 *         resolvedAt: string | null,
 *       }>
 *     }
 *   Ordered newest-first: (lastSeenAt DESC, id DESC) — lastSeenAt is the
 *   ingest route's real ingestion-observation clock (bumped on every
 *   idempotent re-ingest) and may collide within a batch, so id is the
 *   tiebreaker, mirroring the (fetchedAt DESC, id DESC) idiom in
 *   `GET /codes/atoms` (codes.ts).
 *
 *   Storage note carried over from the ingest route: `parcelNodeId`,
 *   `railOrCheck`, and `checkId` are stored as the empty-string
 *   NO_VALUE_SENTINEL (never NULL) when absent on ingest, so this route
 *   normalizes empty string back to `null` on the way out — the wire
 *   contract for a "not present" value is `null`, matching every other
 *   nullable field on this response, not the internal storage sentinel.
 *
 * CC panel fetch/render for this route is explicitly OUT of scope for this
 * PR (separate follow-up dispatch); this PR is the API only.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, onboardingLedgerEvent } from "@workspace/db";
import { requireServiceToken } from "../middlewares/serviceAuth";

const router: IRouter = Router();

/** Empty-string storage sentinel used by onboardingLedgerIngest.ts for an absent parcelNodeId/railOrCheck/checkId. Normalized back to `null` on the wire here. */
const NO_VALUE_SENTINEL = "";

function emptyToNull(v: string | null): string | null {
  return v === NO_VALUE_SENTINEL ? null : v;
}

const VALID_STATUSES = new Set(["open", "resolved"]);

/**
 * GET /api/onboarding-ledger/events, the pinned contract (see module doc).
 * Bearer service-token auth (hard 401 on missing/wrong token, no session
 * fallback — same idiom as POST /api/onboarding-ledger/ingest).
 */
router.get("/events", requireServiceToken, async (req: Request, res: Response) => {
  const rowIdRaw = req.query.rowId;
  if (typeof rowIdRaw !== "string" || rowIdRaw.length === 0) {
    res.status(422).json({
      error: "onboarding_ledger_events_invalid_query",
      message: "rowId is required",
    });
    return;
  }
  const rowId = rowIdRaw;

  const statusRaw = req.query.status;
  let status: string | null = null;
  if (statusRaw !== undefined) {
    if (typeof statusRaw !== "string" || !VALID_STATUSES.has(statusRaw)) {
      res.status(422).json({
        error: "onboarding_ledger_events_invalid_query",
        message: "status must be 'open' or 'resolved' when present",
      });
      return;
    }
    status = statusRaw;
  }

  // limit: clamp to [1, 500] with default 100. offset: clamp to >=0 with
  // default 0. Mirrors the Number()-based clamp idiom in GET /codes/atoms
  // (codes.ts), with this route's cap of 500 per the pinned contract.
  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
    : 100;
  const offsetRaw = Number(req.query.offset ?? 0);
  const offset = Number.isFinite(offsetRaw)
    ? Math.max(0, Math.floor(offsetRaw))
    : 0;

  try {
    const conditions = [eq(onboardingLedgerEvent.rowId, rowId)];
    if (status) conditions.push(eq(onboardingLedgerEvent.status, status));
    const whereClause = and(...conditions);

    const [{ n: total }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(onboardingLedgerEvent)
      .where(whereClause);

    const rows = await db
      .select()
      .from(onboardingLedgerEvent)
      .where(whereClause)
      .orderBy(desc(onboardingLedgerEvent.lastSeenAt), desc(onboardingLedgerEvent.id))
      .limit(limit)
      .offset(offset);

    res.json({
      rowId,
      total: Number(total ?? 0),
      limit,
      offset,
      events: rows.map((r) => ({
        id: r.id,
        ts: r.ts.toISOString(),
        fips: r.fips,
        rowId: r.rowId,
        parcelNodeId: emptyToNull(r.parcelNodeId),
        sourceKind: r.sourceKind,
        railOrCheck: emptyToNull(r.railOrCheck),
        checkId: emptyToNull(r.checkId),
        sweepId: r.sweepId ?? null,
        declineReason: r.declineReason ?? null,
        defectClass: r.defectClass,
        severity: r.severity ?? null,
        evidence: r.evidence ?? null,
        artifactRef: r.artifactRef ?? null,
        status: r.status,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    res.status(500).json({
      error: "onboarding_ledger_events_read_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export { router as onboardingLedgerEventsRouter };
