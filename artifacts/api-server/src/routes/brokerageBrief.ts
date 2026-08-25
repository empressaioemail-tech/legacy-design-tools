/**
 * Hauska Property Brief — Chrome extension brokerage API.
 *
 *   POST /api/brokerage/v1/brief
 *   GET  /api/brokerage/v1/brief/:runId
 *   POST /api/brokerage/v1/brief/summarize
 *   POST /api/brokerage/v1/research/chat
 *   GET  /api/brokerage/v1/coverage
 *   GET  /api/brokerage/v1/workspaces/recent
 *   GET  /api/brokerage/v1/workspaces/:id
 *   GET  /api/brokerage/v1/entitlement
 *   GET  /api/brokerage/v1/wallet
 *   GET  /api/brokerage/v1/admin/graph
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { geocodeAddress } from "@workspace/site-context/server";
import {
  keyFromEngagement,
  retrieveAtomsForQuestion,
  isSubstrateRetrievalError,
  isSubstrateRetrievalConfigured,
  type RetrievedAtom,
} from "@workspace/codes";
import { db, brokerageBriefRuns } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  authenticatedBrokerageUserId,
  isExtensionPublicClient,
} from "../middlewares/brokerageAuth";
import {
  isBrokerageServiceCaller,
  requireBrokerageAuthOrServiceToken,
} from "../middlewares/brokerageServiceAuth";
import { brokerageCors } from "../middlewares/brokerageCors";
import { logger } from "../lib/logger";
import {
  generateReasoningSummary,
  generateSummarize,
  generateResearchChat,
  type BriefAtomInput,
} from "../lib/brokerageBriefLlm";
import { generateLaySummary } from "../lib/propertyBriefLaySummary";
import {
  PERSONA_BUCKETS,
  STARTER_PROMPT_IDS,
  type PersonaBucket,
  type StarterPromptId,
} from "../lib/propertyBriefStarters";
import { recordGtmEvent } from "../lib/recordGtmEvent";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import {
  fetchBrokerageSiteContext,
  stripSiteContextForClient,
  stripBriefPayloadForClient,
} from "../lib/brokerageSiteContext";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import {
  assertExtensionPublicBriefAllowed,
  assertExtensionPublicResearchChatAllowed,
  gtmPayloadWithClientTier,
  sendExtensionPublicRateLimitResponse,
} from "../lib/brokerageExtensionPublic";
import {
  assertComputeAllowed,
  clientEntitlementFromSnapshot,
  resolveEntitlementSnapshot,
  sendBriefUpgradeRequiredResponse,
  type ClientEntitlementSnapshot,
} from "../lib/brokerageWallet";
import {
  findWorkspaceByListingKey,
  listingKeyFromAddress,
  listingKeyCandidates,
  upsertWorkspaceFromBrief,
} from "../lib/brokerageWorkspace";
import {
  briefRunAccessibleToCaller,
  listClaimedInstallIdsForUser,
} from "../lib/brokerageInstallClaim";
import {
  buildBriefAtomProjection,
  buildPropertyWorkspaceDid,
  extractLlUuidFromSiteContext,
} from "../lib/brokerageBriefAtoms";
import {
  buildInvestorVerdict,
  type InvestorProfileBuyBox,
} from "../lib/brokerageInvestorVerdict";
import {
  computePencilsAt,
  extractPencilsInputsFromLayers,
} from "../lib/brokeragePencilsAt";
import {
  getOrCreateBrokerageUserProfile,
  packageTierFromProfile,
} from "../lib/brokerageUserProfile";
import {
  captureParcelKey,
  parcelKeyKind as classifyParcelKey,
} from "../lib/brokerageParcelKey";
import {
  resolveInvestorPackageTier,
  depthMeterAllowance,
} from "../lib/brokerageTierGate";
import { entitlementPackageTier } from "../lib/brokerageEntitlement";
import {
  buildPrivateRestrictionsBriefing,
  formatPrivateRestrictionsForLlm,
} from "../lib/encumbranceWire";
import { loadEncumbrancesForBrokerageWorkspace } from "../lib/encumbranceService";
import { listingKeyFromWorkspaceDid } from "../lib/encumbranceScope";
import {
  emitBriefRunGeneratedEvent,
  emitPropertyWorkspaceCreatedEvent,
} from "../lib/brokerageBriefEvents";
import { brokerageCoverageRouter } from "./brokerageCoverage";
import { brokerageCoveragePublicCors } from "../middlewares/brokerageCoverageCors";
import { brokerageGtmRouter } from "./brokerageGtm";
import { brokerageProfileRouter } from "./brokerageProfile";
import { brokeragePlaceRouter } from "./brokeragePlace";
import { brokerageWorkspaceRouter } from "./brokerageWorkspace";
import { brokerageEncumbrancesRouter } from "./brokerageEncumbrances";
import { brokerageWalletRouter } from "./brokerageWalletRoute";
import { brokerageEntitlementRouter } from "./brokerageEntitlementRoute";
import { brokerageAdminGraphRouter } from "./brokerageAdminGraph";
import { brokerageOperatorRouter } from "./operatorRunState";
import {
  RESEARCH_AREA_CONTEXT,
  formatResearchAreaContextForLlm,
  formatSubjectConstraintsForLlm,
  isAreaResearchChatEligible,
} from "../lib/brokerageResearchAreaContext";
import { brokeragePlaceHydrologyRouter } from "./brokeragePlaceHydrology";
import { brokeragePlaceBuildableEnvelopeRouter } from "./brokeragePlaceBuildableEnvelope";
import { brokeragePlaceSitusSearchRouter } from "./brokeragePlaceSitusSearch";
import { brokerageMapDataRouter } from "./brokerageMapData";
import { brokerageBillingRouter } from "./brokerageBilling";
import { propertyExplorerBillingRouter } from "./propertyExplorerBilling";
import { brokerageBillingPublicRouter } from "./brokerageBillingPublic";
import { brokerageNodeFacetsRouter } from "./brokerageNodeFacets";
import {
  BROKERAGE_BRIEF_BILLABLE_HEADER,
  brokerageBriefMeteringMeta,
} from "../lib/brokerageMetering";
import { UUID_RE } from "../lib/lSurfaceRoute";
import {
  PE_FREE_CHAT_MESSAGE_LIMIT,
  consumePeFreeChatMessage,
  isPePropertyEntitled,
  resolvePeOwnerUserId,
} from "../lib/peEntitlement";
import { buildBrokerageBriefProvenanceEnvelope } from "../lib/brokerageProvenanceEnvelope";
import {
  BRIEF_WEB_SCRAPED_DISCLOSURE,
  resolveBriefLocalCodeLayer,
} from "../lib/brokerageBriefLocalCode";
import { resolveResearchChatWebSearchBackup } from "../lib/brokerageResearchChatWebSearch";
import {
  isBrokerageBriefViaGateEnabled,
} from "../lib/brokerageSpineGate";

import { BROKERAGE_CODE_QUERIES } from "../lib/brokerageCodeQueries";

export { BROKERAGE_CODE_QUERIES };

/** Extra retrieval when research chat or starter focuses on ADUs. */
export const BROKERAGE_ADU_RESEARCH_QUERIES = [
  "accessory dwelling unit ADU secondary unit requirements",
  "guest house backyard cottage zoning",
] as const;

