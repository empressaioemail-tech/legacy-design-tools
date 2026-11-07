/**
 * GTM observation layer — consent + events for Empressa wedge operator loop.
 *
 *   POST /api/brokerage/v1/gtm/consent
 *   POST /api/brokerage/v1/gtm/events
 *   POST /api/brokerage/v1/gtm/mcp-event
 *   GET  /api/brokerage/v1/gtm/consent/:installId
 *   GET  /api/brokerage/v1/gtm/digest
 *   GET  /api/brokerage/v1/gtm/triage
 *   POST /api/brokerage/v1/gtm/outbound/attempt  (Tier 1 — hard-disabled in v1)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, gtmConsent, gtmEvents } from "@workspace/db";
import { eq, sql, gte, desc, and } from "drizzle-orm";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { requireBrokerageAuthOrServiceToken } from "../middlewares/brokerageServiceAuth";
import { brokerageCors } from "../middlewares/brokerageCors";
import { GTM_CONSENT_VERSION, recordGtmEvent } from "../lib/recordGtmEvent";
import {
  GTM_MCP_EVENT_TYPES,
  hashApiKeyPrefix,
  isInternalApiKeyHash,
  loadInternalGtmApiKeys,
} from "../lib/gtmMcpEvents";
import { isGtmErrorClass, type GtmErrorClass } from "../lib/gtmErrorClass";
import { classifyGtmEvents } from "../lib/gtmTriage";
import { computeGtmScoreboardMetrics } from "../lib/gtmScoreboardMetrics";
import { computeInvestorFunnelMetrics, listRecentQualifiedProspects } from "../lib/gtmInvestorFunnel";
import {
  computePropertyExplorerFunnelMetrics,
  isPropertyExplorerFunnelEventType,
  PE_GTM_CONSENT_VERSION,
} from "../lib/gtmPropertyExplorerFunnel";
import { syncPropertyExplorerCrm } from "../lib/propertyExplorerGtmCrm";
import { syncPipedriveLead } from "../lib/brokeragePipedrive";
import { attemptOutboundSend } from "../lib/gtmOutbound";
import { GTM_OUTBOUND_ACTIONS, isOutboundEnabled } from "../lib/gtmPolicy";
import { requireServiceToken } from "../middlewares/serviceAuth";
import { parseShareAttribution } from "../lib/peShareAttributionValidate";
import { parseAccountActivation } from "../lib/peAccountActivationValidate";
import {
  attributeShareRecipient,
  recordAccountActivation,
} from "../lib/peShareAttribution";
import { computeShareFunnelReadout } from "../lib/gtmShareFunnelReadout";

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

brokerageGtmRouter.post("/consent", brokerageAuth, async (req: Request, res: Response) => {
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
  brokerageAuth,
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

brokerageGtmRouter.post("/events", brokerageAuth, async (req: Request, res: Response) => {
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

const MCP_EVENT_BODY = z.object({
  eventType: z.enum(GTM_MCP_EVENT_TYPES),
  sourceSurface: z.enum(["mcp", "api", "docs"]).default("mcp"),
  installId: z.string().min(8).max(128).optional(),
  tool_name: z.string().max(128).optional(),
  error_class: z.string().max(64).optional(),
  jurisdiction_key: z.string().max(128).optional(),
  latency_ms: z.number().int().nonnegative().optional(),
});

function loadBrokerageKeyHashes(): string[] {
  return loadInternalGtmApiKeys().map((k) => hashApiKeyPrefix(k));
}

brokerageGtmRouter.post("/mcp-event", requireBrokerageAuthOrServiceToken, async (req: Request, res: Response) => {
  const parse = MCP_EVENT_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request", message: "Invalid MCP event body" });
    return;
  }

  const data = parse.data;
  const authHeader = req.headers.authorization;
  const rawKey =
    authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : typeof req.headers["x-hauska-key"] === "string"
        ? req.headers["x-hauska-key"].trim()
        : "";
  const api_key_hash = rawKey ? hashApiKeyPrefix(rawKey) : undefined;
  const error_class =
    data.error_class && isGtmErrorClass(data.error_class)
      ? (data.error_class as GtmErrorClass)
      : data.error_class;

  const installId = data.installId ?? `mcp-server-${api_key_hash ?? "anon"}`;

  const internalKeys = loadInternalGtmApiKeys();
  const externalCaller = api_key_hash
    ? !isInternalApiKeyHash(api_key_hash, internalKeys)
    : null;

  const [inserted] = await db
    .insert(gtmEvents)
    .values({
      installId,
      eventType: data.eventType,
      sourceSurface: data.sourceSurface,
      payloadJson: {
        tool_name: data.tool_name ?? null,
        error_class: error_class ?? null,
        jurisdiction_key: data.jurisdiction_key ?? null,
        api_key_hash: api_key_hash ?? null,
        latency_ms: data.latency_ms ?? null,
        external_caller: externalCaller,
      },
    })
    .returning({ id: gtmEvents.id });

  if (inserted?.id && externalCaller) {
    const triage = classifyGtmEvents([
      {
        eventType: data.eventType,
        sourceSurface: data.sourceSurface,
        toolName: data.tool_name ?? null,
        errorClass: typeof error_class === "string" ? error_class : null,
        externalCaller,
        jurisdictionKey: data.jurisdiction_key ?? null,
        eventId: inserted.id,
      },
    ])[0];
    recordGtmEvent({
      installId,
      eventType: "triage_signal",
      sourceSurface: "api",
      payload: {
        source_event_id: inserted.id,
        triage: triage.triage,
      },
    });
  }

  res.status(201).json({ ok: true, eventId: inserted?.id });
});

function parseDigestWindowDays(req: Request): number {
  const raw = req.query.days;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : 7;
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) return 7;
  return parsed;
}

/** Steward digest helper (default 7-day window). */
brokerageGtmRouter.get(
  "/digest",
  requireBrokerageAuthOrServiceToken,
  async (req: Request, res: Response) => {
    const windowDays = parseDigestWindowDays(req);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const counts = await db
      .select({
        eventType: gtmEvents.eventType,
        count: sql<number>`count(*)::int`,
      })
      .from(gtmEvents)
      .where(gte(gtmEvents.createdAt, since))
      .groupBy(gtmEvents.eventType);

    const surfaceCounts = await db
      .select({
        sourceSurface: gtmEvents.sourceSurface,
        count: sql<number>`count(*)::int`,
      })
      .from(gtmEvents)
      .where(gte(gtmEvents.createdAt, since))
      .groupBy(gtmEvents.sourceSurface);

    const mcpToolRows = await db
      .select({
        toolName: sql<string>`payload_json ->> 'tool_name'`,
        count: sql<number>`count(*)::int`,
      })
      .from(gtmEvents)
      .where(
        and(
          gte(gtmEvents.createdAt, since),
          eq(gtmEvents.eventType, "mcp_tool_call"),
        ),
      )
      .groupBy(sql`payload_json ->> 'tool_name'`)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    const mcpEvents = await db
      .select({
        payloadJson: gtmEvents.payloadJson,
      })
      .from(gtmEvents)
      .where(
        and(
          gte(gtmEvents.createdAt, since),
          eq(gtmEvents.sourceSurface, "mcp"),
        ),
      );

    let externalMcpCalls = 0;
    let internalMcpCalls = 0;
    for (const row of mcpEvents) {
      const hash = row.payloadJson?.api_key_hash;
      const internalKeys = loadInternalGtmApiKeys();
      if (typeof hash === "string" && isInternalApiKeyHash(hash, internalKeys)) {
        internalMcpCalls += 1;
      } else if (typeof hash === "string") {
        externalMcpCalls += 1;
      }
    }

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

    const scoreboardMetrics = await computeGtmScoreboardMetrics(since);
    const investorFunnel = await computeInvestorFunnelMetrics(since, windowDays);
    const propertyExplorerFunnel = await computePropertyExplorerFunnelMetrics(
      since,
      windowDays,
    );

    const triageSourceRows = await db
      .select({
        id: gtmEvents.id,
        eventType: gtmEvents.eventType,
        sourceSurface: gtmEvents.sourceSurface,
        payloadJson: gtmEvents.payloadJson,
        createdAt: gtmEvents.createdAt,
      })
      .from(gtmEvents)
      .where(
        and(
          gte(gtmEvents.createdAt, since),
          sql`${gtmEvents.eventType} IN ('mcp_tool_call', 'mcp_connect', 'mcp_error', 'mcp_docs_clicked')`,
        ),
      )
      .orderBy(desc(gtmEvents.createdAt))
      .limit(50);

    const internalKeys = loadInternalGtmApiKeys();

    const triageSample = classifyGtmEvents(
      triageSourceRows.map((row) => {
        const payload = row.payloadJson ?? {};
        const hash =
          typeof payload.api_key_hash === "string" ? payload.api_key_hash : null;
        return {
          eventId: row.id,
          createdAt: row.createdAt.toISOString(),
          eventType: row.eventType,
          sourceSurface: row.sourceSurface,
          toolName:
            typeof payload.tool_name === "string" ? payload.tool_name : null,
          errorClass:
            typeof payload.error_class === "string" ? payload.error_class : null,
          externalCaller: hash ? !isInternalApiKeyHash(hash, internalKeys) : null,
          jurisdictionKey:
            typeof payload.jurisdiction_key === "string"
              ? payload.jurisdiction_key
              : null,
        };
      }),
    );

    res.json({
      windowDays,
      since: since.toISOString(),
      consentRecords: consentTotal[0]?.count ?? 0,
      eventCounts: counts,
      sourceSurfaceCounts: surfaceCounts,
      mcp: {
        topTools: mcpToolRows
          .filter((r) => r.toolName)
          .map((r) => ({ tool_name: r.toolName, count: r.count })),
        callerSplit: {
          external: externalMcpCalls,
          internal: internalMcpCalls,
        },
        scoreboard: scoreboardMetrics,
      },
      mcpTopTools: mcpToolRows
        .filter((r) => r.toolName)
        .map((r) => ({ tool_name: r.toolName, count: r.count })),
      mcpCallerSplit: {
        external: externalMcpCalls,
        internal: internalMcpCalls,
      },
      scoreboardMetrics,
      investorFunnel,
      propertyExplorerFunnel,
      triageSample,
      policyTier: {
        outboundEnabled: isOutboundEnabled(),
        tier1Held: !isOutboundEnabled(),
      },
      recentEvents: recent.map((r) => ({
        eventType: r.eventType,
        installId: r.installId.slice(0, 8) + "…",
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

/** Read-only triage classification for external MCP events. */
brokerageGtmRouter.get("/triage", requireBrokerageAuthOrServiceToken, async (req: Request, res: Response) => {
  const windowDays = parseDigestWindowDays(req);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: gtmEvents.id,
      eventType: gtmEvents.eventType,
      sourceSurface: gtmEvents.sourceSurface,
      payloadJson: gtmEvents.payloadJson,
      createdAt: gtmEvents.createdAt,
    })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        sql`payload_json ->> 'external_caller' = 'true'`,
      ),
    )
    .orderBy(desc(gtmEvents.createdAt))
    .limit(100);

  const internalKeys = loadInternalGtmApiKeys();

  const classified = classifyGtmEvents(
    rows.map((row) => {
      const payload = row.payloadJson ?? {};
      const hash =
        typeof payload.api_key_hash === "string" ? payload.api_key_hash : null;
      return {
        eventId: row.id,
        createdAt: row.createdAt.toISOString(),
        eventType: row.eventType,
        sourceSurface: row.sourceSurface,
        toolName:
          typeof payload.tool_name === "string" ? payload.tool_name : null,
        errorClass:
          typeof payload.error_class === "string" ? payload.error_class : null,
        externalCaller: hash ? !isInternalApiKeyHash(hash, internalKeys) : true,
        jurisdictionKey:
          typeof payload.jurisdiction_key === "string"
            ? payload.jurisdiction_key
            : null,
      };
    }),
  );

  const qualifiedProspects = await listRecentQualifiedProspects(since, 25);
  for (const prospect of qualifiedProspects) {
    void syncPipedriveLead({
      installId: prospect.installId,
      title: `Qualified prospect — ${prospect.eventType}`,
      sourceEventId: prospect.eventId,
      intentScore: prospect.intentScore,
    });
  }

  res.json({
    windowDays,
    since: since.toISOString(),
    externalEventCount: classified.length,
    classifications: classified,
    qualifiedProspects,
  });
});

const OUTBOUND_BODY = z.object({
  action: z.enum(GTM_OUTBOUND_ACTIONS),
  installId: z.string().min(8).max(128),
});

/** Tier 1 outbound attempt — blocked when OUTBOUND_ENABLED=false (v1 default). */
brokerageGtmRouter.post(
  "/outbound/attempt",
  requireBrokerageAuthOrServiceToken,
  async (req: Request, res: Response) => {
    const parse = OUTBOUND_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request", message: "Invalid outbound body" });
      return;
    }

    const { action, installId } = parse.data;

    const [consent] = await db
      .select()
      .from(gtmConsent)
      .where(eq(gtmConsent.installId, installId))
      .limit(1);

    const result = await attemptOutboundSend({
      action,
      installId,
      hasConsent: Boolean(consent),
      payload: req.body.payload as Record<string, unknown> | undefined,
    });

    if (!result.sent) {
      res.status(403).json({
        error: "outbound_blocked",
        tier: result.tier,
        reason: result.reason,
        sent: false,
      });
      return;
    }

    res.status(200).json({ ok: true, sent: true, action: result.action });
  },
);

const PE_CONSENT_BODY = z.object({
  installId: z.string().min(8).max(128),
  termsAcceptedAt: z.string().datetime().optional(),
});

const PE_EVENT_BODY = z.object({
  installId: z.string().min(8).max(128),
  eventType: z.string().min(1).max(64),
  personaInferred: z.enum(["homeowner", "investor", "architect"]).optional(),
  listingKey: z.string().max(128).optional(),
  payload: z.record(z.unknown()).optional(),
});

/** Property Explorer web consent (WDLL 25) — BFF/service-token path. */
brokerageGtmRouter.post(
  "/property-explorer/consent",
  requireBrokerageAuthOrServiceToken,
  async (req: Request, res: Response) => {
    const parse = PE_CONSENT_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request", message: "Invalid consent body" });
      return;
    }

    const { installId, termsAcceptedAt } = parse.data;
    const acceptedAt = termsAcceptedAt ? new Date(termsAcceptedAt) : new Date();

    await db
      .insert(gtmConsent)
      .values({
        installId,
        consentVersion: PE_GTM_CONSENT_VERSION,
        termsAcceptedAt: acceptedAt,
        graphOptIn: false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: gtmConsent.installId,
        set: {
          consentVersion: PE_GTM_CONSENT_VERSION,
          termsAcceptedAt: acceptedAt,
          updatedAt: new Date(),
        },
      });

    res.json({
      ok: true,
      installId,
      consentVersion: PE_GTM_CONSENT_VERSION,
      sourceSurface: "property-explorer",
    });
  },
);

/** Property Explorer funnel events + CRM sync (WDLL 25). */
brokerageGtmRouter.post(
  "/property-explorer/events",
  requireBrokerageAuthOrServiceToken,
  async (req: Request, res: Response) => {
    const parse = PE_EVENT_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: "invalid_request", message: "Invalid event body" });
      return;
    }

    const data = parse.data;
    if (!isPropertyExplorerFunnelEventType(data.eventType)) {
      res.status(400).json({
        error: "invalid_event_type",
        message: "Unknown property-explorer funnel event",
      });
      return;
    }

    const [consent] = await db
      .select()
      .from(gtmConsent)
      .where(eq(gtmConsent.installId, data.installId))
      .limit(1);

    if (!consent) {
      res.status(403).json({
        error: "consent_required",
        message: "Call property-explorer/consent before sending events",
      });
      return;
    }

    const [inserted] = await db
      .insert(gtmEvents)
      .values({
        installId: data.installId,
        eventType: data.eventType,
        sourceSurface: "property-explorer",
        listingKey: data.listingKey ?? null,
        personaInferred: data.personaInferred ?? null,
        consentVersion: consent.consentVersion,
        graphOptIn: "false",
        payloadJson: data.payload ?? {},
      })
      .returning({ id: gtmEvents.id });

    const crm = await syncPropertyExplorerCrm({
      eventType: data.eventType,
      installId: data.installId,
      payload: data.payload,
    });

    res.status(201).json({
      ok: true,
      eventId: inserted?.id,
      pipedrive: crm.pipedrive ?? null,
      pipedriveConfigured: crm.pipedriveConfigured,
      pipedriveMode: crm.pipedrive?.mode ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// P-100 — share attribution, account activation, and the share-funnel readout
//
// WHY THESE ARE MOUNTED ON THE GTM ROUTER AND NOT ON propertyExplorer.ts.
// They are measurement, which is what this router is for; and at the time
// they were written another lane held `routes/propertyExplorer.ts`, so
// putting them there would have meant two lanes editing one file. The
// placement is deliberate, and this note exists so a successor can tell a
// deliberate exclusion from an oversight.
//
// All three are SERVICE-TOKEN ONLY. The browser never reaches them; the
// property-explorer BFF does, and the BFF is what resolves the caller's
// identity from its session cookie. That is the same trust model the share
// mint route already uses to resolve a grantor.
// ---------------------------------------------------------------------------

/**
 * P-100 item 3 — attribute a recipient account to the sharer behind a grant.
 *
 * POST /api/brokerage/v1/gtm/share-attribution
 *   { recipientUserId, grantId, surface? }
 *
 * `recipientUserId` is a PATH parameter of trust, not a claim: the BFF read
 * it from the PE session cookie it verified, exactly as the mint route reads
 * the grantor. What the route refuses is a body that names the SHARER — see
 * `peShareAttributionValidate.ts`. The sharer is resolved from the grant row
 * and from nowhere else.
 */
brokerageGtmRouter.post(
  "/share-attribution",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // The recipient id is pulled out BEFORE the client-assertion check so the
    // check can refuse `recipientUserId` in the payload proper. The BFF sends
    // it under a distinct key that only a service caller can set.
    const recipientUserId =
      typeof body.sessionRecipientUserId === "string"
        ? body.sessionRecipientUserId.trim()
        : "";
    if (!recipientUserId || recipientUserId.length > 128) {
      res.status(400).json({ error: "invalid_recipient" });
      return;
    }

    const rest = { ...body };
    delete rest.sessionRecipientUserId;

    const parsed = parseShareAttribution(rest);
    if (!parsed.ok) {
      res.status(400).json({
        error: parsed.refusal.error,
        ...("key" in parsed.refusal ? { key: parsed.refusal.key } : {}),
        message:
          parsed.refusal.error === "client_asserted_identity"
            ? "Attribution is resolved from the grant row. A body that names a sharer is refused, never ignored."
            : undefined,
      });
      return;
    }

    const result = await attributeShareRecipient({
      grantId: parsed.value.grantId,
      recipientUserId,
      surface: parsed.value.surface,
    });

    if (!result.ok) {
      res.status(result.refusal === "grant_not_found" ? 404 : 409).json({
        error: result.refusal,
      });
      return;
    }

    res.status(result.firstTouch ? 201 : 200).json({
      ok: true,
      grantId: result.grantId,
      grantorUserId: result.grantorUserId,
      attributedAt: result.attributedAt,
      firstTouch: result.firstTouch,
    });
  },
);

/**
 * P-100 item 4 — record that an account reached a milestone for the first time.
 *
 * POST /api/brokerage/v1/gtm/account-activation
 *   { sessionOwnerUserId, milestone, surface? }
 *
 * A re-fire is not an error: it returns 200 with `firstTime: false` and the
 * ORIGINAL `firstAt`. Once-per-account is held by the composite primary key,
 * so a second row cannot be written even under a race.
 */
brokerageGtmRouter.post(
  "/account-activation",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ownerUserId =
      typeof body.sessionOwnerUserId === "string"
        ? body.sessionOwnerUserId.trim()
        : "";
    if (!ownerUserId || ownerUserId.length > 128) {
      res.status(400).json({ error: "invalid_owner" });
      return;
    }

    const parsed = parseAccountActivation(body);
    if (!parsed.ok) {
      res.status(400).json({
        error: parsed.refusal.error,
        allowed: parsed.refusal.allowed,
      });
      return;
    }

    const recorded = await recordAccountActivation({
      ownerUserId,
      milestone: parsed.value.milestone,
      surface: parsed.value.surface,
    });

    res.status(recorded.firstTime ? 201 : 200).json({ ok: true, ...recorded });
  },
);

/**
 * P-100 item 6 — the readout that can go red.
 *
 * GET /api/brokerage/v1/gtm/share-funnel?days=7
 *
 * Every number comes back as `{state:'measured', value}` or
 * `{state:'unmeasured', basis}`. A quiet week returns measured zeros; an
 * unwired rail returns unmeasured and says what is missing. Affiliate is
 * reported beside share and is unmeasured today, with the reason in the
 * basis rather than in a comment nobody reads.
 */
brokerageGtmRouter.get(
  "/share-funnel",
  requireBrokerageAuthOrServiceToken,
  async (req: Request, res: Response) => {
    const windowDays = parseDigestWindowDays(req);
    res.json(await computeShareFunnelReadout(windowDays));
  },
);
