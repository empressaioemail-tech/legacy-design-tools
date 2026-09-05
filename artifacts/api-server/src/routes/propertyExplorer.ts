/**
 * Property Explorer v1 API — saved properties, entitlement, deep research scaffold.
 *
 * WDLL items 13, 14, 15, 17 (R1 scaffold).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { db, peSavedProperties, peShareGrants, peWorkbenchState } from "@workspace/db";
import {
  addToScreen,
  attachScreenStubs,
  createScreen,
  listScreens,
  saveProperty,
  setPropertyStatus,
  type Screen,
  type ScreenSaveRefuse,
} from "../lib/peScreenSave";
import { createDrizzleScreenSaveStore } from "../lib/peScreenSaveDb";
import { cortexNodeLookup, cortexQueryResolver } from "../lib/peScreenSaveResolve";
import type { NodeLookup } from "../lib/peScreenSave";
import {
  PE_FREE_CHAT_MESSAGE_LIMIT,
  createPePropertyUnlock,
  getPeFreeChatMessagesUsed,
  hasPeDevPaidBypass,
  isPePropertyEntitled,
  requirePeAuthenticated,
  requirePePaidOrPropertyUnlocked,
  peEntitlementAccountBody,
  peEntitlementBaseBody,
  resolvePeEntitlement,
  resolvePeOwnerUserId,
  grantsOwnerCoGatedFields,
} from "../lib/peEntitlement";
import { requirePeStudioScreens } from "../lib/peStudioGate";
import { getPeUserEmail, setPeDevRole } from "../lib/peIdentity";
import { readAiConnections } from "../lib/peAiConnections";
import { readActiveUnlocks } from "../lib/peUnlocksRead";
import {
  parseActivationEvent,
  recordActivationEvent,
} from "../lib/peActivationEvents";
import {
  cancelTeamInvitation,
  createTeamInvitation,
  patchTeamMemberRole,
  readTeamRoster,
  removeTeamMember,
  teamErrorBody,
} from "../lib/peTeamRoster";
import { requireServiceToken } from "../middlewares/serviceAuth";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import {
  isValidParcelNodeId,
  loadBakedNodeFacetSnapshot,
} from "./brokerageNodeFacets";
import { loadFloodHazardFactForServe } from "../lib/floodHazardFactServeCutover";
import { loadParcelRecordFloodFact } from "../lib/parcelRecordFactRead";
import { loadZoningFactForServe } from "../lib/zoningFactServeCutover";
import { loadSetbacksFactForServe } from "../lib/setbacksFactServeCutover";
import { loadBoundaryEdgeFactAtom } from "../lib/boundaryEdgeFactRead";
import { loadPipelineFactAtom } from "../lib/pipelineFactRead";
import { loadWellFactForServe } from "../lib/wellFactServeCutover";
import { loadStructuralFactAtom } from "../lib/structuralFactRead";
import { structuralFactWithParcelRecordOverlay } from "../lib/structuralFactResolve";
import { loadSpecialDistrictFactForServe } from "../lib/specialDistrictFactServeCutover";
import { resolveCadRollOverlaysForServe } from "../lib/cadRollServeCutover";
import { attachCadRollOverlaysToFacets } from "../lib/structuralFactToFacetsWire";
import { parseParcelNodeId } from "../lib/parcelNodeId";
import { tryAssembleParcelDrawFromReads } from "../lib/parcelDrawFromReads";
import { serializeTwinOnRecord } from "../lib/twinOnRecordSerialize";
import type { EnvelopeBriefRefusal } from "../lib/envelopeBriefRefusal";
import { buildR1Brief } from "../lib/r1BriefCompose";
import {
  isPunctuationOnlySitus,
  projectSavedPropertyLabel,
} from "../lib/situsCompose";
import { parseSmartSiteBriefRequest } from "../lib/smartSiteBriefRequest";
import {
  composeSmartSiteStub,
  type RailReadInput,
} from "../lib/smartSiteStub";
import type { FloodHazardFactRead } from "../lib/floodHazardFactRead";
import { installIdFromRequest } from "../lib/brokerageInstallId";
import { claimInstallHistoryForUser } from "../lib/brokerageInstallClaim";
import { isStripeConfigured } from "../lib/brokerageStripe";
import {
  createPeBillingPortalSession,
  createPeSubscriptionCheckoutSession,
  createPePropertyUnlockCheckoutSession,
  defaultPeCheckoutCancelUrl,
  defaultPeCheckoutSuccessUrl,
  isAllowedPeReturnUrl,
  PeCheckoutConfigError,
  PE_BILLING_PORTAL_ROUTE,
  PE_TEAM_INCLUDED_SEATS,
} from "../lib/pePaywallStripe";
import { countyFipsFromParcelNodeId } from "../lib/verdictLayerServe";
import { isP85CountyFips } from "../lib/p85ClerkPortalRegistry";
import {
  ensurePeRecordsEngagement,
  findPeRecordsEngagement,
} from "../lib/peRecordsEngagement";
import {
  createRecordsRequestJob,
  listRecordsRequestInboxWire,
  listRecordsRequestJobsWire,
} from "../lib/recordsRequestService";
import {
  approveRecordsRequestPurchase,
  declineRecordsRequestPurchase,
} from "../lib/recordsRequestPurchaseDecision";
import { processRecordsRequestJobVisionReads } from "../lib/recordsRequestVisionRead";
import { notifyRecordsRequestCompletion } from "../lib/recordsRequestCompletionEmail";
import { loadRecordsRequestArtifactDocumentForUser } from "../lib/recordsRequestDocumentServe";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function buildR1RunId(parcelNodeId: string, bakedAt: string | null): string {
  return `pe-r1-${Buffer.from(parcelNodeId).toString("base64url")}.${Buffer.from(
    bakedAt ?? "undated",
  ).toString("base64url")}`;
}

function parcelNodeIdFromR1RunId(runId: string): string | null {
  const match = /^pe-r1-([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(runId);
  if (!match) return null;
  try {
    const parcelNodeId = Buffer.from(match[1], "base64url").toString("utf8");
    return isValidParcelNodeId(parcelNodeId) ? parcelNodeId : null;
  } catch {
    return null;
  }
}

function floodReadToRail(flood: FloodHazardFactRead): RailReadInput {
  return {
    attempted: true,
    state: flood.state,
    code: flood.state === "refused" ? flood.code : undefined,
    kind: "flood",
  };
}

/**
 * `grantsCadRollValuation` gates the four CAD tax-assessed dollar rails
 * (marketValue/assessedValue/landValue/improvementValue) — OPS-16 A-103
 * item 5 / A-104, same predicate as owner-info display
 * (`callerGrantsOwnerFact` / `grantsOwnerCoGatedFields`): Studio|Team OR an
 * active Property Unlock for this specific parcel (widened 2026-09-05 —
 * Solo stays excluded, confirmed deliberate). This route already runs
 * behind `requirePeAuthenticated`, so the caller is guaranteed identified
 * before this function is ever reached. The caller computes this boolean
 * PER PARCEL (see `grantsCadRollValuationFor` at the route handler) since
 * Property Unlock is parcel-scoped and cannot be hoisted across a batch
 * request the way the tier check alone could be — never a fourth
 * independent tier check, reuse `grantsOwnerCoGatedFields` directly
 * (OPS-16 A-087).
 */