const ADU_TOPIC_RE =
  /\b(adu|accessory dwelling|guest house|backyard cottage|secondary unit|additional unit|granny flat|subdivision)\b/i;

const presentationModeSchema = z.enum(["consumer", "pro"]).default("consumer");

const starterFields = {
  starterPromptId: z.enum(STARTER_PROMPT_IDS).optional(),
  personaBucket: z.enum(PERSONA_BUCKETS).optional(),
};

const BRIEF_BODY = z.object({
  address: z.string().min(1),
  mls_id: z.string().optional(),
  source: z.string().optional(),
  page_url: z.string().optional(),
  presentationMode: presentationModeSchema.optional(),
  ...starterFields,
});

const SUMMARIZE_BODY = z.object({
  address: z.string().min(1),
  jurisdiction: z.string().optional(),
  corpusStatus: z.string().optional(),
  atoms: z.array(
    z.object({
      atomDid: z.string().min(1),
      snippet: z.string(),
    }),
  ),
});

const RESEARCH_CHAT_BASE = z.object({
  message: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  presentationMode: presentationModeSchema.optional(),
  areaContext: RESEARCH_AREA_CONTEXT,
  /**
   * PE workbench call classification (LOCK 2026-07-29): `"summary"` marks
   * the WB6 chat-summary call — part of PAID chat, requires the
   * property-scoped entitlement and never consumes a free message.
   * Absent / `"chat"` = a normal user chat turn.
   */
  purpose: z.enum(["chat", "summary"]).optional(),
  ...starterFields,
});

/** Follow-up chat: brief run selector and/or map area context for portfolio questions. */
const RESEARCH_CHAT_BODY = RESEARCH_CHAT_BASE.extend({
  runId: z.string().uuid().optional(),
  address: z.string().min(1).optional(),
  mls_id: z.string().optional(),
  workspaceDid: z.string().min(1).optional(),
}).superRefine((data, ctx) => {
  const hasRunSelector = Boolean(
    data.runId || data.address || data.workspaceDid,
  );
  if (!hasRunSelector && !isAreaResearchChatEligible(data.areaContext)) {
    ctx.addIssue({
      code: "custom",
      message:
        "Provide runId, address, workspaceDid, or areaContext (scope=area or visibleParcels)",
      path: ["runId"],
    });
  }
});

const router: IRouter = Router();
const brokerageV1: IRouter = Router();

router.use(
  "/brokerage/v1/coverage",
  brokerageCoveragePublicCors,
  brokerageCoverageRouter,
);

/** Bundled entry is `dist/index.mjs`; `../public` is `artifacts/api-server/public`. */
const BRIEF_COVERAGE_HTML_CANDIDATES = [
  join(process.cwd(), "artifacts/api-server/public/brief-coverage.html"),
  join(process.cwd(), "public/brief-coverage.html"),
  join(dirname(fileURLToPath(import.meta.url)), "../public/brief-coverage.html"),
];

let briefCoverageHtmlCache: string | null | undefined;

function loadBriefCoverageHtml(): string | null {
  if (briefCoverageHtmlCache !== undefined) return briefCoverageHtmlCache;

  const path = BRIEF_COVERAGE_HTML_CANDIDATES.find((candidate) =>
    existsSync(candidate),
  );
  if (!path) {
    logger.warn(
      { candidates: BRIEF_COVERAGE_HTML_CANDIDATES },
      "brief-coverage: static HTML not found",
    );
    briefCoverageHtmlCache = null;
    return null;
  }

  try {
    briefCoverageHtmlCache = readFileSync(path, "utf8");
    return briefCoverageHtmlCache;
  } catch (err) {
    logger.warn({ err, path }, "brief-coverage: failed to read static HTML");
    briefCoverageHtmlCache = null;
    return null;
  }
}

/** Static host for brief.hauska.dev/coverage (same origin as cortex-api). */
router.get("/brief-coverage", (_req: Request, res: Response) => {
  const html = loadBriefCoverageHtml();
  if (!html) {
    res.status(503).type("text/plain").send("Coverage page unavailable");
    return;
  }
  res.type("html").send(html);
});

brokerageV1.use(brokerageCors);
/** GTM consent/events use {@link brokerageAuth} only — extension wedge, no service token. */
brokerageV1.use("/gtm", brokerageGtmRouter);
/** Property Explorer checkout seam — service token + install id (WDLL 26). */
brokerageV1.use("/property-explorer/billing", propertyExplorerBillingRouter);
/** Stripe checkout return pages — reachable without extension API key. */
brokerageV1.use("/billing", brokerageBillingPublicRouter);
/**
 * Baked node-facet inspect-card read — the map's anonymous, NO-AI,
 * NO-live-compute pure-read source for a parcel's Tier-1 facets. Mounted
 * BEFORE the auth gate (peer of `/gtm` + `/billing` public) because browse is
 * a public-tier read that requires no API key. Owner is never in the response
 * (bake never wrote it; the route strips owner-shaped keys defense-in-depth).
 * Mounts `/place/node/:parcelNodeId/facets`.
 */
