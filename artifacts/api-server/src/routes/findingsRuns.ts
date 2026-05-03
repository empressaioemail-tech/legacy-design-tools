/**
 * Compliance Engine console (Task #493) — cross-submission finding-engine
 * read-only routes.
 *
 * Reviewer-only — all routes require `session.audience === "internal"`,
 * mirroring the per-submission `findings/runs` precedent in
 * `routes/findings.ts`.
 *
 * Surfaces:
 *   - GET /findings/runs              — recent runs across every submission
 *   - GET /findings/runs/export.csv   — CSV export of the same feed (Task #501)
 *   - GET /findings/runs/summary      — trailing 30-day KPI rollup
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  engagements,
  findingRuns,
  submissions,
} from "@workspace/db";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireReviewerAudience(req: Request, res: Response): boolean {
  if (req.session.audience === "internal") return false;
  res.status(403).json({ error: "findings_require_internal_audience" });
  return true;
}

/**
 * Per-submission cap shared with the existing per-submission
 * `/findings/runs` endpoint and the sweep. Inlined (not imported from
 * `findings.ts`) to keep the cross-submission console route file
 * self-contained — the env var is the source of truth.
 */
const DEFAULT_KEEP_PER_SUBMISSION = 5;
function resolveKeepPerSubmission(): number {
  const raw = process.env.FINDING_RUNS_KEEP_PER_SUBMISSION;
  if (!raw) return DEFAULT_KEEP_PER_SUBMISSION;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KEEP_PER_SUBMISSION;
  return n;
}

/** Hard global ceiling for the console feed so a noisy install does not
 * blow out the response payload. Default 200 keeps the wire well under
 * a typical proxy buffer; override via env when investigating. */
const DEFAULT_CONSOLE_LIMIT = 200;
function resolveConsoleLimit(): number {
  const raw = process.env.FINDING_RUNS_CONSOLE_LIMIT;
  if (!raw) return DEFAULT_CONSOLE_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONSOLE_LIMIT;
  return n;
}

const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Public wire state ↔ on-disk `finding_runs.state`. */
const PUBLIC_STATES = ["pending", "succeeded", "failed"] as const;
type PublicState = (typeof PUBLIC_STATES)[number];

function toPublicState(dbState: string): PublicState {
  if (dbState === "completed") return "succeeded";
  if (dbState === "failed") return "failed";
  return "pending";
}

function toDbState(pub: PublicState): string {
  return pub === "succeeded" ? "completed" : pub;
}

function isPublicState(v: unknown): v is PublicState {
  return (
    typeof v === "string" && (PUBLIC_STATES as readonly string[]).includes(v)
  );
}

// ─── shared filter parsing ─────────────────────────────────────────

interface ParsedFilters {
  stateFilter: PublicState | null;
  since: Date;
}

type FilterParseResult =
  | { ok: true; filters: ParsedFilters }
  | { ok: false; status: number; body: { error: string; detail: string } };

function parseRunFilters(req: Request): FilterParseResult {
  const rawState = req.query.state;
  let stateFilter: PublicState | null = null;
  if (rawState != null && rawState !== "") {
    if (!isPublicState(rawState)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_state_filter",
          detail: `state must be one of: ${PUBLIC_STATES.join(", ")}`,
        },
      };
    }
    stateFilter = rawState;
  }

  const rawSince = req.query.since;
  let since: Date;
  if (typeof rawSince === "string" && rawSince.length > 0) {
    const parsed = new Date(rawSince);
    if (Number.isNaN(parsed.getTime())) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_since_filter",
          detail: "since must be an ISO-8601 timestamp",
        },
      };
    }
    since = parsed;
  } else {
    since = new Date(Date.now() - WINDOW_MS);
  }

  return { ok: true, filters: { stateFilter, since } };
}