async function assembleNodeBriefBody(
  parcelNodeId: string,
  grantsCadRollValuation: boolean,
): Promise<Record<string, unknown> | null> {
  const parsedForOverlay = parseParcelNodeId(parcelNodeId);
  const [
    snapshot,
    floodHazardFact,
    boundaryFact,
    pipelineFact,
    wellFact,
    structuralFactLegacy,
    specialDistrictFact,
    parcelRecordFloodFact,
    cadRollOverlay,
    parcelRecordZoningFact,
    parcelRecordSetbacksFact,
  ] = await Promise.all([
    loadBakedNodeFacetSnapshot(parcelNodeId),
    loadFloodHazardFactForServe(parcelNodeId),
    loadBoundaryEdgeFactAtom(parcelNodeId),
    loadPipelineFactAtom(parcelNodeId),
    loadWellFactForServe(parcelNodeId),
    loadStructuralFactAtom(parcelNodeId),
    loadSpecialDistrictFactForServe(parcelNodeId),
    loadParcelRecordFloodFact(parcelNodeId),
    // PARCEL-B-SLATE2: livingAreaSqft + yearBuilt overlay, merged onto the
    // legacy structural read below rather than a whole-object swap.
    parsedForOverlay
      ? resolveCadRollOverlaysForServe(parsedForOverlay.countyFips, parsedForOverlay.propId)
      : Promise.resolve({
          marketValue: null,
          assessedValue: null,
          landValue: null,
          improvementValue: null,
          livingAreaSqft: null,
          yearBuilt: null,
        }),
    // OPS-16 A-096/A-097/A-098: zoning/setbacks not-applicable fix.
    loadZoningFactForServe(parcelNodeId),
    loadSetbacksFactForServe(parcelNodeId),
  ]);
  const structuralFact = structuralFactWithParcelRecordOverlay(structuralFactLegacy, {
    livingAreaSqft: cadRollOverlay.livingAreaSqft,
    yearBuilt: cadRollOverlay.yearBuilt,
  });
  if (!snapshot) return null;
  const root = asRecord(snapshot.facets);
  const bakedAt =
    typeof root?.bakedAt === "string" ? root.bakedAt : snapshot.snapshotAt;
  const brief = buildR1Brief(snapshot.facets, snapshot.tier2, {
    floodHazardFact,
    parcelRecordFloodFact,
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
    parcelRecordZoningFact,
    parcelRecordSetbacksFact,
  });
  // PARCEL-B-SLATE2 dollar rails: merge the live overlay onto the offline-
  // baked baseFacts.cadRoll (item 3, A-104) — previously discarded here
  // entirely, unlike livingAreaSqft/yearBuilt above. yearBuilt is
  // deliberately NOT re-merged through this call: it already flows through
  // `structuralFactWithParcelRecordOverlay` above, and this call exists only
  // to carry the four dollar fields through to `draw` / `onRecord`.
  const facetsWithCadRollOverlay = attachCadRollOverlaysToFacets(
    (asRecord(snapshot.facets) as Record<string, unknown> | null) ?? {},
    {
      marketValue: cadRollOverlay.marketValue,
      assessedValue: cadRollOverlay.assessedValue,
      landValue: cadRollOverlay.landValue,
      improvementValue: cadRollOverlay.improvementValue,
      yearBuilt: null,
    },
  );
  const draw = tryAssembleParcelDrawFromReads({
    parcelNodeId,
    facets: facetsWithCadRollOverlay,
    bakedAt,
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
    queryPoint: snapshot.queryPoint ?? null,
    boundary: boundaryFact,
    flood: floodHazardFact,
    pipeline: pipelineFact,
    well: wellFact,
    specialDistrict: specialDistrictFact,
    structural: structuralFact,
    grantsCadRollValuation,
  });
  return {
    runId: buildR1RunId(parcelNodeId, bakedAt),
    reportFamily: "R1",
    mode: "baked-facet-intel-v1",
    parcelNodeId,
    onRecord: serializeTwinOnRecord(
      facetsWithCadRollOverlay,
      parcelNodeId,
      grantsCadRollValuation,
    ),
    brief: {
      sections: brief.sections,
      disclosure: brief.disclosure,
    },
    citations: brief.citations,
    bakedAt,
    source: "baked-snapshot",
    ...(draw ? { draw } : {}),
  };
}

async function assembleStubBody(parcelNodeId: string) {
  const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
  if (!snapshot) return null;
  const [floodHazardFact, parcelRecordZoningFact, parcelRecordSetbacksFact] = await Promise.all([
    loadFloodHazardFactForServe(parcelNodeId),
    // OPS-16 A-096/A-097/A-098: zoning/setbacks not-applicable fix.
    loadZoningFactForServe(parcelNodeId),
    loadSetbacksFactForServe(parcelNodeId),
  ]);
  return composeSmartSiteStub({
    parcelNodeId,
    facets: snapshot.facets,
    flood: floodReadToRail(floodHazardFact),
    drainage: { attempted: false },
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
    parcelRecordZoningFact,
    parcelRecordSetbacksFact,
  });
}

/**
 * P-91 4.3. Rails on a create_screen / list_screens(screenId) response,
 * read through the same assembler the brief's stub depth serves. No paid
 * gate on this path by design: the board is the intake surface, and
 * GET /saved-properties already serves these rails to the same user under
 * requirePeAuthenticated. Nothing here is stored and updatedAt does not move.
 */
async function attachStubsForResponse(screen: Screen): Promise<Screen> {
  return attachScreenStubs(screen, assembleStubBody, {
    onReadError: (parcelNodeId, err) =>
      logger.warn(
        { err, parcelNodeId, screenId: screen.id },
        "pe_screen_stub_read_error",
      ),
  });
}

function manifestLayers(
  envelopeBriefRefusal: EnvelopeBriefRefusal,
  tier2: unknown,
): {
  layers: Array<Record<string, unknown>>;
  degraded: boolean;
  reason?: string;
} {
  // The loader nulls facets.envelope before this runs. Reading geojson off
  // the stripped snapshot is empty by construction and can never report a
  // missing layer. Refuse with the pre-strip envelope refusal.
  const floodRefusal = asRecord(asRecord(tier2)?.floodDisposition);
  const floodNote = floodRefusal
    ? " Tier-2 flood facet is refused: " +
      String(floodRefusal.reason ?? floodRefusal.code)
    : " No Tier-2 row exists for this node.";
  return {
    layers: [],
    degraded: true,
    reason:
      envelopeBriefRefusal.reason +
      " Envelope geometry is not served on this path." +
      floodNote,
  };
}

function ownerScope(req: Request): { tenantId: string; ownerUserId: string } | null {
  const ownerUserId = resolvePeOwnerUserId(req);
  if (!ownerUserId) return null;
  return {
    tenantId: req.session.tenantId ?? DEFAULT_TENANT_ID,
    ownerUserId,
  };
}

/**
 * Entitlement read (R1 pinned contract, LOCK 2026-07-29). With
 * `?parcelNodeId=` and an authenticated user, adds the property block the
 * PE BFF consults for per-property gating (site-plan export, locked-bubble
 * state, chat allowance). Anonymous callers keep today's shape.
 *
 * `parcelNodeId` is OPTIONAL (P-98). Settings is account-scoped and has no
 * parcel to pass; the route used to refuse without one, which is why
 * Settings showed Access as "Not read" for paying accounts. An
 * authenticated caller with no parcel now gets the ACCOUNT body — the same
 * fields plus `seatsPurchased` and `billingInterval`, and NO `property`
 * key at all.
 *
 * Exactly one path changed. The anonymous guard is evaluated FIRST and on
 * its own, so an anonymous caller's response is unchanged with or without a
 * parcel, and a malformed parcel from an anonymous caller still returns 200
 * with today's body rather than a 400. Every authenticated with-parcel
 * response is byte-identical to before.
 */
router.get("/property-explorer/v1/entitlement", async (req: Request, res: Response) => {
  const snap = await resolvePeEntitlement(req);
  if (!snap.authenticated || !snap.userId) {
    res.json(peEntitlementBaseBody(snap));
    return;
  }
  const parcelNodeIdRaw = req.query.parcelNodeId;
  const parcelNodeId = (
    Array.isArray(parcelNodeIdRaw) ? parcelNodeIdRaw[0] : parcelNodeIdRaw
  );
  if (typeof parcelNodeId !== "string" || !parcelNodeId.trim()) {
    res.json(peEntitlementAccountBody(snap));
    return;
  }
  const trimmed = parcelNodeId.trim();
  if (!isValidParcelNodeId(trimmed)) {
    res.status(400).json({ error: "invalid_parcel_node_id" });
    return;
  }
  const [unlocked, freeMessagesUsed] = await Promise.all([
    isPePropertyEntitled(snap.userId, trimmed),
    getPeFreeChatMessagesUsed(snap.userId, trimmed),
  ]);
  res.json({
    ...peEntitlementBaseBody(snap),
    property: {
      parcelNodeId: trimmed,
      unlocked,
      freeMessagesUsed,
      freeMessagesLimit: PE_FREE_CHAT_MESSAGE_LIMIT,
    },
  });
});

router.get(
  "/property-explorer/v1/saved-properties",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const rows = await db
      .select({
        id: peSavedProperties.id,
        parcelNodeId: peSavedProperties.parcelNodeId,
        label: peSavedProperties.label,
        snapshot: peSavedProperties.snapshot,
        crmStatus: peSavedProperties.crmStatus,
        note: peSavedProperties.note,
        updatedAt: peSavedProperties.updatedAt,
      })
      .from(peSavedProperties)
      .where(
        and(
          eq(peSavedProperties.tenantId, scope.tenantId),
          eq(peSavedProperties.ownerUserId, scope.ownerUserId),
        ),
      )
      .orderBy(desc(peSavedProperties.updatedAt));
    const stubs = await Promise.all(
      rows.map(async (row) => {
        const stub = await assembleStubBody(row.parcelNodeId);
        return {
          situs: stub?.situs ?? "unread",
          zoning: stub?.zoning ?? "unread",
          landUse: stub?.landUse ?? "unread",
          flood: stub?.flood ?? "unread",
          drainage: stub?.drainage ?? "unread",
          envelope: stub?.envelope ?? "unread",
        };
      }),
    );
    res.json(
      rows.map((row, i) => {
        const composed = projectSavedPropertyLabel(row.parcelNodeId, row.label);
        return {
          ...row,
          label: composed.label,
          situs: composed.situs,
          status: row.crmStatus,
          note: row.note,
          stub: stubs[i],
        };
      }),
    );
  },
);

