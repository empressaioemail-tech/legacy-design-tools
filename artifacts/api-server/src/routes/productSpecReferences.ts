/**
 * L5 — `product-spec-reference` endpoints (Cortex Lane C.4 / C.4.5).
 *
 *   POST /api/engagements/:engagementId/product-spec-references  create
 *   POST /api/product-spec-references/:referenceId/refresh       ICC-ES poll
 *   GET  /api/engagements/:engagementId/product-spec-references  list
 *   GET  /api/product-spec-references/:referenceId               fetch
 *
 * All routes gated by {@link requireServiceTokenOrSession}. Responses
 * are full atom instances conforming to `PRODUCT_SPEC_REFERENCE_SCHEMA`.
 *
 * The `refresh` route does a real synchronous ICC-ES poll (see
 * `lib/iccEsClient.ts`); an unreachable ICC-ES returns `502
 * icc_es_unreachable`. The periodic background re-poll is out of scope
 * (sprint Amendment 6) — this is the manual trigger only.
 *
 * Canonical contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L5.
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
  productSpecReferences,
  type ProductSpecReference,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  type ProductSpecReferenceAtomInstance,
  type ProductSpecStatus,
  type ProductSpecStatusChange,
} from "@workspace/atoms-l-surface";
import { logger } from "../lib/logger";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { L_SURFACE_SOURCE_ADAPTER, contentHashOf } from "../lib/lSurfaceAtom";
import {
  UUID_RE,
  resolveTenantId,
  resolveEventActor,
  recordLSurfaceEvent,
} from "../lib/lSurfaceRoute";
import {
  IccEsUnreachableError,
  iccEsReportUrl,
  pollIccEsStatus,
} from "../lib/iccEsClient";
import {
  parseCreateProductSpecReferenceBody,
  parseStatusFilter,
} from "./productSpecReference.logic";
import { generateProductSpecRecommendations } from "../lib/productSpecRecommendations";

const router: IRouter = Router();

router.use(requireServiceTokenOrSession);

/** Materialize a `product-spec-reference` atom instance from its row. */
function toProductSpecReferenceAtom(
  row: ProductSpecReference,
  tenantId: string,
): ProductSpecReferenceAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    product: { name: row.productName, manufacturer: row.productManufacturer },
    esrNumber: row.esrNumber,
    status: row.status as ProductSpecStatus,
    lastVerifiedAt: row.lastVerifiedAt.toISOString(),
    statusHistory: (row.statusHistory ?? []) as ProductSpecStatusChange[],
    engagementId: row.engagementId,
    findingId: row.findingId,
    responseTaskId: row.responseTaskId,
    createdAt: createdAtIso,
    actorId: row.actorId,
    principalActorId: row.principalActorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "product-spec-reference",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    // L5 is the one L-surface atom whose inherited `sourceUrl` carries
    // a real value — the ICC-ES listing URL the status was verified
    // against.
    sourceUrl: row.iccEsUrl,
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

