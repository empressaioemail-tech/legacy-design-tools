/**
 * Property Explorer v1 API — saved properties, entitlement, deep research scaffold.
 *
 * WDLL items 13, 14, 15, 17 (R1 scaffold).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { db, peSavedProperties } from "@workspace/db";
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
import { requireServiceToken } from "../middlewares/serviceAuth";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import {
  isValidParcelNodeId,
  loadBakedNodeFacetSnapshot,
} from "./brokerageNodeFacets";

const router: IRouter = Router();

type JsonRecord = Record<string, unknown>;

type BriefSection = {
  id: "zoning" | "setbacks-envelope" | "flood" | "land-use";
  title: string;
  data: unknown;
  citations: string[];
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function urlsFrom(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (candidate: unknown, key?: string): void => {
    if (typeof candidate === "string") {
      if (
        key &&
        /(?:citation|source).*url|url.*(?:citation|source)/i.test(key) &&
        /^https?:\/\//i.test(candidate)
      ) {
        urls.add(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, key));
      return;
    }
    const record = asRecord(candidate);
    if (record) {
      Object.entries(record).forEach(([nestedKey, nestedValue]) =>
        visit(nestedValue, nestedKey),
      );
    }
  };
  visit(value);
  return [...urls];
}

function verbatimValues(value: unknown, keys: ReadonlySet<string>): string[] {
  const values = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    for (const [key, nested] of Object.entries(record)) {
      if (keys.has(key) && typeof nested === "string" && nested.trim()) {
        values.add(nested);
      }
      visit(nested);
    }
  };
  visit(value);
  return [...values];
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

function buildR1Brief(facets: unknown, tier2: unknown): {
  sections: BriefSection[];
  disclosure: string[];
  citations: string[];
} {
  const root = asRecord(facets) ?? {};
  const baseFacts = asRecord(root.baseFacts) ?? {};
  const envelope = root.envelope ?? null;
  const sections: BriefSection[] = [
    { id: "zoning", title: "Zoning", data: root.zoning ?? null, citations: urlsFrom(root.zoning) },
    {
      id: "setbacks-envelope",
      title: "Setbacks and buildable envelope",
      data: envelope,
      citations: urlsFrom(envelope),
    },
    {
      id: "flood",
      title: "Flood",
      data: asRecord(tier2)?.flood ?? null,
      citations: urlsFrom(asRecord(tier2)?.flood),
    },
    {
      id: "land-use",
      title: "Land use",
      data: baseFacts.landUse ?? null,
      citations: urlsFrom(baseFacts.landUse),
    },
  ];
  const disclosures = verbatimValues(
    { facets, tier2 },
    new Set(["districtNote", "disclosure", "emptyReason"]),
  );
  return {
    sections,
    disclosure: disclosures,
    citations: [...new Set(sections.flatMap((section) => section.citations))],
  };
}

function manifestLayers(facets: unknown, tier2: unknown): {
  layers: Array<Record<string, unknown>>;
  degraded: boolean;
  reason?: string;
} {
  const envelope = asRecord(facets)?.envelope;
  const envelopeGeojson = asRecord(envelope)?.geojson;
  const flood = asRecord(tier2)?.flood;
  const layers: Array<Record<string, unknown>> = [];
  if (envelopeGeojson) {
    layers.push({
      id: "buildable-envelope",
      kind: "geojson",
      feature: envelopeGeojson,
      source: "baked-snapshot",
    });
  }
  if (flood) {
    layers.push({
      id: "flood",
      kind: "flood-facet",
      data: flood,
      source: "baked-snapshot",
    });
  }
  return layers.length > 0
    ? { layers, degraded: false }
    : {
        layers,
        degraded: true,
        reason: "Baked snapshot has no envelope geometry or Tier-2 flood facet.",
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
    tenantId: snap.tenantId,
    userId: snap.userId,
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
    res.json(rows);
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
    const label = parsed.data.label ?? null;
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
    const parcelNodeId =
      typeof req.body?.parcelNodeId === "string"
        ? req.body.parcelNodeId.trim()
        : "";
    if (!parcelNodeId || !isValidParcelNodeId(parcelNodeId)) {
      res.status(400).json({ error: "invalid_parcel_node_id" });
      return;
    }
    const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
    if (!snapshot) {
      res.status(404).json({
        error: "baked_snapshot_not_found",
        message: "No baked facet snapshot exists for this parcel node.",
        parcelNodeId,
      });
      return;
    }
    const root = asRecord(snapshot.facets);
    const bakedAt =
      typeof root?.bakedAt === "string" ? root.bakedAt : snapshot.snapshotAt;
    const brief = buildR1Brief(snapshot.facets, snapshot.tier2);
    res.json({
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
    });
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

export default router;