const SaveBodySchema = z.object({
  label: z.string().max(256).optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

router.put(
  "/property-explorer/v1/saved-properties/:parcelNodeId",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parcelNodeIdRaw = req.params.parcelNodeId;
    const parcelNodeId = (Array.isArray(parcelNodeIdRaw)
      ? parcelNodeIdRaw[0]
      : parcelNodeIdRaw)?.trim();
    if (!parcelNodeId || parcelNodeId.length > 128) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }
    const parsed = SaveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const snapshot = parsed.data.snapshot ?? {};
    const labelRaw = parsed.data.label ?? null;
    const label =
      labelRaw != null && isPunctuationOnlySitus(labelRaw) ? null : labelRaw;
    const now = new Date();
    await db
      .insert(peSavedProperties)
      .values({
        tenantId: scope.tenantId,
        ownerUserId: scope.ownerUserId,
        parcelNodeId,
        label,
        snapshot,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          peSavedProperties.tenantId,
          peSavedProperties.ownerUserId,
          peSavedProperties.parcelNodeId,
        ],
        set: { label, snapshot, updatedAt: now },
      });
    res.json({ ok: true, parcelNodeId });
  },
);

router.delete(
  "/property-explorer/v1/saved-properties/:parcelNodeId",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parcelNodeIdRaw = req.params.parcelNodeId;
    const parcelNodeId = (Array.isArray(parcelNodeIdRaw)
      ? parcelNodeIdRaw[0]
      : parcelNodeIdRaw)?.trim();
    if (!parcelNodeId) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }
    const deleted = await db
      .delete(peSavedProperties)
      .where(
        and(
          eq(peSavedProperties.tenantId, scope.tenantId),
          eq(peSavedProperties.ownerUserId, scope.ownerUserId),
          eq(peSavedProperties.parcelNodeId, parcelNodeId),
        ),
      )
      .returning({ id: peSavedProperties.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "saved_property_not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

function screenSaveHttpStatus(error: string): number {
  if (error === "not_found" || error === "saved_property_not_found") return 404;
  if (error === "authentication_required") return 401;
  // The parcel store did not answer an existence lookup. Nothing was
  // written and the caller retries. Never a 404, never a written absence.
  if (error === "lookup_unavailable") return 503;
  return 400;
}

/**
 * Screens write-path refuse. The wire body is the refuse's `error`; the
 * underlying throw behind a `lookup_unavailable` is recorded here and never
 * sent.
 */
function sendScreenSaveRefuse(
  req: Request,
  res: Response,
  refuse: ScreenSaveRefuse,
): void {
  const status = screenSaveHttpStatus(refuse.error.error);
  if (status === 503) {
    logger.warn(
      {
        err: refuse.cause,
        refuse: refuse.error,
        path: req.originalUrl?.split("?")[0],
      },
      "pe_screen_lookup_unavailable",
    );
  }
  res.status(status).json(refuse.error);
}

/**
 * A null assembler result is "no tier1 snapshot", which is two states: the
 * parcel is not in the store (`parcel_not_found`) or it is and no bake has
 * run (`baked_snapshot_not_found`). The existence probe splits them. A probe
 * that throws is a third state (`lookup_unavailable`, 503) and is never
 * collapsed into either 404.
 */
async function sendBriefMiss(res: Response, parcelNodeId: string): Promise<void> {
  // Same existence seam add_to_screen uses (peScreenSaveResolve.cortexNodeLookup),
  // never a direct txgioAddressResolve import: that module reads @workspace/db
  // tables at load, and the route suites mock the seam, not the store.
  let probe: Awaited<ReturnType<NodeLookup>>;
  try {
    probe = await cortexNodeLookup()(parcelNodeId);
  } catch (err) {
    logger.warn({ err, parcelNodeId }, "pe_brief_existence_probe_unavailable");
    res.status(503).json({ error: "lookup_unavailable", parcelNodeId });
    return;
  }
  if (!probe) {
    res.status(404).json({
      error: "parcel_not_found",
      message: "No parcel with this node id exists in the parcel store.",
      parcelNodeId,
    });
    return;
  }
  res.status(404).json({
    error: "baked_snapshot_not_found",
    message:
      "The parcel exists but no baked facet snapshot exists for it yet.",
    parcelNodeId,
  });
}

const CreateScreenBodySchema = z.object({
  name: z.string().optional(),
  queries: z.array(z.string()),
  source: z.string(),
});

const AddScreenRowBodySchema = z.object({
  parcelNodeId: z.string(),
  source: z.string(),
});

const McpSaveBodySchema = z.object({
  status: z.string().optional(),
  note: z.string().optional(),
});

const McpStatusBodySchema = z.object({
  status: z.string(),
});

/* P-101 call 1: BUILDING a screen is Studio or Team. The gate sits second, so
 * an anonymous caller still gets 401 from requirePeAuthenticated rather than a
 * 402 that names a rung it has no account to hold. The two GET routes below
 * are deliberately NOT gated - the panel must still mount for a free connector
 * user, and a free account's screen list is empty by construction. */
router.post(
  "/property-explorer/v1/screens",
  requirePeAuthenticated,
  requirePeStudioScreens,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = CreateScreenBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const result = await createScreen(
      createDrizzleScreenSaveStore(),
      scope,
      parsed.data,
      cortexQueryResolver(),
    );
    if (!result.ok) {
      sendScreenSaveRefuse(req, res, result);
      return;
    }
    res.json({ screen: await attachStubsForResponse(result.screen) });
  },
);

/* NOT Studio-gated, deliberately (P-101 call 1). Reading a list you could
 * never have created gives nothing away, and `list_screens` is one of the
 * three APP_HOST_TOOLS that mount the connector panel: gating it would leave a
 * free user with no panel entry point at all, which is a larger consequence
 * than "screens move to Studio" conveys. Do not add requirePeStudioScreens
 * here without reversing that call. */
router.get(
  "/property-explorer/v1/screens",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const result = await listScreens(createDrizzleScreenSaveStore(), scope);
    if (!result.ok) {
      res.status(screenSaveHttpStatus(result.error.error)).json(result.error);
      return;
    }
    if ("screens" in result) {
      res.json({ screens: result.screens });
      return;
    }
    res.json({ screen: result.screen });
  },
);

router.get(
  "/property-explorer/v1/screens/:screenId",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const screenIdRaw = req.params.screenId;
    const screenId = Array.isArray(screenIdRaw) ? screenIdRaw[0] : screenIdRaw;
    const result = await listScreens(
      createDrizzleScreenSaveStore(),
      scope,
      screenId,
    );
    if (!result.ok) {
      res.status(screenSaveHttpStatus(result.error.error)).json(result.error);
      return;
    }
    if ("screen" in result) {
      res.json({ screen: await attachStubsForResponse(result.screen) });
      return;
    }
    res.json({ screens: result.screens });
  },
);

/* P-101 call 1: adding to a screen is the same job as building one. */
router.post(
  "/property-explorer/v1/screens/:screenId/rows",
  requirePeAuthenticated,
  requirePeStudioScreens,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const screenIdRaw = req.params.screenId;
    const screenId = Array.isArray(screenIdRaw) ? screenIdRaw[0] : screenIdRaw;
    const parsed = AddScreenRowBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || !screenId) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const result = await addToScreen(
      createDrizzleScreenSaveStore(),
      scope,
      {
        screenId,
        parcelNodeId: parsed.data.parcelNodeId,
        source: parsed.data.source,
      },
      cortexNodeLookup(),
    );
    if (!result.ok) {
      sendScreenSaveRefuse(req, res, result);
      return;
    }
    res.json({ screenId: result.screenId, row: result.row });
  },
);

router.post(
  "/property-explorer/v1/saved-properties/:parcelNodeId/save",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parcelNodeIdRaw = req.params.parcelNodeId;
    const parcelNodeId = (Array.isArray(parcelNodeIdRaw)
      ? parcelNodeIdRaw[0]
      : parcelNodeIdRaw)?.trim();
    const parsed = McpSaveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || !parcelNodeId) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const result = await saveProperty(createDrizzleScreenSaveStore(), scope, {
      parcelNodeId,
      status: parsed.data.status,
      note: parsed.data.note,
    });
    if (!result.ok) {
      res.status(screenSaveHttpStatus(result.error.error)).json(result.error);
      return;
    }
    res.json({
      parcelNodeId: result.parcelNodeId,
      status: result.status,
      note: result.note,
    });
  },
);

router.post(
  "/property-explorer/v1/saved-properties/:parcelNodeId/status",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parcelNodeIdRaw = req.params.parcelNodeId;
    const parcelNodeId = (Array.isArray(parcelNodeIdRaw)
      ? parcelNodeIdRaw[0]
      : parcelNodeIdRaw)?.trim();
    const parsed = McpStatusBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || !parcelNodeId) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const result = await setPropertyStatus(createDrizzleScreenSaveStore(), scope, {
      parcelNodeId,
      status: parsed.data.status,
    });
    if (!result.ok) {
      res.status(screenSaveHttpStatus(result.error.error)).json(result.error);
      return;
    }
    res.json({ parcelNodeId: result.parcelNodeId, status: result.status });
  },
);