async function loadReference(
  referenceId: string,
): Promise<ProductSpecReference | null> {
  const rows = await db
    .select()
    .from(productSpecReferences)
    .where(eq(productSpecReferences.id, referenceId))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  POST …/product-spec-references/generate-recommendations — QA-55 AI batch    */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/product-spec-references/generate-recommendations",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";

    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    try {
      const result = await generateProductSpecRecommendations(engagementId);
      if (!result) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }
      res.json({
        mode: result.mode,
        recommendations: result.recommendations,
      });
    } catch (err) {
      reqLog.error(
        { err, engagementId },
        "generate product-spec recommendations failed",
      );
      res
        .status(500)
        .json({ error: "Failed to generate product spec recommendations" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*   POST /api/engagements/:engagementId/product-spec-references  — create      */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/product-spec-references",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";

    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const parsed = parseCreateProductSpecReferenceBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const engagementRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!engagementRows[0]) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const now = new Date();
      const iccEsUrl = iccEsReportUrl(parsed.value.esrNumber);
      // Seed the status chain with the initial `active` observation so
      // the newest entry always mirrors the atom's current status.
      const statusHistory: ProductSpecStatusChange[] = [
        { status: "active", changedAt: now.toISOString(), sourceUrl: iccEsUrl },
      ];

      const [row] = await db
        .insert(productSpecReferences)
        .values({
          engagementId,
          productName: parsed.value.product.name,
          productManufacturer: parsed.value.product.manufacturer,
          esrNumber: parsed.value.esrNumber,
          status: "active",
          lastVerifiedAt: now,
          statusHistory,
          iccEsUrl,
          findingId: parsed.value.findingId,
          responseTaskId: parsed.value.responseTaskId,
          actorId: parsed.value.actorId,
          principalActorId: parsed.value.principalActorId,
        })
        .returning();
      if (!row) {
        throw new Error("product_spec_references insert returned no row");
      }

      const atom = toProductSpecReferenceAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "product-spec-reference",
        entityId: row.id,
        eventType: "product-spec-reference.created",
        actor: resolveEventActor(req),
        payload: { engagementId, esrNumber: atom.esrNumber },
      });

      res.status(201).json({ productSpecReference: atom });
    } catch (err) {
      reqLog.error(
        { err, engagementId },
        "create product-spec-reference failed",
      );
      res
        .status(500)
        .json({ error: "Failed to create product spec reference" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  GET /api/engagements/:engagementId/product-spec-references  — list          */
/* -------------------------------------------------------------------------- */

router.get(
  "/engagements/:engagementId/product-spec-references",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const engagementId =
      typeof req.params.engagementId === "string"
        ? req.params.engagementId
        : "";

    if (!UUID_RE.test(engagementId)) {
      res.status(404).json({ error: "engagement_not_found" });
      return;
    }

    const filter = parseStatusFilter(req.query.status);
    if (!filter.ok) {
      res.status(400).json({ error: filter.error });
      return;
    }

    try {
      const engagementRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!engagementRows[0]) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const where =
        filter.value === null
          ? eq(productSpecReferences.engagementId, engagementId)
          : and(
              eq(productSpecReferences.engagementId, engagementId),
              eq(productSpecReferences.status, filter.value),
            );

      const rows = await db
        .select()
        .from(productSpecReferences)
        .where(where)
        .orderBy(desc(productSpecReferences.createdAt));

      const tenantId = resolveTenantId(req);
      res.json({
        productSpecReferences: rows.map((r) =>
          toProductSpecReferenceAtom(r, tenantId),
        ),
      });
    } catch (err) {
      reqLog.error(
        { err, engagementId },
        "list product-spec-references failed",
      );
      res.status(500).json({ error: "Failed to list product spec references" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/product-spec-references/:referenceId  — fetch                 */
/* -------------------------------------------------------------------------- */

router.get(
  "/product-spec-references/:referenceId",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const referenceId =
      typeof req.params.referenceId === "string"
        ? req.params.referenceId
        : "";

    if (!UUID_RE.test(referenceId)) {
      res.status(404).json({ error: "product_spec_reference_not_found" });
      return;
    }

    try {
      const row = await loadReference(referenceId);
      if (!row) {
        res.status(404).json({ error: "product_spec_reference_not_found" });
        return;
      }
      res.json({
        productSpecReference: toProductSpecReferenceAtom(
          row,
          resolveTenantId(req),
        ),
      });
    } catch (err) {
      reqLog.error({ err, referenceId }, "fetch product-spec-reference failed");
      res.status(500).json({ error: "Failed to fetch product spec reference" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*   POST /api/product-spec-references/:referenceId/refresh  — ICC-ES poll       */
/* -------------------------------------------------------------------------- */

router.post(
  "/product-spec-references/:referenceId/refresh",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const referenceId =
      typeof req.params.referenceId === "string"
        ? req.params.referenceId
        : "";

    if (!UUID_RE.test(referenceId)) {
      res.status(404).json({ error: "product_spec_reference_not_found" });
      return;
    }

    try {
      const existing = await loadReference(referenceId);
      if (!existing) {
        res.status(404).json({ error: "product_spec_reference_not_found" });
        return;
      }

      // The real synchronous ICC-ES poll. An unreachable ICC-ES is a
      // 502 — distinct from a DB failure (500).
      let pollStatus: ProductSpecStatus | null;
      let pollSourceUrl: string;
      try {
        const result = await pollIccEsStatus(existing.esrNumber);
        pollStatus = result.status;
        pollSourceUrl = result.sourceUrl;
      } catch (err) {
        if (err instanceof IccEsUnreachableError) {
          reqLog.warn({ err, referenceId }, "ICC-ES poll unreachable");
          res.status(502).json({ error: "icc_es_unreachable" });
          return;
        }
        throw err;
      }

      const now = new Date();
      const currentStatus = existing.status as ProductSpecStatus;
      // A `null` parse is indeterminate — keep the existing status
      // rather than guessing.
      const resolvedStatus: ProductSpecStatus = pollStatus ?? currentStatus;
      const history = (existing.statusHistory ??
        []) as ProductSpecStatusChange[];
      const statusChanged = resolvedStatus !== currentStatus;
      const nextHistory = statusChanged
        ? [
            ...history,
            {
              status: resolvedStatus,
              changedAt: now.toISOString(),
              sourceUrl: pollSourceUrl,
            },
          ]
        : history;

      const [row] = await db
        .update(productSpecReferences)
        .set({
          status: resolvedStatus,
          lastVerifiedAt: now,
          statusHistory: nextHistory,
          iccEsUrl: pollSourceUrl,
          updatedAt: now,
        })
        .where(eq(productSpecReferences.id, referenceId))
        .returning();
      if (!row) {
        throw new Error("product_spec_references update returned no row");
      }

      const atom = toProductSpecReferenceAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "product-spec-reference",
        entityId: row.id,
        eventType: "product-spec-reference.refreshed",
        actor: resolveEventActor(req),
        payload: {
          statusChanged,
          from: currentStatus,
          to: resolvedStatus,
          indeterminate: pollStatus === null,
        },
      });

      res.json({ productSpecReference: atom });
    } catch (err) {
      reqLog.error({ err, referenceId }, "refresh product-spec-reference failed");
      res
        .status(500)
        .json({ error: "Failed to refresh product spec reference" });
    }
  },
);

export default router;
