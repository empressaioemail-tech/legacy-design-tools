/**
 * L6 — `deliverable-letter-render` endpoints (Cortex Lane C.4 / C.4.6).
 *
 *   POST /api/deliverable-letters/:letterId/renders   render (DOCX/PDF)
 *   GET  /api/deliverable-letters/:letterId/renders   list renders
 *   GET  /api/deliverable-letter-renders/:renderId/file   download bytes
 *
 * The render output IS a first-class atom (Sprint Amendment 6). The
 * `POST` is completeness-gated (an incomplete letter is a 409) and
 * generates the document synchronously in-process (see
 * `lib/letterRender.ts`).
 *
 * The `GET .../file` download route is a C.4.6 contract extension —
 * the L6 contract defines `blobRef` but no byte-serving endpoint, and
 * the UI's "Download" action needs one. Surfaced in the C.4.6 PR.
 *
 * Canonical contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L6.
 */

import { randomUUID } from "node:crypto";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  deliverableLetters,
  deliverableLetterRenders,
  type DeliverableLetter,
  type DeliverableLetterRender,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  deliverableLetterCompleteness,
  type DeliverableLetterRenderAtomInstance,
  type DeliverableLetterStatus,
  type LetterSection,
  type RenderFormat,
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
import { renderLetter, renderContentType } from "../lib/letterRender";
import {
  deliverableLetterRef,
  parseRenderBody,
  renderBlobRef,
} from "./deliverableLetterRender.logic";

const router: IRouter = Router();

router.use(requireServiceTokenOrSession);

/**
 * The L3 deliverable-letter's `contentHash` — the value pinned as a
 * render's `sourceLetterVersion`. MUST mirror `toDeliverableLetterAtom`
 * in `routes/deliverableLetters.ts` (same domain-field set, same
 * `contentHashOf`); kept in lock-step by hand.
 */
function deliverableLetterContentHash(letter: DeliverableLetter): string {
  return contentHashOf({
    engagementId: letter.engagementId,
    title: letter.title,
    status: letter.status as DeliverableLetterStatus,
    recipientActorId: letter.recipientActorId,
    sections: (letter.sections ?? []) as LetterSection[],
    createdAt: letter.createdAt.toISOString(),
    sentAt: letter.sentAt ? letter.sentAt.toISOString() : null,
    actorId: letter.actorId,
    principalActorId: letter.principalActorId,
    accessPolicy: "tenant-private" as const,
  });
}

/** Materialize a `deliverable-letter-render` atom instance from its row. */
function toRenderAtom(
  row: DeliverableLetterRender,
  tenantId: string,
): DeliverableLetterRenderAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    sourceLetterRef: row.sourceLetterRef,
    sourceLetterVersion: row.sourceLetterVersion,
    format: row.format as RenderFormat,
    blobRef: row.blobRef,
    renderedAt: row.renderedAt.toISOString(),
    renderedByActorId: row.renderedByActorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "deliverable-letter-render",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    sourceUrl: "",
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

/** The browser-resolvable download path for a render's bytes. */
function renderDownloadUrl(renderId: string): string {
  return `/api/deliverable-letter-renders/${renderId}/file`;
}