const ClaimLocalSavedPropertySchema = z.object({
  parcelNodeId: z.string().min(1).max(128),
  label: z.string().max(256).optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

const ClaimLocalStateBodySchema = z.object({
  savedProperties: z.array(ClaimLocalSavedPropertySchema).max(200).optional(),
  workbenchToolState: z.record(z.string(), z.unknown()).optional(),
});

const ClaimSessionBodySchema = z.object({
  installId: z.string().min(8).max(256).optional(),
});

/**
 * Anonymous claim, first half (WDLL 2026-08-05 item 6): attach this
 * browser's pre-auth install history to the signed-in PE user. Best-effort —
 * an install already claimed by another user is a silent no-op (sign-in still
 * succeeded). Header `X-Hauska-Install-Id` wins over body when both present.
 */
router.post(
  "/property-explorer/v1/claim-session",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = resolvePeOwnerUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = ClaimSessionBodySchema.safeParse(req.body ?? {});
    const installId =
      installIdFromRequest(req) ??
      (parsed.success ? parsed.data.installId?.trim() : undefined) ??
      null;
    if (!installId) {
      res.json({ ok: true, claimed: false, reason: "no_install_id" });
      return;
    }
    const claim = await claimInstallHistoryForUser(installId, userId);
    if (!claim.ok) {
      res.json({
        ok: true,
        claimed: false,
        reason: "install_already_claimed",
        claimedBy: claim.claimedBy,
      });
      return;
    }
    res.json({
      ok: true,
      claimed: claim.claimed,
      installId,
    });
  },
);

/**
 * Anonymous claim, second half (WDLL 2026-08-05 item 6): the client uploads
 * whatever it held locally pre-auth (saved-property hints + workbench UI
 * state) once it has a signed-in session, so nothing orphans on the auth
 * flip. Saved properties are MERGED, never overwritten or deleted — a
 * pre-existing server row wins on label/snapshot conflicts, since it is by
 * definition newer (it was written by an already-authenticated write).
 * Workbench state is UI convenience, not user content, so it is replaced
 * wholesale.
 */
router.post(
  "/property-explorer/v1/claim-local-state",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = ClaimLocalStateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const now = new Date();
    const claimedParcelNodeIds: string[] = [];

    for (const item of parsed.data.savedProperties ?? []) {
      const parcelNodeId = item.parcelNodeId.trim();
      if (!parcelNodeId || !isValidParcelNodeId(parcelNodeId)) continue;

      const [existing] = await db
        .select({
          label: peSavedProperties.label,
          snapshot: peSavedProperties.snapshot,
        })
        .from(peSavedProperties)
        .where(
          and(
            eq(peSavedProperties.tenantId, scope.tenantId),
            eq(peSavedProperties.ownerUserId, scope.ownerUserId),
            eq(peSavedProperties.parcelNodeId, parcelNodeId),
          ),
        )
        .limit(1);

      if (existing) {
        const mergedSnapshot = {
          ...(item.snapshot ?? {}),
          ...(asRecord(existing.snapshot) ?? {}),
        };
        await db
          .update(peSavedProperties)
          .set({
            label:
              existing.label ??
              (item.label != null && isPunctuationOnlySitus(item.label)
                ? null
                : item.label ?? null),
            snapshot: mergedSnapshot,
            updatedAt: now,
          })
          .where(
            and(
              eq(peSavedProperties.tenantId, scope.tenantId),
              eq(peSavedProperties.ownerUserId, scope.ownerUserId),
              eq(peSavedProperties.parcelNodeId, parcelNodeId),
            ),
          );
      } else {
        await db.insert(peSavedProperties).values({
          tenantId: scope.tenantId,
          ownerUserId: scope.ownerUserId,
          parcelNodeId,
          label:
            item.label != null && isPunctuationOnlySitus(item.label)
              ? null
              : item.label ?? null,
          snapshot: item.snapshot ?? {},
          updatedAt: now,
        });
      }
      claimedParcelNodeIds.push(parcelNodeId);
    }

    const workbenchToolStateSaved = parsed.data.workbenchToolState != null;
    if (workbenchToolStateSaved) {
      await db
        .insert(peWorkbenchState)
        .values({
          ownerUserId: scope.ownerUserId,
          tenantId: scope.tenantId,
          state: parsed.data.workbenchToolState!,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: peWorkbenchState.ownerUserId,
          set: {
            tenantId: scope.tenantId,
            state: parsed.data.workbenchToolState!,
            updatedAt: now,
          },
        });
    }

    res.json({ ok: true, claimedParcelNodeIds, workbenchToolStateSaved });
  },
);

/**
 * Service-key single-row dossier read for the anonymous share view.
 *
 * The PE BFF (holds CORTEX_SERVICE_API_KEY) validates an HMAC share token
 * minted by the sharer (single parcel, expiry- and entitlement-gated at
 * mint), then calls this route server-side to fetch the SHARER's saved
 * dossier (drawings GeoJSON, chat summary, notes in `snapshot`) for the
 * share view. The owner scope (tenantId + ownerUserId) comes from the
 * token minted at share time, never from a session.
 *
 * Guard: {@link requireServiceToken} — `Authorization: Bearer
 * <SERVICE_API_KEY>` only. Session auth is never accepted here; without a
 * valid service bearer the route 401s before any query runs. Exactly one
 * (tenantId, ownerUserId, parcelNodeId) row is addressable per call; there
 * is no list mode and no wildcarding (all three params are required and
 * shape-checked; duplicate query params are rejected by the string schema).
 * The body echoes only what was queried (parcelNodeId) plus the sharer's
 * own content for that parcel — no owner identifiers.
 */
const ShareDossierQuerySchema = z.object({
  tenantId: z.string().trim().min(1).max(128),
  ownerUserId: z.string().trim().min(1).max(128),
  parcelNodeId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine(isValidParcelNodeId, { message: "invalid parcelNodeId" }),
});