brokerageV1.use("/place", brokerageNodeFacetsRouter);
brokerageV1.use(requireBrokerageAuthOrServiceToken);
brokerageV1.use("/profile", brokerageProfileRouter);
brokerageV1.use("/coverage", brokerageCoverageRouter);
brokerageV1.use("/place", brokeragePlaceHydrologyRouter);
brokerageV1.use("/place", brokeragePlaceBuildableEnvelopeRouter);
brokerageV1.use("/place", brokeragePlaceSitusSearchRouter);
brokerageV1.use("/place", brokeragePlaceRouter);
brokerageV1.use("/map-data", brokerageMapDataRouter);
brokerageV1.use("/workspaces", brokerageEncumbrancesRouter);
brokerageV1.use("/workspaces", brokerageWorkspaceRouter);
brokerageV1.use("/wallet", brokerageWalletRouter);
brokerageV1.use("/entitlement", brokerageEntitlementRouter);
brokerageV1.use("/billing", brokerageBillingRouter);
brokerageV1.use("/admin", brokerageAdminGraphRouter);
// Command-center Run Monitor — operator run-state status. Mounts
// `/operator/warming/status`; inherits the requireBrokerageAuthOrServiceToken
// gate above (the console proxy attaches the service Bearer server-side), so it
// is never anonymous.
brokerageV1.use("/operator", brokerageOperatorRouter);

async function resolveResearchChatRun(input: {
  runId?: string;
  address?: string;
  mls_id?: string;
  workspaceDid?: string;
  installId: string | null;
  serviceCaller: boolean;
  ownerUserId?: string | null;
  claimedInstallIds?: readonly string[];
}): Promise<(typeof brokerageBriefRuns.$inferSelect) | null> {
  const claimedInstallIds = new Set(input.claimedInstallIds ?? []);
  if (input.installId) claimedInstallIds.add(input.installId);
  const ownerUserId = input.ownerUserId ?? null;

  const runAccessible = (run: typeof brokerageBriefRuns.$inferSelect) =>
    briefRunAccessibleToCaller({
      run,
      requestInstallId: input.installId,
      serviceCaller: input.serviceCaller,
      ownerUserId,
      claimedInstallIds,
    });

  if (input.runId) {
    const [run] = await db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.id, input.runId))
      .limit(1);
    if (!run || !runAccessible(run)) return null;
    return run;
  }

  const listingKeys: string[] = [];
  if (input.workspaceDid) {
    const workspaceKey = listingKeyFromWorkspaceDid(input.workspaceDid);
    if (workspaceKey) listingKeys.push(workspaceKey);
  } else if (input.address) {
    listingKeys.push(...listingKeyCandidates(input.address, input.mls_id));
  }
  if (!listingKeys.length) return null;

  if (!input.installId && !input.serviceCaller && !ownerUserId) return null;

  if (input.installId && !ownerUserId) {
    for (const listingKey of listingKeys) {
      const [run] = await db
        .select()
        .from(brokerageBriefRuns)
        .where(
          and(
            eq(brokerageBriefRuns.listingKey, listingKey),
            eq(brokerageBriefRuns.installId, input.installId),
          ),
        )
        .orderBy(desc(brokerageBriefRuns.createdAt))
        .limit(1);
      if (run && runAccessible(run)) return run;
    }
  }

  if (ownerUserId) {
    for (const listingKey of listingKeys) {
      const [run] = await db
        .select()
        .from(brokerageBriefRuns)
        .where(
          and(
            eq(brokerageBriefRuns.listingKey, listingKey),
            eq(brokerageBriefRuns.ownerUserId, ownerUserId),
          ),
        )
        .orderBy(desc(brokerageBriefRuns.createdAt))
        .limit(1);
      if (run && runAccessible(run)) return run;
    }

    if (claimedInstallIds.size > 0) {
      for (const listingKey of listingKeys) {
        const [run] = await db
          .select()
          .from(brokerageBriefRuns)
          .where(
            and(
              eq(brokerageBriefRuns.listingKey, listingKey),
              inArray(brokerageBriefRuns.installId, [...claimedInstallIds]),
            ),
          )
          .orderBy(desc(brokerageBriefRuns.createdAt))
          .limit(1);
        if (run && runAccessible(run)) return run;
      }
    }
  }

  for (const listingKey of listingKeys) {
    const [run] = await db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.listingKey, listingKey))
      .orderBy(desc(brokerageBriefRuns.createdAt))
      .limit(1);
    if (!run || !runAccessible(run)) continue;
    return run;
  }

  return null;
}

function logStarterPromptSelected(
  req: Request,
  input: {
    installId: string | null;
    starterPromptId: StarterPromptId;
    personaBucket?: PersonaBucket;
    runId: string;
    address: string;
    mlsId?: string | null;
  },
) {
  if (!input.installId) return;
  const addressHash = listingKeyFromAddress(input.address, input.mlsId);
  recordGtmEvent({
    installId: input.installId,
    eventType: "starter_prompt_selected",
    runId: input.runId,
    listingKey: addressHash,
    payload: gtmPayloadWithClientTier(req, {
      starterPromptId: input.starterPromptId,
      personaBucket: input.personaBucket ?? null,
      addressHash,
    }),
  });
}

function sectionTitle(query: string): string {
  const first = query.split(" ")[0] ?? query;
  return first.toUpperCase() + query.slice(first.length, 40);
}

function atomSnippet(atom: RetrievedAtom): string {
  const title = atom.sectionTitle?.trim();
  const body = atom.body?.trim() ?? "";
  if (title && body) return `${title}: ${body}`.slice(0, 500);
  return (body || title || "").slice(0, 500);
}

function toBriefAtom(atom: RetrievedAtom, label?: string): BriefAtomInput {
  const sectionLabel =
    atom.sectionTitle?.trim() ||
    (atom.sectionNumber ? `§${atom.sectionNumber}` : null) ||
    atom.codeBook ||
    "Municipal code";
  return {
    atomDid: atom.id,
    snippet: atomSnippet(atom),
    label: label ?? sectionLabel,
    ...(atom.sourceUrl ? { sourceUrl: atom.sourceUrl } : {}),
    // Retrieval strength passthrough for grounding-derived confidence (see
    // computeGroundingConfidence in lib/brokerageBriefLlm.ts). Additive.
    ...(typeof atom.score === "number" ? { score: atom.score } : {}),
    ...(atom.retrievalMode ? { retrievalMode: atom.retrievalMode } : {}),
  };
}

type BriefComputeGateResult =
  | { ok: true; entitlement: ClientEntitlementSnapshot | null }
  | { ok: false };

