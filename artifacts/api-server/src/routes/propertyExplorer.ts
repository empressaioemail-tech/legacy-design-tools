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
  PE_FREE_CHAT_MESSAGE_LIMIT,
  createPePropertyUnlock,
  getPeFreeChatMessagesUsed,
  hasPeDevPaidBypass,
  isPePropertyEntitled,
  requirePeAuthenticated,
  requirePePaidOrPropertyUnlocked,
  resolvePeEntitlement,
  resolvePeOwnerUserId,
} from "../lib/peEntitlement";
import { setPeDevRole } from "../lib/peIdentity";
import { requireServiceToken } from "../middlewares/serviceAuth";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import {
  isValidParcelNodeId,
  loadBakedNodeFacetSnapshot,
} from "./brokerageNodeFacets";
import {
  loadFloodHazardFactAtom,
} from "../lib/floodHazardFactRead";
import { loadBoundaryEdgeFactAtom } from "../lib/boundaryEdgeFactRead";
import { loadPipelineFactAtom } from "../lib/pipelineFactRead";
import { loadWellFactAtom } from "../lib/wellFactRead";
import { loadStructuralFactAtom } from "../lib/structuralFactRead";
import { loadSpecialDistrictFactAtom } from "../lib/specialDistrictFactRead";
import { tryAssembleParcelDrawFromReads } from "../lib/parcelDrawFromReads";
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
  createPeSubscriptionCheckoutSession,
  createPePropertyUnlockCheckoutSession,
  defaultPeCheckoutCancelUrl,
  defaultPeCheckoutSuccessUrl,
  PeCheckoutConfigError,
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