router.get(
  "/property-explorer/v1/internal/share-dossier",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = ShareDossierQuerySchema.safeParse({
      tenantId: req.query.tenantId,
      ownerUserId: req.query.ownerUserId,
      parcelNodeId: req.query.parcelNodeId,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const { tenantId, ownerUserId, parcelNodeId } = parsed.data;
    const rows = await db
      .select({
        label: peSavedProperties.label,
        snapshot: peSavedProperties.snapshot,
        updatedAt: peSavedProperties.updatedAt,
      })
      .from(peSavedProperties)
      .where(
        and(
          eq(peSavedProperties.tenantId, tenantId),
          eq(peSavedProperties.ownerUserId, ownerUserId),
          eq(peSavedProperties.parcelNodeId, parcelNodeId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "saved_property_not_found" });
      return;
    }
    res.json({
      parcelNodeId,
      label: row.label,
      updatedAt: row.updatedAt,
      snapshot: row.snapshot,
    });
  },
);

/**
 * R1 cited property intelligence from the existing baked node facets.
 * Paid OR property-unlocked (LOCK 2026-07-29) — the parcelNodeId in the
 * body scopes the unlock check. Terrain is NOT here: terrain export is
 * gated PE-BFF-side off `/entitlement` tier and stays Pro-only.
 */
router.post(
  "/property-explorer/v1/research/brief",
  requirePeAuthenticated,
  requirePePaidOrPropertyUnlocked(),
  async (req: Request, res: Response) => {
    const parsed = parseSmartSiteBriefRequest(req.body ?? {});
    if (!parsed.ok) {
      if (parsed.error === "not_implemented") {
        res.status(400).json({
          error: "not_implemented",
          depth: parsed.depth,
        });
        return;
      }
      if (parsed.error === "parcel_batch_cap") {
        res.status(400).json({
          error: "parcel_batch_cap",
          cap: parsed.cap,
          received: parsed.received,
        });
        return;
      }
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }

    // CAD tax-assessed dollar rails co-gate with owner info (OPS-16 A-103
    // item 5 / A-104; co-gate widened 2026-09-05): Studio|Team OR an active
    // Property Unlock for THIS parcel — the exact same
    // `grantsOwnerCoGatedFields` predicate `callerGrantsOwnerFact` uses
    // elsewhere, never a second one. `requirePeAuthenticated` already
    // guarantees an identified caller ahead of this handler. UNLIKE the old
    // tier-only check, this cannot be hoisted to one boolean for the whole
    // request: Property Unlock is scoped to ONE parcel, so a batch request
    // covering several parcels can grant some and refuse others for the
    // very same user. `peSnap` (the tier half) is resolved once; the
    // Property Unlock lookup runs per parcel id below.
    const peSnap = await resolvePeEntitlement(req);
    async function grantsCadRollValuationFor(
      parcelNodeId: string,
    ): Promise<boolean> {
      if (parsed.depth !== "node") return false;
      // Defensive fallback (never null/undefined in production -- guards a
      // test double or a future entitlement-read failure from throwing here
      // instead of failing closed).
      return grantsOwnerCoGatedFields(
        peSnap?.userId ?? null,
        peSnap?.subscriptionTier ?? null,
        parcelNodeId,
      );
    }

    if (parsed.mode === "single") {
      const parcelNodeId = parsed.ids[0]!;
      if (!isValidParcelNodeId(parcelNodeId)) {
        res.status(400).json({ error: "invalid_parcel_node_id" });
        return;
      }
      if (parsed.depth === "stub") {
        const stub = await assembleStubBody(parcelNodeId);
        if (!stub) {
          await sendBriefMiss(res, parcelNodeId);
          return;
        }
        res.json(stub);
        return;
      }
      const body = await assembleNodeBriefBody(
        parcelNodeId,
        await grantsCadRollValuationFor(parcelNodeId),
      );
      if (!body) {
        await sendBriefMiss(res, parcelNodeId);
        return;
      }
      res.json(body);
      return;
    }

    // Array path: per-id notFound inside a 200, unchanged. No existence
    // probe here: the ltrim arm of the probe reads a county's index entries
    // per id, so fifty misses on a large county is not a bounded cost.

    const parcels: unknown[] = [];
    const notFound: string[] = [];
    const results = await Promise.all(
      parsed.ids.map(async (id) => {
        if (!isValidParcelNodeId(id)) {
          return { id, row: null };
        }
        const row =
          parsed.depth === "node"
            ? await assembleNodeBriefBody(id, await grantsCadRollValuationFor(id))
            : await assembleStubBody(id);
        return { id, row };
      }),
    );
    for (const item of results) {
      if (item.row) parcels.push(item.row);
      else notFound.push(item.id);
    }
    res.json({ parcels, notFound });
  },
);

/** R7/R10 honest degrade scaffold — no fake geometry. */
router.post(
  "/property-explorer/v1/research/hydrology",
  requirePeAuthenticated,
  requirePePaidOrPropertyUnlocked(),
  async (req: Request, res: Response) => {
    res.status(503).json({
      error: "spine_degraded",
      message: "Hydrology report not served honestly by spine yet (R7).",
      reportFamily: "R7",
      degraded: true,
    });
  },
);

router.post(
  "/property-explorer/v1/research/subsurface",
  requirePeAuthenticated,
  requirePePaidOrPropertyUnlocked(),
  async (req: Request, res: Response) => {
    res.status(503).json({
      error: "spine_degraded",
      message: "Subsurface suitability not served honestly by spine yet (R10).",
      reportFamily: "R10",
      degraded: true,
    });
  },
);

/**
 * Layer manifest projected from the same R1 baked snapshot. Same gate as
 * the brief it belongs to — the parcelNodeId is decoded from the runId so
 * an unlocked property's manifest never 402s behind its own brief.
 */
router.get(
  "/property-explorer/v1/research/layer-manifest/:runId",
  requirePeAuthenticated,
  requirePePaidOrPropertyUnlocked((req) => {
    const runIdRaw = req.params.runId;
    const runId = (Array.isArray(runIdRaw) ? runIdRaw[0] : runIdRaw)?.trim();
    return runId ? parcelNodeIdFromR1RunId(runId) : null;
  }),
  async (req: Request, res: Response) => {
    const runIdRaw = req.params.runId;
    const runId = (Array.isArray(runIdRaw) ? runIdRaw[0] : runIdRaw)?.trim();
    if (!runId) {
      res.status(400).json({ error: "invalid_run_id" });
      return;
    }
    const parcelNodeId = parcelNodeIdFromR1RunId(runId);
    if (!parcelNodeId) {
      res.status(400).json({ error: "invalid_run_id" });
      return;
    }
    const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
    if (!snapshot) {
      res.status(404).json({
        error: "baked_snapshot_not_found",
        message: "No baked facet snapshot exists for this report run.",
        parcelNodeId,
      });
      return;
    }
    const manifest = manifestLayers(
      snapshot.envelopeBriefRefusal,
      snapshot.tier2,
    );
    res.json({
      runId,
      contract: "layer-manifest-v1",
      parcelNodeId,
      layers: manifest.layers,
      degraded: manifest.degraded,
      ...(manifest.reason ? { reason: manifest.reason } : {}),
      source: "baked-snapshot",
    });
  },
);

const DevUnlockBodySchema = z.object({
  parcelNodeId: z.string().min(1).max(128),
  ownerUserId: z.string().min(1).max(128).optional(),
});

/**
 * Stub unlock writer — dev/ops path to create a per-property unlock without
 * payments (LOCK 2026-07-29: gate interface only, NO live charging).
 *
 * Guarded exactly like the existing dev paid bypass: identity-bound via the
 * `PE_DEV_PAID_EMAILS` / `PE_DEV_PAID_SUBJECTS` allowlists and inert when
 * neither env is configured ({@link hasPeDevPaidBypass} precedent) — never
 * a request-header check. The caller may unlock for another user
 * (`ownerUserId`) to support operator support flows.
 *
 * The future Stripe one-time checkout flow calls the SAME writer
 * ({@link createPePropertyUnlock}) from its webhook handler with
 * `source: "stripe"`; this route is the interface proof, not the payment.
 */
router.post(
  // Both paths serve the same handler: the PE client's stub seam calls
  // /entitlement/dev-unlock (pinned in PE PR #110); /internal/dev-unlock is
  // the operator-support alias.
  ["/property-explorer/v1/entitlement/dev-unlock", "/property-explorer/v1/internal/dev-unlock"],
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const callerUserId = resolvePeOwnerUserId(req);
    if (!callerUserId || !(await hasPeDevPaidBypass(callerUserId))) {
      res.status(403).json({ error: "dev_bypass_required" });
      return;
    }
    const parsed = DevUnlockBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const parcelNodeId = parsed.data.parcelNodeId.trim();
    if (!isValidParcelNodeId(parcelNodeId)) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }
    const ownerUserId = parsed.data.ownerUserId?.trim() || callerUserId;
    await createPePropertyUnlock({
      ownerUserId,
      tenantId: req.session.tenantId ?? DEFAULT_TENANT_ID,
      parcelNodeId,
      source: "dev",
    });
    res.status(201).json({
      ok: true,
      unlock: { ownerUserId, parcelNodeId, source: "dev" },
    });
  },
);

const PeCheckoutBodySchema = z
  .object({
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
    /**
     * Ladder rung (LOCKED 2026-08-10): solo $49 / studio $129 / team $299.
     * Unknown strings are rejected by the enum (fail closed — never mapped
     * to another tier). ABSENT defaults to solo: the deployed PE client
     * (hauska-map billingClient.ts) predates the tier field and its only
     * subscription button semantic was Solo; tighten to required once the
     * tier-passing client ships (see PE handoff note, 2026-08-24).
     */
    tier: z.enum(["solo", "studio", "team"]).optional(),
    /**
     * Billing interval (2026-08-24 annual ruling: Solo $490 / Studio $1,290 /
     * Team $2,990 per year). ABSENT defaults to month. Unknown strings are
     * rejected 400 by the enum — never coerced to a different interval than
     * the one the customer was shown.
     */
    interval: z.enum(["month", "year"]).optional(),
    /** Team only: TOTAL seats desired. Base price covers PE_TEAM_INCLUDED_SEATS; +$25/mo each above. */
    seats: z.number().int().min(1).max(500).optional(),
    /**
     * Checkout chrome. Absent / "hosted" keeps today's hosted redirect
     * (checkoutUrl). "custom" and "embedded" return clientSecret and omit
     * checkoutUrl. Unknown strings are 400 — never coerced to hosted.
     */
    uiMode: z.enum(["hosted", "custom", "embedded", "elements"]).optional(),
    /** Custom / Embedded return URL. Ignored on the hosted path. */
    returnUrl: z.string().url().optional(),
  })
  .refine((body) => body.seats === undefined || body.tier === "team", {
    message: "seats is only valid with tier=team",
  })
  .refine(
    (body) =>
      body.interval !== "year" ||
      body.seats === undefined ||
      body.seats <= PE_TEAM_INCLUDED_SEATS,
    {
      // No annual extra-seat price exists (seats stay monthly $25, ruled
      // 2026-08-24) and Stripe cannot mix intervals in one subscription.
      message:
        `annual Team billing covers at most the ${PE_TEAM_INCLUDED_SEATS} included seats; extra seats bill monthly only`,
    },
  );

/**
 * User-authenticated subscription checkout (WDLL 2026-08-05 items 2, 3;
 * tier-aware per the LOCKED 2026-08-10 ladder). Distinct from the
 * install-scoped `propertyExplorerBillingRouter` seam: this is the
 * signed-in PE user's own checkout, carries `pe_user_id` +
 * `subscription_tier` in Stripe metadata so the webhook can set THIS
 * user's `pe_user_entitlements` rung, and allows Stripe promotion codes at
 * checkout so a tester can apply a 100%-off code and land in the same paid
 * path as a real payment.
 */