async function enforceBriefComputeGate(
  req: Request,
  res: Response,
  input: {
    installId: string | null;
    extensionPublic: boolean;
    serviceCaller: boolean;
    rateLimit?: (installId: string) => Promise<
      Awaited<ReturnType<typeof assertExtensionPublicBriefAllowed>>
    >;
  },
): Promise<BriefComputeGateResult> {
  if (input.serviceCaller) {
    return { ok: true, entitlement: null };
  }

  if (input.extensionPublic) {
    if (!input.installId) {
      res.status(400).json({
        error: "install_id_required",
        message: "X-Hauska-Install-Id header is required",
      });
      return { ok: false };
    }
    if (input.rateLimit) {
      const rateLimit = await input.rateLimit(input.installId);
      if (!rateLimit.ok) {
        sendExtensionPublicRateLimitResponse(res, rateLimit);
        return { ok: false };
      }
    }
  }

  if (!input.installId) {
    const ent = await resolveEntitlementSnapshot(req);
    return {
      ok: true,
      entitlement: ent ? clientEntitlementFromSnapshot(ent) : null,
    };
  }

  const resolvedEnt = await resolveEntitlementSnapshot(req);
  if (resolvedEnt?.paidActive) {
    return {
      ok: true,
      entitlement: clientEntitlementFromSnapshot(resolvedEnt),
    };
  }

  const debit = await assertComputeAllowed(input.installId);
  if (!debit.ok) {
    recordGtmEvent({
      installId: input.installId,
      eventType: "paywall_hit",
      payload: gtmPayloadWithClientTier(req, {
        freeBriefsUsed: debit.freeBriefsUsed,
        freeBriefsCap: debit.freeBriefsCap,
        balanceCents: debit.balanceCents,
      }),
    });
    sendBriefUpgradeRequiredResponse(res, debit);
    return { ok: false };
  }

  // Re-fetch after debit so entitlement reflects consumed free briefs /
  // wallet balance — the pre-debit snapshot would still show the cap.
  const ent = await resolveEntitlementSnapshot(req);
  return {
    ok: true,
    entitlement: ent ? clientEntitlementFromSnapshot(ent) : null,
  };
}

