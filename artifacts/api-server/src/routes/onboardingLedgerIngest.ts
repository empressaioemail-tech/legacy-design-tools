/**
 * Onboarding ledger ingest, OPS-9 S1.
 *
 * Machine-to-machine write path for hauska-engine's onboarding report
 * wrappers (preflight-and-report.mjs, cert-grade-and-report.mjs). Bearer
 * service-token auth only (no browser session path, this is never called
 * from a browser), reusing the same `requireServiceToken` idiom every other
 * pure service-to-service route in this file uses (see
 * routes/operatorRunState.ts's `/internal/qa/run-state`,
 * routes/propertyExplorer.ts's `/internal/share-dossier`).
 *
 * Upserts jurisdiction_registry_row_mirror + county_gate_cert_state;
 * inserts onboarding_ledger_event rows idempotently, deduped on the OPEN
 * natural key (row_id, parcel_node_id, defect_class, rail_or_check,
 * check_id) via a partial unique index, a re-seen finding bumps
 * `last_seen_at` on the existing open row instead of duplicating it.
 *
 * Read side: GET /api/county-ledger (countyLedger.ts) joins these three
 * tables into its response additively.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import {
  db,
  onboardingLedgerEvent,
  jurisdictionRegistryRowMirror,
  countyGateCertState,
} from "@workspace/db";
import { requireServiceToken } from "../middlewares/serviceAuth";

const router: IRouter = Router();

const RowMirrorSchema = z.object({
  rowId: z.string().min(1),
  fips: z.string().min(1),
  countyName: z.string().min(1),
  status: z.string().min(1),
  zoningRegime: z.string().min(1),
});

const EventSchema = z.object({
  ts: z.string().min(1),
  fips: z.string().min(1),
  rowId: z.string().min(1),
  parcelNodeId: z.string().min(1).optional(),
  railOrCheck: z.string().min(1).optional(),
  checkId: z.string().min(1).optional(),
  sweepId: z.string().min(1).optional(),
  declineReason: z.string().min(1).optional(),
  defectClass: z.string().min(1),
  severity: z.string().min(1).optional(),
  evidence: z.unknown().optional(),
  artifactRef: z.string().min(1).optional(),
});

const CertSummarySchema = z.object({
  rowId: z.string().min(1),
  fips: z.string().min(1),
  label: z.string().min(1),
  blockPass: z.boolean(),
  scopeAnnotations: z.unknown().optional(),
  gradedAt: z.string().min(1),
});

const GateSummarySchema = z.object({
  rowId: z.string().min(1),
  fips: z.string().min(1),
  passCount: z.number(),
  declineCount: z.number(),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      outcome: z.string().min(1),
      reason: z.string().min(1).optional(),
    }),
  ),
});

const IngestBodySchema = z.object({
  sourceKind: z.enum(["preflight", "cert-grade", "block13-quarantine", "warden-sweep"]),
  rowMirror: z.array(RowMirrorSchema).optional(),
  events: z.array(EventSchema),
  certSummary: CertSummarySchema.optional(),
  gateSummary: GateSummarySchema.optional(),
});

/**
 * POST /api/onboarding-ledger/ingest, the pinned contract. Bearer
 * service-token auth (hard 401 on missing/wrong token, no session
 * fallback; see module doc).
 */
router.post("/ingest", requireServiceToken, async (req: Request, res: Response) => {
  const parsed = IngestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      error: "onboarding_ledger_ingest_invalid_body",
      message: parsed.error.message,
    });
    return;
  }
  const { sourceKind, rowMirror, events, certSummary, gateSummary } = parsed.data;

  try {
    if (rowMirror && rowMirror.length > 0) {
      for (const row of rowMirror) {
        await db
          .insert(jurisdictionRegistryRowMirror)
          .values({
            rowId: row.rowId,
            fips: row.fips,
            countyName: row.countyName,
            status: row.status,
            zoningRegime: row.zoningRegime,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [jurisdictionRegistryRowMirror.rowId],
            set: {
              fips: row.fips,
              countyName: row.countyName,
              status: row.status,
              zoningRegime: row.zoningRegime,
              updatedAt: new Date(),
            },
          });
      }
    }

    if (gateSummary || certSummary) {
      const rowId = gateSummary?.rowId ?? certSummary?.rowId;
      const fips = gateSummary?.fips ?? certSummary?.fips;
      if (rowId && fips) {
        await db
          .insert(countyGateCertState)
          .values({
            rowId,
            fips,
            gatePassCount: gateSummary?.passCount ?? null,
            gateDeclineCount: gateSummary?.declineCount ?? null,
            gateChecks: gateSummary?.checks ?? null,
            certLabel: certSummary?.label ?? null,
            certBlockPass: certSummary?.blockPass ?? null,
            certScopeAnnotations: certSummary?.scopeAnnotations ?? null,
            certGradedAt: certSummary?.gradedAt ? new Date(certSummary.gradedAt) : null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [countyGateCertState.rowId],
            set: {
              fips,
              // Only overwrite gate/cert fields this call actually carries ,
              // a cert-grade-only ingest must not null out a prior
              // preflight's gate counts, and vice versa.
              ...(gateSummary
                ? {
                    gatePassCount: gateSummary.passCount,
                    gateDeclineCount: gateSummary.declineCount,
                    gateChecks: gateSummary.checks,
                  }
                : {}),
              ...(certSummary
                ? {
                    certLabel: certSummary.label,
                    certBlockPass: certSummary.blockPass,
                    certScopeAnnotations: certSummary.scopeAnnotations ?? null,
                    certGradedAt: new Date(certSummary.gradedAt),
                  }
                : {}),
              updatedAt: new Date(),
            },
          });
      }
    }

    for (const event of events) {
      await db
        .insert(onboardingLedgerEvent)
        .values({
          ts: new Date(event.ts),
          fips: event.fips,
          rowId: event.rowId,
          parcelNodeId: event.parcelNodeId ?? null,
          sourceKind,
          railOrCheck: event.railOrCheck ?? null,
          checkId: event.checkId ?? null,
          sweepId: event.sweepId ?? null,
          declineReason: event.declineReason ?? null,
          defectClass: event.defectClass,
          severity: event.severity ?? null,
          evidence: event.evidence ?? null,
          artifactRef: event.artifactRef ?? null,
          status: "open",
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            onboardingLedgerEvent.rowId,
            onboardingLedgerEvent.parcelNodeId,
            onboardingLedgerEvent.defectClass,
            onboardingLedgerEvent.railOrCheck,
            onboardingLedgerEvent.checkId,
          ],
          targetWhere: sql`${onboardingLedgerEvent.status} = 'open'`,
          set: {
            lastSeenAt: new Date(),
            declineReason: event.declineReason ?? null,
            severity: event.severity ?? null,
            evidence: event.evidence ?? null,
            artifactRef: event.artifactRef ?? null,
          },
        });
    }

    res.json({ ok: true, sourceKind, eventsIngested: events.length });
  } catch (err) {
    res.status(500).json({
      error: "onboarding_ledger_ingest_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export { router as onboardingLedgerIngestRouter };