router.post(
  "/property-explorer/v1/billing/checkout",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = resolvePeOwnerUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = PeCheckoutBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      const email = await getPeUserEmail(userId);
      const session = await createPeSubscriptionCheckoutSession({
        userId,
        email,
        tier: parsed.data.tier ?? "solo",
        interval: parsed.data.interval ?? "month",
        seats: parsed.data.seats,
        installId: installIdFromRequest(req),
        successUrl: parsed.data.successUrl ?? defaultPeCheckoutSuccessUrl(),
        cancelUrl: parsed.data.cancelUrl ?? defaultPeCheckoutCancelUrl(),
        returnUrl: parsed.data.returnUrl,
        uiMode: parsed.data.uiMode,
      });
      res.json({
        ...session,
        stripeConfigured: isStripeConfigured(),
        honestNote: isStripeConfigured()
          ? undefined
          : "Stripe credentials not configured on cortex — simulated checkout only",
      });
    } catch (err) {
      if (err instanceof PeCheckoutConfigError) {
        // FAIL CLOSED, declared: this tier's price is not configured.
        // Refuse rather than charge any other tier's price.
        res.status(503).json({
          error: "checkout_unavailable",
          message: err.message,
          missing: err.missing,
          stripeConfigured: isStripeConfigured(),
        });
        return;
      }
      res.status(502).json({
        error: "checkout_failed",
        message: String((err as Error).message || err),
        stripeConfigured: isStripeConfigured(),
      });
    }
  },
);

// ---------------------------------------------------------------------------
// A-062 — THE STRIPE CUSTOMER PORTAL, USER SCOPED.
//
// `public/terms.html` promises every customer: "You can cancel a paid plan
// through the Stripe billing flow in the product." Before this route no such
// flow existed for a PE user. The terms are the document a customer is held to
// and holds us to, so the ruling was to keep the promise and build the
// capability rather than amend the sentence.
//
// THE CUSTOMER ID COMES FROM THE SESSION AND NOWHERE ELSE. Not the body, not a
// header, not the query string. A caller-supplied one is REFUSED with a named
// 400 rather than ignored: ignoring it is correct behaviour that produces no
// evidence, so an attempt to open somebody else's portal would look exactly
// like an ordinary request in every log we keep. A refusal is the same
// security outcome plus a record.
// ---------------------------------------------------------------------------

/**
 * Every spelling of "customer id" a caller might put on the wire. Checked
 * against the body, the query string and the headers — the three sources the
 * card names — because the point is not to reject one field name but to make
 * the whole class unreachable.
 *
 * Header spellings carry the `x-` forms an intermediary would add. Express
 * lowercases header names, so the comparison is done lowercased on both sides.
 */
const PE_PORTAL_REJECTED_CUSTOMER_KEYS: readonly string[] = [
  "customer",
  "customerid",
  "customer_id",
  "stripecustomerid",
  "stripe_customer_id",
  "stripecustomer",
  "stripe_customer",
];

const PE_PORTAL_REJECTED_CUSTOMER_HEADERS: readonly string[] = [
  "x-stripe-customer-id",
  "x-stripe-customer",
  "x-customer-id",
  "x-pe-stripe-customer-id",
];

/**
 * The first place a caller tried to supply a customer id, or null.
 *
 * Returns WHERE it was found rather than a boolean, so the 400 body can name
 * the source and the log line is diagnostic instead of a bare refusal count.
 */
function peSuppliedCustomerIdSource(req: Request): string | null {
  const body = req.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    for (const key of Object.keys(body as Record<string, unknown>)) {
      if (PE_PORTAL_REJECTED_CUSTOMER_KEYS.includes(key.toLowerCase())) {
        return `body.${key}`;
      }
    }
  }
  for (const key of Object.keys(req.query ?? {})) {
    if (PE_PORTAL_REJECTED_CUSTOMER_KEYS.includes(key.toLowerCase())) {
      return `query.${key}`;
    }
  }
  for (const name of PE_PORTAL_REJECTED_CUSTOMER_HEADERS) {
    if (req.headers[name] !== undefined) return `header.${name}`;
  }
  return null;
}

/**
 * `returnUrl` is REQUIRED, which is the whole of acceptance item 4.
 *
 * The neighbouring checkout schemas make it optional and fall back to
 * `defaultPeCheckoutSuccessUrl()`, which resolves through `peWebAppBaseUrl()`
 * to the hardcoded `https://property-explorer-xi.vercel.app` whenever
 * `PE_WEB_APP_BASE_URL` is unset. That default would land a Smart Site
 * customer on a stale Vercel host after cancelling their plan. Making the
 * field required means the wrong destination is not reachable from this route
 * at all, rather than reachable-but-unlikely.
 *
 * `.strict()` refuses unknown keys. That is what turns the customer-id check
 * above from a blocklist of spellings into a closed set: a spelling nobody
 * thought of still fails here, it just fails as `invalid_request` rather than
 * with the named error.
 */
const PeBillingPortalBodySchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

/**
 * Open the Stripe Customer Portal for the signed-in user (A-062).
 *
 * Distinct from the install-scoped `POST /api/brokerage/v1/billing/portal`,
 * which resolves a `brokerage_wallets` customer from an extension install id
 * and MAY create one. This route resolves `pe_user_entitlements
 * .stripe_customer_id` for the session's own user and NEVER creates one:
 * asking to manage billing is not a purchase, and a free user who clicks
 * "cancel subscription" to see what it says must not acquire a Stripe customer
 * record as a side effect of the click.
 *
 * Status codes, each a distinct state and none of them 500:
 *   401 authentication_required   no session (requirePeAuthenticated)
 *   400 customer_id_not_accepted  a caller tried to supply a customer id
 *   400 invalid_request           bad/absent returnUrl, or an unknown key
 *   400 return_url_not_allowed    a well-formed URL off the Smart Site hosts
 *   409 no_billing_account        signed in, never had a Stripe customer
 *   503 portal_unavailable        Stripe is not configured on this deployment
 *   502 portal_failed             Stripe answered with an error
 */
router.post(
  PE_BILLING_PORTAL_ROUTE,
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = resolvePeOwnerUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const suppliedFrom = peSuppliedCustomerIdSource(req);
    if (suppliedFrom) {
      res.status(400).json({
        error: "customer_id_not_accepted",
        message:
          "The billing portal always opens on the signed-in account's own Stripe customer. A customer id on the request is refused, never honoured.",
        source: suppliedFrom,
      });
      return;
    }

    const parsed = PeBillingPortalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        message:
          "returnUrl is required and must be an absolute URL. This route has no default return destination on purpose.",
      });
      return;
    }
    if (!isAllowedPeReturnUrl(parsed.data.returnUrl)) {
      // REFUSED, never rewritten to a host we prefer. A silently changed
      // destination is the same defect as the stale default, one layer down.
      res.status(400).json({
        error: "return_url_not_allowed",
        message:
          "returnUrl must point at a Smart Site host over https. It is refused rather than rewritten.",
      });
      return;
    }

    try {
      const result = await createPeBillingPortalSession({
        userId,
        returnUrl: parsed.data.returnUrl,
      });
      if (result.kind === "no-billing-account") {
        // DECLARED ABSENCE, not an error and not somebody else's portal.
        // The ordinary state of every free account. `hasBillingAccount` is
        // spelled out so the client renders the honest row rather than
        // inferring an account state from a status code.
        res.status(409).json({
          error: "no_billing_account",
          hasBillingAccount: false,
          message:
            "This account has no billing history, so there is no Stripe billing portal to open. A plan bought on this account will create one.",
        });
        return;
      }
      if (result.kind === "not-configured") {
        // NOT SIMULATED. A fake portal URL would make the terms sentence read
        // true while cancelling nothing, which is the defect this card exists
        // to close.
        res.status(503).json({
          error: "portal_unavailable",
          message:
            "Stripe is not configured on this deployment, so no billing portal can be opened. Nothing was changed.",
          stripeConfigured: false,
        });
        return;
      }
      res.json({
        ok: true,
        mode: result.mode,
        portalUrl: result.portalUrl,
        stripeConfigured: isStripeConfigured(),
      });
    } catch (err) {
      res.status(502).json({
        error: "portal_failed",
        message: String((err as Error).message || err),
        stripeConfigured: isStripeConfigured(),
      });
    }
  },
);

const PePropertyUnlockCheckoutBodySchema = z.object({
  parcelNodeId: z.string().min(1).max(128),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  returnUrl: z.string().url().optional(),
  uiMode: z.enum(["hosted", "custom", "embedded", "elements"]).optional(),
});

/**
 * $15 one-time per-property unlock checkout (WDLL 2026-08-05 item 4 of the
 * dispatch build spec — the $15 unlock). Webhook writes the
 * `pe_property_unlocks` row on completion via `createPePropertyUnlock`
 * (`source: "stripe"`); this route only opens the Checkout Session.
 */