brokerageV1.post("/brief", async (req: Request, res: Response) => {
  const parse = BRIEF_BODY.safeParse(req.body);
  if (!parse.success) {
    res
      .status(400)
      .json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          "Invalid brief body",
        ),
      );
    return;
  }

  const {
    address,
    mls_id,
    source,
    page_url,
    presentationMode = "consumer",
    starterPromptId,
    personaBucket,
  } = parse.data;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const installId = installIdFromRequest(req);
  const lk = listingKeyFromAddress(address, mls_id);
  const extensionPublic = isExtensionPublicClient(req);
  const authenticatedUser =
    req.brokerageAuth?.tier === "user" &&
    req.session?.requestor?.kind === "user"
      ? req.session.requestor.id
      : null;
  const serviceCaller = isBrokerageServiceCaller(req);
  const spineViaGate = isBrokerageBriefViaGateEnabled();

  const computeGate = await enforceBriefComputeGate(req, res, {
    installId,
    extensionPublic,
    serviceCaller,
    rateLimit: extensionPublic ? assertExtensionPublicBriefAllowed : undefined,
  });
  if (!computeGate.ok) return;

  if (installId && starterPromptId) {
    logStarterPromptSelected(req, {
      installId,
      starterPromptId,
      personaBucket,
      runId,
      address,
      mlsId: mls_id,
    });
  }

  if (installId) {
    recordGtmEvent({
      installId,
      eventType: "brief_started",
      runId,
      listingKey: lk,
      payload: gtmPayloadWithClientTier(req, { source: source ?? null }),
    });
  }

  let geocode: {
    lat: number;
    lon: number;
    city?: string | null;
    state?: string | null;
    error?: string;
  } | null = null;

  try {
    const geo = await geocodeAddress(address);
    if (geo) {
      geocode = {
        lat: geo.latitude,
        lon: geo.longitude,
        city: geo.jurisdictionCity,
        state: geo.jurisdictionState,
      };
    }
  } catch (err) {
    geocode = { lat: 0, lon: 0, error: String((err as Error).message || err) };
  }

  const localCodeLayer = await resolveBriefLocalCodeLayer({
    address,
    jurisdictionCity: geocode?.city ?? null,
    jurisdictionState: geocode?.state ?? null,
  });
  const jurisdictionKey = localCodeLayer.jurisdictionKey;
  const sections = localCodeLayer.sections;
  const citations = localCodeLayer.citations;
  const retrievedAtomsForProvenance = localCodeLayer.retrievedAtoms;
  const corpusStatus = localCodeLayer.corpusStatus;
  const localCodeCoverage = localCodeLayer.coverage;
  const localCodeSource = localCodeLayer.localCodeSource;
  const substrateStatus = localCodeLayer.substrateStatus;
  const degradedReasons = localCodeLayer.degradedReasons;
  const finishedAt = new Date().toISOString();

  let profileRow = null;
  if (authenticatedUser) {
    profileRow = await getOrCreateBrokerageUserProfile(authenticatedUser);
  }
  const entitlementSnapshot = await resolveEntitlementSnapshot(req);
  const entitlementTier = entitlementSnapshot
    ? entitlementPackageTier(entitlementSnapshot)
    : null;
  const packageTier = resolveInvestorPackageTier({
    brokerageAuthTier: req.brokerageAuth?.tier ?? null,
    profileTier: packageTierFromProfile(profileRow),
    entitlementTier,
  });
  const depthMeterRemaining =
    profileRow?.depthMeterRemaining ?? depthMeterAllowance(packageTier);

  let parcelCapture = null;
  if (geocode && Number.isFinite(geocode.lat) && Number.isFinite(geocode.lon)) {
    try {
      parcelCapture = await captureParcelKey({
        address,
        latitude: geocode.lat,
        longitude: geocode.lon,
        city: geocode.city,
        state: geocode.state,
        source: "address-geocode",
      });
    } catch (err) {
      logger.warn({ err, address }, "brokerage: parcel key capture failed");
    }
  }

  let siteContext: Awaited<ReturnType<typeof fetchBrokerageSiteContext>> = {
    layers: [],
    placeKey: "coord:0.00000:0.00000",
    packageTier,
  };
  if (geocode && Number.isFinite(geocode.lat) && Number.isFinite(geocode.lon)) {
    try {
      siteContext = await fetchBrokerageSiteContext({
        latitude: geocode.lat,
        longitude: geocode.lon,
        address,
        jurisdictionCity: geocode.city,
        jurisdictionState: geocode.state,
        packageTier,
        brokerageAuthTier: req.brokerageAuth?.tier ?? null,
        depthMeterRemaining,
      });
    } catch (err) {
      logger.warn({ err, address }, "brokerage: site context layers failed");
    }
  }

  const briefAtoms: BriefAtomInput[] = [];
  for (const s of sections) {
    const top = s.hits[0];
    if (top) {
      briefAtoms.push({
        atomDid: top.atomDid,
        snippet: top.snippet,
        label: sectionTitle(s.query),
      });
    }
  }

  let privateRestrictions = null;
  let privateRestrictionsBlock = "";
  if (installId && !extensionPublic) {
    const enc = await loadEncumbrancesForBrokerageWorkspace({
      installId,
      listingKey: lk,
    });
    privateRestrictions = buildPrivateRestrictionsBriefing(
      enc.instruments,
      enc.clauses,
    );
    privateRestrictionsBlock = formatPrivateRestrictionsForLlm(privateRestrictions);
  }

  const reasoningSummary = await generateReasoningSummary({
    address,
    jurisdiction: jurisdictionKey,
    corpusStatus,
    atoms: briefAtoms,
    finishedAt,
    siteContext,
    privateRestrictionsBlock,
  });

  const laySummary = await generateLaySummary({
    address,
    jurisdiction: jurisdictionKey,
    corpusStatus,
    atoms: briefAtoms,
    siteContext,
    presentationMode,
    finishedAt,
  });

  const llUuid = extractLlUuidFromSiteContext(siteContext);
  const parcelClip = siteContext.parcelClip ?? parcelCapture?.clip ?? llUuid ?? null;
  // Provider-neutral join key: CLIP when any rail produced one, else the
  // captured apn:/geo: key. Null only when capture and site-context both
  // failed to produce any parcel identity.
  const parcelKey = parcelClip ?? parcelCapture?.parcelKey ?? null;

  const buyBox = (profileRow?.buyBoxJson ?? {}) as {
    capRateFloor?: number;
    rehabPerSf?: number;
    rentSpreadTolerance?: number;
  };
  const pencilsInputs = extractPencilsInputsFromLayers(siteContext.layers);
  const resolvedBuyBox: InvestorProfileBuyBox = {
    capRateFloor: buyBox.capRateFloor ?? 0.08,
    rehabPerSf: buyBox.rehabPerSf ?? 35,
    rentSpreadTolerance: buyBox.rentSpreadTolerance ?? 0.05,
  };
  const pencilsAt = computePencilsAt({
    buyBox: {
      ...resolvedBuyBox,
      annualInsurance: pencilsInputs.annualInsurance,
    },
    ...pencilsInputs,
  });
  const investorVerdict = buildInvestorVerdict({
    layers: siteContext.layers,
    corpusStatus,
    buyBox: resolvedBuyBox,
    finishedAt,
  });

  const precedenceStatus = {
    wired: false,
    note: "Plan-review precedence resolver is not yet wired on the Property Brief path — 61 audit gap; reasoning cites code atoms only.",
  };

  const workspaceDid = buildPropertyWorkspaceDid(lk);
  const atoms = buildBriefAtomProjection({
    listingKey: lk,
    runId,
    address,
    siteContext,
    citations,
    placeKey: siteContext.placeKey,
    privateRestrictions,
  });

  const provenance = buildBrokerageBriefProvenanceEnvelope({
    citations,
    atoms: retrievedAtomsForProvenance.map((a) => ({
      atomDid: a.id,
      sourceUrl: a.sourceUrl,
      edition: a.edition,
      codeBook: a.codeBook,
    })),
    finishedAt,
    jurisdictionKey,
    corpusStatus,
    reasoningMethod: reasoningSummary.method,
    spineViaGate,
    coverage: localCodeCoverage,
    localCodeSource,
  });

  const responseBody = {
    runId,
    startedAt,
    finishedAt,
    presentationMode,
    provenance,
    property: {
      address,
      source: source ?? null,
      url: page_url ?? null,
      llUuid: parcelClip ?? undefined,
      parcelClip: parcelClip ?? undefined,
      parcelKey: parcelKey ?? undefined,
      // Kind derives from the key that actually won (site-context CLIP
      // outranks the captured apn:/geo: key), never from the capture's
      // own kind — a mixed state must not label a CLIP as "apn".
      parcelKeyKind: parcelKey ? classifyParcelKey(parcelKey) : null,
      parcelKeySource: parcelCapture?.source ?? null,
      apn: parcelCapture?.apn ?? null,
      countyFips: parcelCapture?.countyFips ?? null,
      parcelKeyProvenance: parcelCapture?.provenance ?? null,
    },
    jurisdiction: jurisdictionKey,
    corpusStatus,
    localCodeSource,
    substrateStatus,
    degradedReasons,
    coverage: localCodeCoverage,
    packageTier,
    precedenceStatus,
    pencilsAt,
    investorVerdict,
    geocode: geocode
      ? { lat: geocode.lat, lon: geocode.lon }
      : undefined,
    siteContext,
    sections,
    citations,
    atoms,
    reasoningSummary,
    laySummary,
    privateRestrictions,
    meta: {
      disclaimer:
        localCodeSource === "websearch"
          ? `${BRIEF_WEB_SCRAPED_DISCLOSURE}. Not legal advice — verify with city staff.`
          : "Not legal advice. Code layer only where jurisdiction is in corpus. Verify with city staff.",
      tool: "property-brief-v1",
      ...(serviceCaller ? brokerageBriefMeteringMeta() : {}),
      ...(extensionPublic
        ? {
            clientTier: "extension_public" as const,
            encumbranceUploadCta: {
              label: "Upload CC&Rs",
              workspaceDid,
              requestPath:
                "/api/brokerage/v1/workspaces/encumbrances/request-upload-url",
              completePath:
                "/api/brokerage/v1/workspaces/encumbrances/complete-upload",
              maxBytes: 25 * 1024 * 1024,
              contentType: "application/pdf",
            },
          }
        : {
            encumbranceUploadCta: {
              label: "Upload CC&Rs",
              workspaceDid,
              uploadPath: "/api/brokerage/v1/workspaces/encumbrances/upload",
              listPath: "/api/brokerage/v1/workspaces/encumbrances",
            },
          }),
    },
  };

  await db.insert(brokerageBriefRuns).values({
    id: runId,
    tenantSlug: "default",
    listingKey: lk,
    address,
    payloadJson: responseBody,
    installId: installId ?? null,
    ownerUserId: authenticatedUser,
  });

  await emitPropertyWorkspaceCreatedEvent({
    listingKey: lk,
    address,
    llUuid,
    latitude: geocode?.lat,
    longitude: geocode?.lon,
  });
  await emitBriefRunGeneratedEvent({
    listingKey: lk,
    runId,
    address,
    jurisdictionKey,
    corpusStatus,
    citationCount: citations.length,
  });

  let workspaceId: string | undefined;

  if (installId && (!extensionPublic || authenticatedUser)) {
    await upsertWorkspaceFromBrief({
      installId,
      listingKey: lk,
      address,
      sourceListingUrl: page_url ?? null,
      runId,
      // Parcel join key for the workspace: CLIP when available (legacy
      // key space), else the neutral apn:/geo: key so a dark Cotality
      // rail no longer strands workspaces with no parcel identity.
      llUuid: parcelKey,
      latitude: geocode?.lat,
      longitude: geocode?.lon,
      ownerUserId: authenticatedUser ?? undefined,
    });

    const ws = await findWorkspaceByListingKey(installId, lk);
    workspaceId = ws?.id;

    if (geocode && Number.isFinite(geocode.lat) && Number.isFinite(geocode.lon)) {
      recordGtmEvent({
        installId,
        eventType: "session_geo",
        runId,
        listingKey: lk,
        payload: gtmPayloadWithClientTier(req, {
          lat: geocode.lat,
          lon: geocode.lon,
        }),
      });
    }

    recordGtmEvent({
      installId,
      eventType: "brief_completed",
      runId,
      listingKey: lk,
      payload: gtmPayloadWithClientTier(req, {
        corpusStatus,
        jurisdiction: jurisdictionKey,
        citationCount: citations.length,
      }),
    });
  }

  if (serviceCaller) {
    res.setHeader(BROKERAGE_BRIEF_BILLABLE_HEADER, "property-brief-v1");
  }

  res.json({
    ...responseBody,
    siteContext: stripSiteContextForClient(siteContext),
    ...(computeGate.entitlement ? { entitlement: computeGate.entitlement } : {}),
    ...(workspaceId && !extensionPublic && !serviceCaller
      ? { workspaceId, workspaceDid }
      : {}),
  });
});