interface ConsoleRun {
  generationId: string;
  submissionId: string;
  engagementId: string;
  engagementName: string;
  jurisdiction: string | null;
  state: PublicState;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  invalidCitationCount: number | null;
  invalidCitations: string[] | null;
  discardedFindingCount: number | null;
}

async function loadConsoleRuns(filters: ParsedFilters): Promise<ConsoleRun[]> {
  const whereClauses = [gte(findingRuns.startedAt, filters.since)];
  if (filters.stateFilter) {
    whereClauses.push(eq(findingRuns.state, toDbState(filters.stateFilter)));
  }

  const consoleLimit = resolveConsoleLimit();
  const perSubmissionCap = resolveKeepPerSubmission();

  // Pull ordered candidates, then apply the per-submission cap in
  // memory (Drizzle does not surface a portable window-function
  // helper). The query is bounded by the `since` window + the
  // global limit so the unbounded-table pathology doesn't apply.
  const rows = await db
    .select({
      generationId: findingRuns.id,
      submissionId: findingRuns.submissionId,
      engagementId: submissions.engagementId,
      engagementName: engagements.name,
      jurisdiction: engagements.jurisdiction,
      state: findingRuns.state,
      startedAt: findingRuns.startedAt,
      completedAt: findingRuns.completedAt,
      error: findingRuns.error,
      invalidCitationCount: findingRuns.invalidCitationCount,
      invalidCitations: findingRuns.invalidCitations,
      discardedFindingCount: findingRuns.discardedFindingCount,
    })
    .from(findingRuns)
    .innerJoin(submissions, eq(findingRuns.submissionId, submissions.id))
    .innerJoin(engagements, eq(submissions.engagementId, engagements.id))
    .where(and(...whereClauses))
    .orderBy(desc(findingRuns.startedAt))
    .limit(consoleLimit * Math.max(perSubmissionCap, 1));

  const seenPerSubmission = new Map<string, number>();
  const capped: typeof rows = [];
  for (const r of rows) {
    const seen = seenPerSubmission.get(r.submissionId) ?? 0;
    if (seen >= perSubmissionCap) continue;
    seenPerSubmission.set(r.submissionId, seen + 1);
    capped.push(r);
    if (capped.length >= consoleLimit) break;
  }

  return capped.map((r) => {
    const startedAtIso = r.startedAt.toISOString();
    const completedAtIso = r.completedAt
      ? r.completedAt.toISOString()
      : null;
    const durationMs = r.completedAt
      ? r.completedAt.getTime() - r.startedAt.getTime()
      : null;
    return {
      generationId: r.generationId,
      submissionId: r.submissionId,
      engagementId: r.engagementId,
      engagementName: r.engagementName,
      jurisdiction: r.jurisdiction,
      state: toPublicState(r.state),
      startedAt: startedAtIso,
      completedAt: completedAtIso,
      durationMs,
      error: r.error,
      invalidCitationCount: r.invalidCitationCount,
      invalidCitations: r.invalidCitations,
      discardedFindingCount: r.discardedFindingCount,
    };
  });
}

// ─── GET /findings/runs ────────────────────────────────────────────

router.get("/findings/runs", async (req: Request, res: Response) => {
  if (requireReviewerAudience(req, res)) return;

  const parsed = parseRunFilters(req);
  if (!parsed.ok) {
    res.status(parsed.status).json(parsed.body);
    return;
  }

  try {
    const runs = await loadConsoleRuns(parsed.filters);
    res.json({ runs });
  } catch (err) {
    logger.error({ err }, "list cross-submission finding runs failed");
    res.status(500).json({ error: "Failed to list finding runs" });
  }
});

// ─── GET /findings/runs/export.csv ─────────────────────────────────

/** Spreadsheet formula-injection guard. Excel/Sheets interpret cells
 *  whose first character is `=`, `+`, `-`, `@`, TAB, CR, or LF as a
 *  formula even inside quoted CSV fields. Because this export is meant
 *  to be opened by external auditors, neutralize any user-controlled
 *  text that opens with one of those characters by prefixing a single
 *  quote — the canonical Excel "treat as text" sigil. We trim leading
 *  whitespace before the check so payloads like "  =cmd" are caught.
 *  See OWASP "CSV Injection". */