async function loadLetter(letterId: string): Promise<DeliverableLetter | null> {
  const rows = await db
    .select()
    .from(deliverableLetters)
    .where(eq(deliverableLetters.id, letterId))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*       POST /api/deliverable-letters/:letterId/renders  — render              */
/* -------------------------------------------------------------------------- */

router.post(
  "/deliverable-letters/:letterId/renders",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const letterId =
      typeof req.params.letterId === "string" ? req.params.letterId : "";

    if (!UUID_RE.test(letterId)) {
      res.status(404).json({ error: "deliverable_letter_not_found" });
      return;
    }

    const parsed = parseRenderBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const letter = await loadLetter(letterId);
      if (!letter) {
        res.status(404).json({ error: "deliverable_letter_not_found" });
        return;
      }

      const sections = (letter.sections ?? []) as LetterSection[];
      // Completeness-gate: an incomplete letter is a 409 rather than a
      // confusing partial document.
      const { complete, missing } = deliverableLetterCompleteness(sections);
      if (!complete) {
        res
          .status(409)
          .json({ error: "deliverable_letter_incomplete", missing });
        return;
      }

      // Generate the document synchronously, then persist the bytes.
      const bytes = await renderLetter(
        parsed.value.format,
        letter.title,
        sections,
      );
      const id = randomUUID();
      const now = new Date();

      const [row] = await db
        .insert(deliverableLetterRenders)
        .values({
          id,
          letterId,
          sourceLetterRef: deliverableLetterRef(letterId),
          sourceLetterVersion: deliverableLetterContentHash(letter),
          format: parsed.value.format,
          blobRef: renderBlobRef(id),
          renderBytes: bytes,
          renderedByActorId: parsed.value.renderedByActorId,
          renderedAt: now,
        })
        .returning();
      if (!row) {
        throw new Error("deliverable_letter_renders insert returned no row");
      }

      const atom = toRenderAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "deliverable-letter-render",
        entityId: row.id,
        eventType: "deliverable-letter-render.rendered",
        actor: resolveEventActor(req),
        payload: {
          letterId,
          format: parsed.value.format,
          byteLength: bytes.length,
        },
      });

      res.status(201).json({
        render: atom,
        downloadUrl: renderDownloadUrl(row.id),
      });
    } catch (err) {
      reqLog.error({ err, letterId }, "render deliverable-letter failed");
      res.status(500).json({ error: "Failed to render deliverable letter" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/deliverable-letters/:letterId/renders  — list                 */
/* -------------------------------------------------------------------------- */

router.get(
  "/deliverable-letters/:letterId/renders",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const letterId =
      typeof req.params.letterId === "string" ? req.params.letterId : "";

    if (!UUID_RE.test(letterId)) {
      res.status(404).json({ error: "deliverable_letter_not_found" });
      return;
    }

    try {
      const letter = await loadLetter(letterId);
      if (!letter) {
        res.status(404).json({ error: "deliverable_letter_not_found" });
        return;
      }

      const rows = await db
        .select()
        .from(deliverableLetterRenders)
        .where(eq(deliverableLetterRenders.letterId, letterId))
        .orderBy(desc(deliverableLetterRenders.renderedAt));

      const tenantId = resolveTenantId(req);
      res.json({
        renders: rows.map((r) => toRenderAtom(r, tenantId)),
      });
    } catch (err) {
      reqLog.error({ err, letterId }, "list deliverable-letter renders failed");
      res.status(500).json({ error: "Failed to list renders" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  GET /api/deliverable-letter-renders/:renderId/file  — download bytes        */
/*                                                                            */
/*  Contract extension (C.4.6): the L6 contract carries `blobRef` but no       */
/*  byte-serving endpoint. The UI "Download" action and the `downloadUrl`      */
/*  resolution need one. Surfaced to the planner in the C.4.6 PR.              */
/* -------------------------------------------------------------------------- */

router.get(
  "/deliverable-letter-renders/:renderId/file",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const renderId =
      typeof req.params.renderId === "string" ? req.params.renderId : "";

    if (!UUID_RE.test(renderId)) {
      res.status(404).json({ error: "deliverable_letter_render_not_found" });
      return;
    }

    try {
      const rows = await db
        .select()
        .from(deliverableLetterRenders)
        .where(eq(deliverableLetterRenders.id, renderId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        res
          .status(404)
          .json({ error: "deliverable_letter_render_not_found" });
        return;
      }

      const format = row.format as RenderFormat;
      res.setHeader("Content-Type", renderContentType(format));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="deliverable-letter-${renderId}.${format}"`,
      );
      res.send(row.renderBytes);
    } catch (err) {
      reqLog.error({ err, renderId }, "download deliverable-letter render failed");
      res.status(500).json({ error: "Failed to download render" });
    }
  },
);

export default router;