brokerageV1.get("/brief/:runId", async (req: Request, res: Response) => {
  const runId =
    typeof req.params.runId === "string" ? req.params.runId.trim() : "";
  if (!UUID_RE.test(runId)) {
    res.status(400).json({
      error: "invalid_request",
      message: "Invalid brief runId",
    });
    return;
  }

  const [run] = await db
    .select()
    .from(brokerageBriefRuns)
    .where(eq(brokerageBriefRuns.id, runId))
    .limit(1);

  if (!run) {
    res.status(404).json({ error: "not_found", message: "Brief run not found" });
    return;
  }

  const payload = run.payloadJson as Record<string, unknown>;
  res.json(stripBriefPayloadForClient(payload));
});

brokerageV1.post(
  "/brief/summarize",
  async (req: Request, res: Response) => {
    const parse = SUMMARIZE_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_request",
        message: "Invalid summarize body",
      });
      return;
    }

    const { address, jurisdiction, corpusStatus, atoms } = parse.data;
    const result = await generateSummarize({
      address,
      jurisdiction: jurisdiction ?? null,
      corpusStatus: corpusStatus ?? "unknown",
      atoms: atoms.map((a, i) => ({
        atomDid: a.atomDid,
        snippet: a.snippet,
        label: `Source ${i + 1}`,
      })),
    });

    res.json(result);
  },
);