router.post(
  [
    "/property-explorer/v1/billing/property-unlock/checkout",
    // WA2 client contract alias (PR #152 billingClient.ts).
    "/property-explorer/v1/entitlement/checkout",
  ],
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = resolvePeOwnerUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = PePropertyUnlockCheckoutBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const parcelNodeId = parsed.data.parcelNodeId.trim();
    if (!isValidParcelNodeId(parcelNodeId)) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }
    try {
      const email = await getPeUserEmail(userId);
      const session = await createPePropertyUnlockCheckoutSession({
        userId,
        email,
        parcelNodeId,
        installId: installIdFromRequest(req),
        successUrl: parsed.data.successUrl ?? defaultPeCheckoutSuccessUrl(),
        cancelUrl: parsed.data.cancelUrl ?? defaultPeCheckoutCancelUrl(),
        returnUrl: parsed.data.returnUrl,
        uiMode: parsed.data.uiMode,
      });
      res.json({
        ...session,
        parcelNodeId,
        stripeConfigured: isStripeConfigured(),
        honestNote: isStripeConfigured()
          ? undefined
          : "Stripe credentials not configured — simulated checkout only",
      });
    } catch (err) {
      if (err instanceof PeCheckoutConfigError) {
        res.status(503).json({
          error: "checkout_unavailable",
          message: err.message,
          missing: err.missing,
          stripeConfigured: isStripeConfigured(),
        });
        return;
      }
      res.status(502).json({
        error: "checkout_failed",
        message: String((err as Error).message || err),
        stripeConfigured: isStripeConfigured(),
      });
    }
  },
);

const DevRoleBodySchema = z.object({
  userId: z.string().min(1).max(128),
  devRole: z.boolean(),
});

/**
 * Internal service-key route (WDLL 2026-08-05 item 4): operator grant/revoke
 * of the server-side dev role, no deploy required. Service-token guarded
 * ({@link requireServiceToken}) — not reachable from a browser session, so
 * this is an operator/ops-tooling call, not a self-service one. Revocation
 * closes every gate on the very next entitlement read since
 * {@link hasPeDevPaidBypass} and `/entitlement` both read the row live.
 */
const ShareGrantIdSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "grant id must be a UUID",
  );

const ShareGrantInsertSchema = z.object({
  id: ShareGrantIdSchema,
  grantorUserId: z.string().trim().min(1).max(128),
  grantorTenantId: z.string().trim().min(1).max(128),
  parcelNodeId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine(isValidParcelNodeId, { message: "invalid parcelNodeId" }),
  createdAt: z.string().trim().min(1),
  expiresAt: z.string().trim().min(1),
  revokedAt: z.string().trim().min(1).nullable().optional(),
});

function shareGrantJson(row: typeof peShareGrants.$inferSelect) {
  return {
    id: row.id,
    grantorUserId: row.grantorUserId,
    grantorTenantId: row.grantorTenantId,
    parcelNodeId: row.parcelNodeId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

/**
 * P-86 share grant registry. Service-key only. The PE BFF writes a row
 * before minting /s/{id}; the view BFF resolves that row. HMAC never stored.
 */
router.post(
  "/property-explorer/v1/internal/share-grants",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = ShareGrantInsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const createdAt = new Date(parsed.data.createdAt);
    const expiresAt = new Date(parsed.data.expiresAt);
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const inserted = await db
      .insert(peShareGrants)
      .values({
        id: parsed.data.id,
        grantorUserId: parsed.data.grantorUserId,
        grantorTenantId: parsed.data.grantorTenantId,
        parcelNodeId: parsed.data.parcelNodeId,
        createdAt,
        expiresAt,
        revokedAt: parsed.data.revokedAt ? new Date(parsed.data.revokedAt) : null,
      })
      .returning();
    const row = inserted[0];
    if (!row || row.id !== parsed.data.id) {
      res.status(503).json({ error: "grant_persist_failed" });
      return;
    }
    res.status(200).json(shareGrantJson(row));
  },
);

router.get(
  "/property-explorer/v1/internal/share-grants/:id",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = ShareGrantIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const rows = await db
      .select()
      .from(peShareGrants)
      .where(eq(peShareGrants.id, parsed.data))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "share_grant_not_found" });
      return;
    }
    res.status(200).json(shareGrantJson(row));
  },
);

router.post(
  "/property-explorer/v1/internal/share-grants/:id/revoke",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = ShareGrantIdSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const revokedAtRaw =
      typeof req.body?.revokedAt === "string" ? req.body.revokedAt : "";
    const revokedAt = revokedAtRaw ? new Date(revokedAtRaw) : new Date();
    if (Number.isNaN(revokedAt.getTime())) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const updated = await db
      .update(peShareGrants)
      .set({ revokedAt })
      .where(eq(peShareGrants.id, parsed.data))
      .returning();
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "share_grant_not_found" });
      return;
    }
    res.status(200).json(shareGrantJson(row));
  },
);

router.post(
  "/property-explorer/v1/internal/dev-role",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const parsed = DevRoleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const { userId, devRole } = parsed.data;
    await setPeDevRole(userId, devRole);
    res.json({ ok: true, userId, devRole });
  },
);

const PeRecordsRequestPostSchema = z
  .object({
    parcelNodeId: z.string().min(1).max(128),
    countyFips: z.string().regex(/^\d{5}$/).optional(),
    placeKey: z.string().min(1).optional(),
  })
  .strict();

function peReqLog(req: Request): typeof logger {
  return (req as unknown as { log?: typeof logger }).log ?? logger;
}

/**
 * P-85 item 7+8 — service-token hook: vision read then classify/write instruments.
 */
router.post(
  "/property-explorer/v1/internal/records-request/vision-read",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const jobId =
      typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
    if (!jobId) {
      res.status(400).json({ error: "missing_job_id" });
      return;
    }
    try {
      const { vision, classification } =
        await processRecordsRequestJobVisionReads(jobId);
      res.status(200).json({ jobId, results: vision, classification });
    } catch (err) {
      peReqLog(req).error({ err, jobId }, "records request vision-read failed");
      res.status(500).json({
        error: "vision_read_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * P-85 item 8 — classify/write only (when vision text already on artifact metadata).
 */
router.post(
  "/property-explorer/v1/internal/records-request/classify",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const jobId =
      typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
    if (!jobId) {
      res.status(400).json({ error: "missing_job_id" });
      return;
    }
    try {
      const { processRecordsRequestJobClassification } = await import(
        "../lib/recordsRequestClassifyWrite"
      );
      const classification = await processRecordsRequestJobClassification(jobId);
      res.status(200).json({ jobId, classification });
    } catch (err) {
      peReqLog(req).error({ err, jobId }, "records request classify failed");
      res.status(500).json({
        error: "classify_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * P-85 item 9 — corridor geometry derivation for classified clauses.
 */
router.post(
  "/property-explorer/v1/internal/records-request/corridor-derive",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const jobId =
      typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
    if (!jobId) {
      res.status(400).json({ error: "missing_job_id" });
      return;
    }
    try {
      const { processRecordsRequestCorridorDerivations } = await import(
        "../lib/recordsRequestCorridorWrite"
      );
      const corridors = await processRecordsRequestCorridorDerivations(jobId);
      res.status(200).json({ jobId, corridors });
    } catch (err) {
      peReqLog(req).error({ err, jobId }, "records request corridor derive failed");
      const message = err instanceof Error ? err.message : String(err);
      const status =
        message === "records_request_job_not_found" ||
        message === "records_request_job_missing_parcel_geometry"
          ? 422
          : 500;
      res.status(status).json({
        error: "corridor_derive_failed",
        detail: message,
      });
    }
  },
);

/**
 * P-85 item 11 — worker/service hook to send completion email via Resend.
 */
router.post(
  "/property-explorer/v1/internal/records-request/notify",
  requireServiceToken,
  async (req: Request, res: Response) => {
    const jobId =
      typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
    if (!jobId) {
      res.status(400).json({ error: "missing_job_id" });
      return;
    }
    const kindRaw =
      typeof req.body?.kind === "string" ? req.body.kind.trim() : undefined;
    try {
      const event = await notifyRecordsRequestCompletion({
        jobId,
        ...(kindRaw
          ? { kind: kindRaw as Parameters<typeof notifyRecordsRequestCompletion>[0]["kind"] }
          : {}),
      });
      res.status(200).json({ jobId, event });
    } catch (err) {
      peReqLog(req).error({ err, jobId }, "records request notify failed");
      res.status(500).json({
        error: "notify_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * P-85 PE bridge — start Records Request by parcelNodeId (no engagementId
 * in the browser). Resolves or creates a PE-scoped engagement with briefing
 * geometry, then enqueues the same job worker as the engagement routes.
 */
router.post(
  "/property-explorer/v1/records-request",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const parsed = PeRecordsRequestPostSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }

    const parcelNodeId = parsed.data.parcelNodeId.trim();
    if (!isValidParcelNodeId(parcelNodeId)) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }

    const countyFips =
      parsed.data.countyFips?.trim() ??
      countyFipsFromParcelNodeId(parcelNodeId);
    if (!countyFips) {
      res.status(400).json({ error: "county_fips_required" });
      return;
    }
    if (!isP85CountyFips(countyFips)) {
      res.status(422).json({
        error: "county_out_of_scope",
        countyFips,
      });
      return;
    }

    const parcelKey = `apn:${parcelNodeId}`;
    const ensured = await ensurePeRecordsEngagement(
      scope.ownerUserId,
      scope.tenantId,
      parcelNodeId,
      parcelKey,
      countyFips,
    );
    if (!ensured.ok) {
      res.status(ensured.status).json(ensured.body);
      return;
    }

    const result = await createRecordsRequestJob({
      engagementId: ensured.engagementId,
      userId: scope.ownerUserId,
      parcelKey,
      countyFips,
      placeKey: parsed.data.placeKey ?? null,
      log: peReqLog(req),
    });
    res.status(result.status).json({
      ...result.body,
      parcelNodeId,
      peEngagementCreated: ensured.created,
    });
  },
);

router.get(
  "/property-explorer/v1/records-request",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }

    const parcelNodeIdRaw = req.query.parcelNodeId;
    const parcelNodeIdUntyped = Array.isArray(parcelNodeIdRaw)
      ? parcelNodeIdRaw[0]
      : parcelNodeIdRaw;
    if (typeof parcelNodeIdUntyped !== "string") {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }
    const parcelNodeId = parcelNodeIdUntyped.trim();
    if (!parcelNodeId || !isValidParcelNodeId(parcelNodeId)) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }

    const found = await findPeRecordsEngagement(
      scope.ownerUserId,
      scope.tenantId,
      parcelNodeId,
    );
    if (!found.ok) {
      res.status(200).json({
        parcelNodeId,
        engagementId: null,
        jobs: [],
      });
      return;
    }

    const body = await listRecordsRequestJobsWire(
      found.engagementId,
      scope.ownerUserId,
    );
    res.status(200).json({
      parcelNodeId,
      ...body,
    });
  },
);

const RecordsRequestArtifactIdParamsSchema = z.object({
  artifactId: z.string().uuid(),
});

router.get(
  "/property-explorer/v1/records-request/artifacts/:artifactId/document",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = RecordsRequestArtifactIdParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_artifact_id" });
      return;
    }
    const result = await loadRecordsRequestArtifactDocumentForUser({
      artifactId: parsed.data.artifactId,
      userId: scope.ownerUserId,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).send(result.bytes);
  },
);

router.get(
  "/property-explorer/v1/records-request/inbox",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const body = await listRecordsRequestInboxWire(scope.ownerUserId);
    res.status(200).json(body);
  },
);

const RecordsRequestJobIdParamsSchema = z.object({
  jobId: z.string().uuid(),
});

router.post(
  "/property-explorer/v1/records-request/:jobId/approve-purchase",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = RecordsRequestJobIdParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_job_id" });
      return;
    }
    const result = await approveRecordsRequestPurchase({
      jobId: parsed.data.jobId,
      userId: scope.ownerUserId,
    });
    res.status(result.status).json(result.body);
  },
);

router.post(
  "/property-explorer/v1/records-request/:jobId/decline-purchase",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const scope = ownerScope(req);
    if (!scope) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = RecordsRequestJobIdParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_job_id" });
      return;
    }
    const result = await declineRecordsRequestPurchase({
      jobId: parsed.data.jobId,
      userId: scope.ownerUserId,
    });
    res.status(result.status).json(result.body);
  },
);