function neutralizeFormula(s: string): string {
  if (s.length === 0) return s;
  const firstNonWs = s.match(/^\s*(.)/);
  const lead = firstNonWs ? firstNonWs[1] : s[0];
  if (lead === "=" || lead === "+" || lead === "-" || lead === "@") {
    return `'${s}`;
  }
  // Leading TAB/CR/LF can also kick a cell into formula mode in some
  // spreadsheet apps; same defense.
  const rawLead = s[0];
  if (rawLead === "\t" || rawLead === "\r" || rawLead === "\n") {
    return `'${s}`;
  }
  return s;
}

/** RFC 4180 field escaping — quote whenever the value contains a
 *  delimiter, quote, or newline; escape embedded quotes by doubling.
 *  Strings are also passed through `neutralizeFormula` so user-supplied
 *  text columns can't kick a spreadsheet into formula evaluation. */
function csvField(value: string | number | null | undefined): string {
  if (value == null) return "";
  let s = String(value);
  if (s === "") return "";
  if (typeof value === "string") {
    s = neutralizeFormula(s);
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvField).join(",");
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

router.get(
  "/findings/runs/export.csv",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;

    const parsed = parseRunFilters(req);
    if (!parsed.ok) {
      res.status(parsed.status).json(parsed.body);
      return;
    }

    const rawQ = req.query.q;
    const q =
      typeof rawQ === "string" && rawQ.trim().length > 0
        ? rawQ.trim().toLowerCase()
        : null;

    try {
      const runs = await loadConsoleRuns(parsed.filters);
      const filtered = q
        ? runs.filter((r) => {
            const haystack = [
              r.engagementName,
              r.jurisdiction ?? "",
              r.error ?? "",
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(q);
          })
        : runs;

      const header = csvRow([
        "engagement",
        "jurisdiction",
        "state",
        "started",
        "duration_ms",
        "invalid_citations",
        "discarded_findings",
      ]);
      const body = filtered.map((r) =>
        csvRow([
          r.engagementName,
          r.jurisdiction,
          r.state,
          r.startedAt,
          r.durationMs,
          r.invalidCitationCount ?? 0,
          r.discardedFindingCount ?? 0,
        ]),
      );
      // CRLF per RFC 4180; trailing newline so POSIX tools count the
      // last row.
      const csv = [header, ...body].join("\r\n") + "\r\n";

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="compliance-runs-${todayStamp()}.csv"`,
      );
      res.send(csv);
    } catch (err) {
      logger.error({ err }, "export cross-submission finding runs csv failed");
      res.status(500).json({ error: "Failed to export finding runs" });
    }
  },
);

// ─── GET /findings/runs/summary ────────────────────────────────────

interface KpiMetric {
  value: number | null;
  trend: "up" | "down" | null;
  trendLabel: string | null;
}

function buildKpiMetric(
  current: number | null,
  prior: number | null,
): KpiMetric {
  if (current == null) {
    return { value: null, trend: null, trendLabel: null };
  }
  if (prior == null || prior === 0) {
    return { value: current, trend: null, trendLabel: null };
  }
  const deltaPct = ((current - prior) / prior) * 100;
  const trend: "up" | "down" = deltaPct >= 0 ? "up" : "down";
  const magnitude = Math.abs(deltaPct);
  const formatted =
    magnitude >= 10 ? Math.round(magnitude).toString() : magnitude.toFixed(1);
  return {
    value: current,
    trend,
    trendLabel: `${formatted}% vs prior ${WINDOW_DAYS}d`,
  };
}

router.get(
  "/findings/runs/summary",
  async (req: Request, res: Response) => {
    if (requireReviewerAudience(req, res)) return;
    try {
      const now = new Date();
      const windowStart = new Date(now.getTime() - WINDOW_MS);
      const priorStart = new Date(now.getTime() - 2 * WINDOW_MS);

      // Per-bucket aggregate query. Buckets the trailing 60 days into
      // current / prior 30-day halves so we can compute trend deltas
      // in a single round trip.
      const aggRows = await db
        .select({
          bucket: sql<string>`CASE
            WHEN ${findingRuns.startedAt} >= ${windowStart} THEN 'current'
            ELSE 'prior'
          END`,
          totalRuns: sql<number>`COUNT(*)::int`,
          succeeded: sql<number>`SUM(CASE WHEN ${findingRuns.state} = 'completed' THEN 1 ELSE 0 END)::int`,
          failed: sql<number>`SUM(CASE WHEN ${findingRuns.state} = 'failed' THEN 1 ELSE 0 END)::int`,
          avgDurationMs: sql<string | null>`AVG(EXTRACT(EPOCH FROM (${findingRuns.completedAt} - ${findingRuns.startedAt})) * 1000.0) FILTER (WHERE ${findingRuns.completedAt} IS NOT NULL)`,
          invalidCitationsTotal: sql<number>`COALESCE(SUM(${findingRuns.invalidCitationCount}), 0)::int`,
          discardedFindingsTotal: sql<number>`COALESCE(SUM(${findingRuns.discardedFindingCount}), 0)::int`,
        })
        .from(findingRuns)
        .where(
          and(
            gte(findingRuns.startedAt, priorStart),
            lt(findingRuns.startedAt, now),
          ),
        )
        .groupBy(sql`1`);

      type Bucket = {
        totalRuns: number | null;
        successRate: number | null;
        avgDurationMs: number | null;
        invalidCitationsTotal: number | null;
        discardedFindingsTotal: number | null;
      };
      const empty: Bucket = {
        totalRuns: null,
        successRate: null,
        avgDurationMs: null,
        invalidCitationsTotal: null,
        discardedFindingsTotal: null,
      };
      const buckets: { current: Bucket; prior: Bucket } = {
        current: { ...empty },
        prior: { ...empty },
      };
      for (const row of aggRows) {
        const total = Number(row.totalRuns);
        const succeeded = Number(row.succeeded);
        const failed = Number(row.failed);
        const judged = succeeded + failed;
        const successRate =
          judged > 0 ? (succeeded / judged) * 100 : null;
        const avgDurationMs =
          row.avgDurationMs == null ? null : Number(row.avgDurationMs);
        const bucket: Bucket = {
          totalRuns: total > 0 ? total : null,
          successRate,
          avgDurationMs,
          invalidCitationsTotal: Number(row.invalidCitationsTotal),
          discardedFindingsTotal: Number(row.discardedFindingsTotal),
        };
        if (row.bucket === "current") buckets.current = bucket;
        else if (row.bucket === "prior") buckets.prior = bucket;
      }

      res.json({
        totalRuns: buildKpiMetric(
          buckets.current.totalRuns,
          buckets.prior.totalRuns,
        ),
        successRate: buildKpiMetric(
          buckets.current.successRate,
          buckets.prior.successRate,
        ),
        avgDurationMs: buildKpiMetric(
          buckets.current.avgDurationMs,
          buckets.prior.avgDurationMs,
        ),
        invalidCitationsTotal: buildKpiMetric(
          buckets.current.invalidCitationsTotal,
          buckets.prior.invalidCitationsTotal,
        ),
        discardedFindingsTotal: buildKpiMetric(
          buckets.current.discardedFindingsTotal,
          buckets.prior.discardedFindingsTotal,
        ),
      });
    } catch (err) {
      logger.error({ err }, "compute findings runs summary failed");
      res.status(500).json({ error: "Failed to compute summary" });
    }
  },
);

export default router;