brokerageV1.post(
  "/research/chat",
  async (req: Request, res: Response) => {
    const parse = RESEARCH_CHAT_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_request",
        message: "Invalid research chat body",
        details: parse.error.flatten(),
        accepted: {
          required: ["message"],
          runSelector:
            "runId (uuid) OR address OR workspaceDid OR areaContext (scope=area | visibleParcels)",
          optional: [
            "history",
            "presentationMode",
            "starterPromptId",
            "personaBucket",
            "mls_id",
            "areaContext",
            "purpose",
          ],
        },
      });
      return;
    }

    const {
      message,
      history,
      presentationMode = "consumer",
      starterPromptId,
      personaBucket,
      areaContext,
      purpose,
      runId: runIdField,
      address: addressField,
      mls_id: mlsIdField,
      workspaceDid: workspaceDidField,
    } = parse.data;

    const installId = installIdFromRequest(req);
    const extensionPublic = isExtensionPublicClient(req);
    const serviceCaller = isBrokerageServiceCaller(req);

    if (serviceCaller) {
      // MCP service path — gate owns metering; no install id or wallet debit.
    } else if (extensionPublic) {
      if (!installId) {
        res.status(400).json({
          error: "install_id_required",
          message: "X-Hauska-Install-Id header is required",
        });
        return;
      }

      const rateLimit = await assertExtensionPublicResearchChatAllowed(installId);
      if (!rateLimit.ok) {
        sendExtensionPublicRateLimitResponse(res, rateLimit);
        return;
      }
    } else if (installId) {
      const ent = await resolveEntitlementSnapshot(req);
      if (!ent?.paidActive) {
        const debit = await assertComputeAllowed(installId);
        if (!debit.ok) {
          sendBriefUpgradeRequiredResponse(res, debit);
          return;
        }
      }
    } else {
      // PE-session branch (LOCK 2026-07-29) — signed-in Property Explorer
      // web user: session bearer, no install id, not the MCP service path.
      // Server-enforced per-property gate: entitled (Pro / property
      // unlocked / dev bypass) chats unlimited and uncounted; the free
      // tier gets PE_FREE_CHAT_MESSAGE_LIMIT server-counted messages per
      // property. Unauthenticated API-key callers (operator tier) fall
      // through unchanged; the extension_public and service branches
      // above are untouched.
      const peUserId = resolvePeOwnerUserId(req);
      if (peUserId) {
        const peParcelNodeId =
          areaContext?.subject?.parcelNodeId?.trim() || null;
        let peEntitled = await isPePropertyEntitled(peUserId, peParcelNodeId);
        if (!peEntitled) {
          // Regression guard for the install-less web-portal path: an
          // active brokerage Pro/Max subscription (user-aware across
          // claimed installs) still counts as paid chat access.
          const brokerageEnt = await resolveEntitlementSnapshot(req);
          if (brokerageEnt?.paidActive) peEntitled = true;
        }
        if (purpose === "summary") {
          // WB6 chat-summary is part of PAID chat: requires the
          // property-scoped entitlement, never consumes a free message.
          if (!peEntitled) {
            res.status(402).json({
              error: "upgrade_required",
              message:
                "The property summary is part of paid chat — unlock this property or go Pro.",
              ...(peParcelNodeId
                ? { property: { parcelNodeId: peParcelNodeId, unlocked: false } }
                : {}),
            });
            return;
          }
        } else if (!peEntitled) {
          if (!peParcelNodeId) {
            // Honest wall: without a parcel to meter against there is no
            // free allowance to spend — never uncounted free usage.
            res.status(402).json({
              error: "upgrade_required",
              message:
                "Free messages are metered per property and this chat has no property attached — select a property, unlock it, or go Pro.",
              freeMessagesLimit: PE_FREE_CHAT_MESSAGE_LIMIT,
            });
            return;
          }
          const consumed = await consumePeFreeChatMessage(
            peUserId,
            peParcelNodeId,
          );
          if (!consumed.allowed) {
            res.status(402).json({
              error: "free_messages_exhausted",
              message:
                "Free messages used for this property — unlock it or go Pro.",
              freeMessagesUsed: consumed.used,
              freeMessagesLimit: PE_FREE_CHAT_MESSAGE_LIMIT,
            });
            return;
          }
        }
      }
    }

    const ownerUserId = authenticatedBrokerageUserId(req);
    const claimedInstallIds = ownerUserId
      ? await listClaimedInstallIdsForUser(ownerUserId)
      : [];

    const run = await resolveResearchChatRun({
      runId: runIdField,
      address: addressField,
      mls_id: mlsIdField,
      workspaceDid: workspaceDidField,
      installId,
      serviceCaller,
      ownerUserId,
      claimedInstallIds,
    });

    const areaEligible = isAreaResearchChatEligible(areaContext);

    if (!run && !areaEligible) {
      res.status(404).json({
        error: "not_found",
        message: runIdField
          ? "Brief run not found"
          : "No brief run for this property — POST /api/brokerage/v1/brief first",
      });
      return;
    }

    const runId = run?.id ?? null;

    const payload = (run?.payloadJson ?? {}) as {
      jurisdiction?: string | null;
      property?: { address?: string };
      citations?: Array<{ atomDid: string; snippet?: string; query?: string }>;
      sections?: Array<{
        hits?: Array<{ atomDid: string; snippet: string }>;
      }>;
    };

    const address =
      payload.property?.address ??
      run?.address ??
      areaContext?.visibleParcels?.[0]?.address ??
      (areaEligible ? "Map selection" : "");

    // Canonicalize the retrieval jurisdiction key. The corpus persists every
    // code atom under a REGISTERED slug (e.g. `bastrop_tx`), and
    // retrieveAtomsForQuestion filters with an EXACT eq() on that key. The
    // Property Explorer client supplies areaContext.jurisdictionKey derived
    // from the zoning-stamp source adapter suffix ("txgio-zoning-stamp:
    // bastrop-city-tx" -> "bastrop-city-tx"), which is NOT the corpus slug —
    // so trusting it verbatim made retrieval return zero atoms and the chat
    // answered with no citations. Resolve a registered key from the property
    // address the same way the brief does (keyFromEngagement), then fall back
    // to a stored run key, then to the raw client key as a last resort.
    const jurisdictionKey =
      payload.jurisdiction ??
      keyFromEngagement({
        jurisdiction: areaContext?.jurisdictionKey ?? null,
        address,
      }) ??
      areaContext?.jurisdictionKey ??
      null;

    if (installId && starterPromptId && runId) {
      logStarterPromptSelected(req, {
        installId,
        starterPromptId,
        personaBucket,
        runId,
        address,
      });
    }

    const atomMap = new Map<string, BriefAtomInput>();
    const degradedReasons: string[] = [];

    for (const c of payload.citations ?? []) {
      if (c.atomDid && !atomMap.has(c.atomDid)) {
        atomMap.set(c.atomDid, {
          atomDid: c.atomDid,
          snippet: c.snippet ?? "",
          label: c.query?.slice(0, 40) ?? "Prior brief",
        });
      }
    }
    for (const sec of payload.sections ?? []) {
      for (const h of sec.hits ?? []) {
        if (h.atomDid && !atomMap.has(h.atomDid)) {
          atomMap.set(h.atomDid, {
            atomDid: h.atomDid,
            snippet: h.snippet,
          });
        }
      }
    }

    if (jurisdictionKey) {
      const district =
        areaContext?.subject?.setbacks?.district ??
        areaContext?.visibleParcels?.[0]?.zoning ??
        null;
      const researchQueries = [message];
      if (district) {
        researchQueries.unshift(
          `${district} zoning district permitted uses conditional prohibited dimensional standards`,
        );
      }
      if (
        starterPromptId === "adu" ||
        ADU_TOPIC_RE.test(message) ||
        ADU_TOPIC_RE.test(
          (payload.citations ?? [])
            .map((c) => c.query ?? "")
            .join(" "),
        )
      ) {
        researchQueries.push(...BROKERAGE_ADU_RESEARCH_QUERIES);
      }

      let retrievalThrew = false;
      let totalAtomsRetrieved = 0;

      for (const query of researchQueries) {
        try {
          const retrieved = await retrieveAtomsForQuestion({
            jurisdictionKey,
            question: query,
            limit: 8,
            logger,
            applyMinScore: false,
          });
          totalAtomsRetrieved += retrieved.length;
          for (const a of retrieved) {
            const existing = atomMap.get(a.id);
            const snippet = atomSnippet(a);
            if (!existing) {
              atomMap.set(a.id, toBriefAtom(a));
              continue;
            }
            if (snippet.length > (existing.snippet?.length ?? 0)) {
              atomMap.set(a.id, {
                ...existing,
                snippet,
              });
            }
          }
        } catch (err) {
          retrievalThrew = true;
          if (
            isSubstrateRetrievalError(err) &&
            !degradedReasons.includes(
              "Code retrieval substrate unavailable; response may lack code citations",
            )
          ) {
            degradedReasons.push(
              "Code retrieval substrate unavailable; response may lack code citations",
            );
          }
          logger.warn(
            {
              err,
              runId,
              jurisdictionKey,
              query,
              substrateFailureReason: isSubstrateRetrievalError(err)
                ? err.reason
                : undefined,
            },
            "brokerage: research chat retrieval failed",
          );
        }
      }

      // Distinguishes "substrate reachable but returned nothing" from a
      // thrown substrate error (handled above): every query completed
      // without throwing, substrate is configured, yet zero atoms came
      // back across the whole batch. This is a silent-degrade risk (the
      // chat answer still generates, ungrounded) so it feeds the same
      // degradedReasons signal the thrown-error path already populates.
      if (
        !retrievalThrew &&
        totalAtomsRetrieved === 0 &&
        researchQueries.length > 0 &&
        isSubstrateRetrievalConfigured()
      ) {
        degradedReasons.push(
          `substrate returned zero atoms for ${researchQueries.length} queries (jurisdiction=${jurisdictionKey})`,
        );
      }

      if (degradedReasons.length > 0) {
        logger.error(
          {
            runId,
            jurisdictionKey,
            queryCount: researchQueries.length,
            reasons: degradedReasons,
          },
          "brokerage: research chat retrieval degraded",
        );
      }
    }

    const webBackup = await resolveResearchChatWebSearchBackup({
      jurisdictionKey,
      message,
      existingAtoms: [...atomMap.values()],
    });
    for (const a of webBackup.atoms) {
      if (!atomMap.has(a.atomDid)) atomMap.set(a.atomDid, a);
    }
    for (const reason of webBackup.degradedReasons) {
      if (!degradedReasons.includes(reason)) degradedReasons.push(reason);
    }

    const atoms = [...atomMap.values()];

    // Register the researched subject parcel's constraints (zoning district,
    // setbacks, envelope numbers) as a NUMBERED source so inline [n]
    // citation markers can point at it — previously this content was only
    // injected as free-text context outside the numbered sources list, so
    // [n] could never resolve to it. Prepended (not appended) so it always
    // lands at source [1] and survives generateResearchChat's atoms.slice
    // cap regardless of how many code atoms were retrieved. DID-less for
    // now: the hauska-engine atom-chain wire enrichment that adds a real
    // atomDid for this entity ships separately (feat/atom-chain-wire-dids),
    // so `did` stays undefined here without a wire break — atomDid carries
    // the parcelNodeId as a stable, non-empty identifier in the meantime.
    const subjectConstraintsText = formatSubjectConstraintsForLlm(
      areaContext?.subject,
    );
    if (subjectConstraintsText && areaContext?.subject?.parcelNodeId) {
      const parcelNodeId = areaContext.subject.parcelNodeId;
      const situs = areaContext.subject.address?.trim() || parcelNodeId;
      atoms.unshift({
        atomDid: parcelNodeId,
        entityId: parcelNodeId,
        snippet: subjectConstraintsText,
        label: `Parcel record — ${situs} (Hauska property atom chain)`,
      });
    }

    const storedSiteContext = (
      payload as { siteContext?: Awaited<ReturnType<typeof fetchBrokerageSiteContext>> }
    ).siteContext;

    let privateRestrictionsBlock = "";
    if (installId && !extensionPublic && run) {
      const enc = await loadEncumbrancesForBrokerageWorkspace({
        installId,
        listingKey: run.listingKey,
      });
      privateRestrictionsBlock = formatPrivateRestrictionsForLlm(
        buildPrivateRestrictionsBriefing(enc.instruments, enc.clauses),
      );
    }

    // atoms[0] is the subject-parcel entry above when present, so its
    // citation number in the shared numbering sequence is always 1 — tell
    // the prompt instruction to cite it by that number instead of the
    // generic "cite the source" phrasing that had no numbered target.
    const areaContextBlock = formatResearchAreaContextForLlm(
      areaContext,
      subjectConstraintsText ? 1 : undefined,
    );

    const result = await generateResearchChat({
      address,
      jurisdiction: jurisdictionKey,
      message,
      history,
      atoms,
      siteContext: storedSiteContext,
      privateRestrictionsBlock,
      areaContextBlock,
      presentationMode,
    });

    if (installId) {
      recordGtmEvent({
        installId,
        eventType: "research_chat_turn",
        runId: runId ?? undefined,
        listingKey: run?.listingKey,
        payload: gtmPayloadWithClientTier(req, {
          messageLength: message.length,
          areaScope: areaContext?.scope ?? null,
          visibleParcelCount: areaContext?.visibleParcels?.length ?? 0,
        }),
      });
    }

    let workspaceId: string | undefined;
    if (installId && !extensionPublic && run) {
      const ws = await findWorkspaceByListingKey(installId, run.listingKey);
      workspaceId = ws?.id;
    }

    res.json({
      ...result,
      ...(degradedReasons.length > 0
        ? {
            substrateStatus: "error" as const,
            degradedReasons,
          }
        : {}),
      ...(workspaceId && !extensionPublic && run
        ? {
            workspaceId,
            workspaceDid: buildPropertyWorkspaceDid(run.listingKey),
          }
        : {}),
      ...(areaEligible ? { areaContextApplied: true } : {}),
    });
  },
);

const PARCEL_KEY_BODY = z.object({
  address: z.string().optional(),
  clip: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  source: z
    .enum(["address-geocode", "clip-paste", "coordinates", "auto-detect"])
    .optional(),
});

brokerageV1.post("/parcel-key", async (req: Request, res: Response) => {
  const parse = PARCEL_KEY_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  try {
    const captured = await captureParcelKey(parse.data);
    res.json(captured);
  } catch (err) {
    logger.warn({ err }, "parcel-key capture failed");
    res.status(422).json({
      error: "parcel_key_unresolved",
      message: String((err as Error).message ?? err),
    });
  }
});

router.use("/brokerage/v1", brokerageV1);

export default router;