async function assembleNodeBriefBody(
  parcelNodeId: string,
): Promise<Record<string, unknown> | null> {
  const [
    snapshot,
    floodHazardFact,
    boundaryFact,
    pipelineFact,
    wellFact,
    structuralFact,
    specialDistrictFact,
  ] = await Promise.all([
    loadBakedNodeFacetSnapshot(parcelNodeId),
    loadFloodHazardFactAtom(parcelNodeId),
    loadBoundaryEdgeFactAtom(parcelNodeId),
    loadPipelineFactAtom(parcelNodeId),
    loadWellFactAtom(parcelNodeId),
    loadStructuralFactAtom(parcelNodeId),
    loadSpecialDistrictFactAtom(parcelNodeId),
  ]);
  if (!snapshot) return null;
  const root = asRecord(snapshot.facets);
  const bakedAt =
    typeof root?.bakedAt === "string" ? root.bakedAt : snapshot.snapshotAt;
  const brief = buildR1Brief(snapshot.facets, snapshot.tier2, {
    floodHazardFact,
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
  });
  const draw = tryAssembleParcelDrawFromReads({
    parcelNodeId,
    facets: snapshot.facets,
    bakedAt,
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
    boundary: boundaryFact,
    flood: floodHazardFact,
    pipeline: pipelineFact,
    well: wellFact,
    specialDistrict: specialDistrictFact,
    structural: structuralFact,
  });
  return {
    runId: buildR1RunId(parcelNodeId, bakedAt),
    reportFamily: "R1",
    mode: "baked-facet-intel-v1",
    parcelNodeId,
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
  const floodHazardFact = await loadFloodHazardFactAtom(parcelNodeId);
  return composeSmartSiteStub({
    parcelNodeId,
    facets: snapshot.facets,
    flood: floodReadToRail(floodHazardFact),
    drainage: { attempted: false },
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
  });
}

function manifestLayers(facets: unknown, tier2: unknown): {
  layers: Array<Record<string, unknown>>;
  degraded: boolean;
  reason?: string;
} {
  const envelope = asRecord(facets)?.envelope;
  const envelopeGeojson = asRecord(envelope)?.geojson;
  // No flood layer is emitted from a baked snapshot any more: the Tier-2 flood
  // facet is retired at the read path (SS-W16). The disposition is read only to
  // make the degrade reason name the retirement instead of implying the data
  // was never there.
  const floodRefusal = asRecord(asRecord(tier2)?.floodDisposition);
  const layers: Array<Record<string, unknown>> = [];
  if (envelopeGeojson) {
    layers.push({
      id: "buildable-envelope",
      kind: "geojson",
      feature: envelopeGeojson,
      source: "baked-snapshot",
    });
  }
  return layers.length > 0
    ? { layers, degraded: false }
    : {
        layers,
        degraded: true,
        reason: floodRefusal
          ? "Baked snapshot has no envelope geometry, and its Tier-2 flood facet is refused: " +
            String(floodRefusal.reason ?? floodRefusal.code)
          : "Baked snapshot has no envelope geometry, and no Tier-2 row exists for this node.",
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
 */
router.get("/property-explorer/v1/entitlement", async (req: Request, res: Response) => {
  const snap = await resolvePeEntitlement(req);
  const base = {
    authenticated: snap.authenticated,
    tier: snap.tier,
    /** Ladder rung (LOCKED 2026-08-10) — the PE BFF gates Studio-only
     *  surfaces (CAD, terrain, owner data) on studio|team, never bare tier. */
    subscriptionTier: snap.subscriptionTier,
    tenantId: snap.tenantId,
    userId: snap.userId,
    devRole: snap.devRole,
    entitlementSource: snap.entitlementSource,
  };
  const parcelNodeIdRaw = req.query.parcelNodeId;
  const parcelNodeId = (
    Array.isArray(parcelNodeIdRaw) ? parcelNodeIdRaw[0] : parcelNodeIdRaw
  );
  if (!snap.authenticated || !snap.userId || typeof parcelNodeId !== "string" || !parcelNodeId.trim()) {
    res.json(base);
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
    ...base,
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
    res.json(
      rows.map((row) => {
        const composed = projectSavedPropertyLabel(row.parcelNodeId, row.label);
        return {
          ...row,
          label: composed.label,
          situs: composed.situs,
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

    if (parsed.mode === "single") {
      const parcelNodeId = parsed.ids[0]!;
      if (!isValidParcelNodeId(parcelNodeId)) {
        res.status(400).json({ error: "invalid_parcel_node_id" });
        return;
      }
      if (parsed.depth === "stub") {
        const stub = await assembleStubBody(parcelNodeId);
        if (!stub) {
          res.status(404).json({
            error: "baked_snapshot_not_found",
            message: "No baked facet snapshot exists for this parcel node.",
            parcelNodeId,
          });
          return;
        }
        res.json(stub);
        return;
      }
      const body = await assembleNodeBriefBody(parcelNodeId);
      if (!body) {
        res.status(404).json({
          error: "baked_snapshot_not_found",
          message: "No baked facet snapshot exists for this parcel node.",
          parcelNodeId,
        });
        return;
      }
      res.json(body);
      return;
    }

    const parcels: unknown[] = [];
    const notFound: string[] = [];
    const results = await Promise.all(
      parsed.ids.map(async (id) => {
        if (!isValidParcelNodeId(id)) {
          return { id, row: null };
        }
        const row =
          parsed.depth === "node"
            ? await assembleNodeBriefBody(id)
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
    const manifest = manifestLayers(snapshot.facets, snapshot.tier2);
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
    /** Team only: TOTAL seats desired. Base price covers 10; +$25/mo each above. */
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
      body.seats <= 10,
    {
      // No annual extra-seat price exists (seats stay monthly $25, ruled
      // 2026-08-24) and Stripe cannot mix intervals in one subscription.
      message:
        "annual Team billing covers at most the 10 included seats; extra seats bill monthly only",
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
      const session = await createPeSubscriptionCheckoutSession({
        userId,
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
      const session = await createPePropertyUnlockCheckoutSession({
        userId,
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

export default router;
