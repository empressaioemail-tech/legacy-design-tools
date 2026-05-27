/**
 * GTM observation layer — consent + events for Empressa wedge operator loop.
 *
 *   POST /api/brokerage/v1/gtm/consent
 *   POST /api/brokerage/v1/gtm/events
 *   GET  /api/brokerage/v1/gtm/consent/:installId
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, gtmConsent, gtmEvents } from "@workspace/db";
import { eq, sql, gte, desc } from "drizzle-orm";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { brokerageCors } from "../middlewares/brokerageCors";
import { GTM_CONSENT_VERSION } from "../lib/recordGtmEvent";

const CONSENT_BODY = z.object({
  installId: z.string().min(8).max(128),
  consentVersion: z.string().min(1).default(GTM_CONSENT_VERSION),
  graphOptIn: z.boolean().default(false),
  termsAcceptedAt: z.string().datetime().optional(),
});

const EVENT_BODY = z.object({
  installId: z.string().min(8).max(128),
  eventType: z.string().min(1).max(64),
  sourceSurface: z.string().max(32).optional(),
  runId: z.string().uuid().optional(),
  listingKey: z.string().max(128).optional(),
  personaInferred: z.string().max(64).optional(),
  consentVersion: z.string().optional(),
  graphOptIn: z.boolean().optional(),
  payload: z.record(z.unknown()).optional(),
});

export const brokerageGtmRouter: IRouter = Router();

brokerageGtmRouter.use(brokerageCors);
brokerageGtmRouter.use(brokerageAuth);

brokerageGtmRouter.post("/consent", async (req: Request, res: Response) => {
  const parse = CONSENT_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request", message: "Invalid consent body" });
    return;
  }

  const { installId, consentVersion, graphOptIn, termsAcceptedAt } = parse.data;
  const acceptedAt = termsAcceptedAt ? new Date(termsAcceptedAt) : new Date();

  await db
    .insert(gtmConsent)
    .values({
      installId,
      consentVersion,
      termsAcceptedAt: acceptedAt,
      graphOptIn,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: gtmConsent.installId,
      set: {
        consentVersion,
        graphOptIn,
        termsAcceptedAt: acceptedAt,
        updatedAt: new Date(),
      },
    });

  res.json({
    ok: true,
    installId,
    consentVersion,
    graphOptIn,
    termsAcceptedAt: acceptedAt.toISOString(),
  });
});

brokerageGtmRouter.get(
  "/consent/:installId",
  async (req: Request, res: Response) => {
    const raw = req.params.installId;
    const installId = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!installId) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const [row] = await db
      .select()
      .from(gtmConsent)
      .where(eq(gtmConsent.installId, installId))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "not_found", message: "No consent record" });
      return;
    }

    res.json({
      installId: row.installId,
      consentVersion: row.consentVersion,
      graphOptIn: row.graphOptIn,
      termsAcceptedAt: row.termsAcceptedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  },
);

brokerageGtmRouter.post("/events", async (req: Request, res: Response) => {
  const parse = EVENT_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request", message: "Invalid event body" });
    return;
  }

  const data = parse.data;

  const [consent] = await db
    .select()
    .from(gtmConsent)
    .where(eq(gtmConsent.installId, data.installId))
    .limit(1);

  if (!consent) {
    res.status(403).json({
      error: "consent_required",
      message: "Accept terms in extension settings before sending events",
    });
    return;
  }

  const shareEvents = new Set([
    "share_created",
    "share_viewed",
    "graph_edge_created",
  ]);
  if (shareEvents.has(data.eventType) && !consent.graphOptIn) {
    res.status(403).json({
      error: "graph_opt_in_required",
      message: "Enable network graph contribution in settings for sharing",
    });
    return;
  }

  const [inserted] = await db
    .insert(gtmEvents)
    .values({
      installId: data.installId,
      eventType: data.eventType,
      sourceSurface: data.sourceSurface ?? "extension",
      runId: data.runId ?? null,
      listingKey: data.listingKey ?? null,
      personaInferred: data.personaInferred ?? null,
      consentVersion: consent.consentVersion,
      graphOptIn: consent.graphOptIn ? "true" : "false",
      payloadJson: data.payload ?? {},
    })
    .returning({ id: gtmEvents.id });

  res.status(201).json({ ok: true, eventId: inserted?.id });
});

/** Steward digest helper (7-day window). */
brokerageGtmRouter.get(
  "/digest",
  async (req: Request, res: Response) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const counts = await db
      .select({
        eventType: gtmEvents.eventType,
        count: sql<number>`count(*)::int`,
      })
      .from(gtmEvents)
      .where(gte(gtmEvents.createdAt, since))
      .groupBy(gtmEvents.eventType);

    const recent = await db
      .select({
        eventType: gtmEvents.eventType,
        installId: gtmEvents.installId,
        createdAt: gtmEvents.createdAt,
      })
      .from(gtmEvents)
      .where(gte(gtmEvents.createdAt, since))
      .orderBy(desc(gtmEvents.createdAt))
      .limit(20);

    const consentTotal = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(gtmConsent);

    res.json({
      windowDays: 7,
      since: since.toISOString(),
      consentRecords: consentTotal[0]?.count ?? 0,
      eventCounts: counts,
      recentEvents: recent.map((r) => ({
        eventType: r.eventType,
        installId: r.installId.slice(0, 8) + "…",
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);