const PeTeamInviteBodySchema = z.object({
  email: z.string().min(3).max(320),
  role: z.enum(["owner", "member"]),
});

const PeTeamRoleBodySchema = z.object({
  role: z.enum(["owner", "member"]),
});

function teamUserId(req: Request): string | null {
  return resolvePeOwnerUserId(req);
}

/**
 * P-87 Claude Sync — which AI clients have connected to this account.
 *
 * Written by the Smart Site MCP server on a naming `initialize`. The PE card
 * reads `claude` to decide between its setup state and its sync state, and an
 * account with no row reads as `claude: null`, which the card renders as
 * setup instructions. That is the fail-closed direction: an unread or empty
 * signal shows someone how to connect, never a Sync button for a connection
 * that was never made.
 *
 * Signed in only. There is no account-less answer to this question.
 */
router.get(
  "/property-explorer/v1/ai-connections",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const ownerUserId = resolvePeOwnerUserId(req);
    if (!ownerUserId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      res.status(200).json(await readAiConnections(ownerUserId));
    } catch {
      res.status(500).json({ error: "ai_connections_unavailable" });
    }
  },
);

router.get(
  "/property-explorer/v1/team/members",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = teamUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      const roster = await readTeamRoster(userId);
      res.status(200).json(roster);
    } catch (err) {
      const mapped = teamErrorBody(err);
      res.status(mapped.status).json(mapped.body);
    }
  },
);

router.post(
  "/property-explorer/v1/team/invitations",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = teamUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = PeTeamInviteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.some((i) => i.path[0] === "role")
          ? "invalid_role"
          : "invalid_email",
      });
      return;
    }
    try {
      const created = await createTeamInvitation(userId, parsed.data);
      res.status(201).json(created);
    } catch (err) {
      const mapped = teamErrorBody(err);
      res.status(mapped.status).json(mapped.body);
    }
  },
);

router.delete(
  "/property-explorer/v1/team/invitations/:id",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = teamUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const id = typeof req.params.id === "string" ? req.params.id : "";
    if (!id) {
      res.status(400).json({ error: "invitation_not_found" });
      return;
    }
    try {
      await cancelTeamInvitation(userId, id);
      res.status(204).end();
    } catch (err) {
      const mapped = teamErrorBody(err);
      res.status(mapped.status).json(mapped.body);
    }
  },
);

router.delete(
  "/property-explorer/v1/team/members/:email",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = teamUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const email = typeof req.params.email === "string" ? req.params.email : "";
    try {
      await removeTeamMember(userId, email);
      res.status(204).end();
    } catch (err) {
      const mapped = teamErrorBody(err);
      res.status(mapped.status).json(mapped.body);
    }
  },
);

router.patch(
  "/property-explorer/v1/team/members/:email",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const userId = teamUserId(req);
    if (!userId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = PeTeamRoleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_role" });
      return;
    }
    const email = typeof req.params.email === "string" ? req.params.email : "";
    try {
      await patchTeamMemberRole(userId, email, parsed.data.role);
      res.status(204).end();
    } catch (err) {
      const mapped = teamErrorBody(err);
      res.status(mapped.status).json(mapped.body);
    }
  },
);

/**
 * P-98 — every ACTIVE unlock on this account, with its expiry.
 *
 * `GET /entitlement` with `?parcelNodeId=` answers "is this one parcel
 * unlocked". It cannot answer "what is unlocked, and what is about to lapse",
 * which is the next-action rail's highest-intent rung. This route is that
 * read, and it is a sibling of `/entitlement` rather than a widening of it:
 * the existing route's shape is pinned by the R1 contract and stays untouched.
 *
 * Signed in only. There is no account-less answer to an account question.
 * Anonymous callers get 401, not an empty list — an empty list would say
 * "you have unlocked nothing", which is a claim about an account that was
 * never identified.
 *
 * IMPORTANT, CLIENT SIDE: this path must be in `DEEP_GET_EXACT` in
 * hauska-map `apps/property-explorer/api/_lib/deep-allowlist.ts` or it
 * returns 403 and the rail reads that as a failed read.
 */
router.get(
  "/property-explorer/v1/entitlement/unlocks",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const ownerUserId = resolvePeOwnerUserId(req);
    if (!ownerUserId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    try {
      res.status(200).json(await readActiveUnlocks(ownerUserId));
    } catch {
      // Fail LOUD. An unreadable unlock list must not degrade to an empty
      // one: the rail would then go quiet, which is indistinguishable from
      // an account that genuinely has nothing expiring.
      res.status(500).json({ error: "unlocks_unavailable" });
    }
  },
);

/**
 * P-98 — record one activation event (a ladder rung was shown, or acted on).
 *
 * Scoped to the signed-in PE user. `gtm_events` is keyed on `install_id` for
 * the browser extension and cannot answer a question about an account.
 *
 * Body: `{ event_type: "shown" | "acted", action_id, surface? }`.
 *
 * REFUSES rather than defaults. An unknown `event_type` or `action_id` is a
 * 400 naming the allowed set, never a row written under a substituted value:
 * this table is the only activation measurement that will exist, and a
 * fabricated row is indistinguishable from a real one once written. The 400
 * body carries the vocabulary so a client/server drift explains itself the
 * first time anyone reads a response.
 *
 * The SERVER always declares its failures. The client is separately
 * instructed to drop failed events silently, which is an acceptable
 * degradation only because it is deliberate on that side and declared here.
 *
 * IMPORTANT, CLIENT SIDE: this path must be in `DEEP_POST_EXACT` in
 * hauska-map `apps/property-explorer/api/_lib/deep-allowlist.ts` or it
 * returns 403 and no activation event is ever recorded.
 */
router.post(
  "/property-explorer/v1/activation-events",
  requirePeAuthenticated,
  async (req: Request, res: Response) => {
    const ownerUserId = resolvePeOwnerUserId(req);
    if (!ownerUserId) {
      res.status(401).json({ error: "authentication_required" });
      return;
    }
    const parsed = parseActivationEvent(req.body);
    if (!parsed.ok) {
      res.status(400).json(parsed.refusal);
      return;
    }
    try {
      const event = await recordActivationEvent(ownerUserId, parsed.value);
      res.status(201).json({ ok: true, event });
    } catch {
      res.status(500).json({ error: "activation_event_not_recorded" });
    }
  },
);

export default router;
