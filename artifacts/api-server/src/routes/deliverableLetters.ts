/**
 * L3 — `deliverable-letter` endpoints (Cortex Lane C.4 / C.4.3).
 *
 *   POST /api/engagements/:engagementId/deliverable-letters    create draft
 *   POST /api/deliverable-letters/:letterId/sections           upsert section
 *   POST /api/deliverable-letters/:letterId/sections/:i/provenance  merge
 *   GET  /api/deliverable-letters/:letterId/completeness       completeness
 *   POST /api/deliverable-letters/:letterId/send               draft → sent
 *
 * All routes are gated by {@link requireServiceTokenOrSession}.
 * Responses are full atom instances conforming to
 * `DELIVERABLE_LETTER_SCHEMA` (`@workspace/atoms-l-surface`).
 *
 * Canonical contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L3.
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
  deliverableLetters,
  type DeliverableLetter,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  deliverableLetterCompleteness,
  type DeliverableLetterAtomInstance,
  type DeliverableLetterStatus,
  type LetterSection,
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
  emptyProvenance,
  mergeProvenance,
  parseCreateLetterBody,
  parseProvenanceBody,
  parseSectionUpsertBody,
  upsertSection,
} from "./deliverableLetter.logic";
import { renderDeliverableLetterPdf } from "../lib/deliverableLetterPdf";
import { renderDeliverableLetterHtml } from "../lib/deliverableLetterHtml";

const router: IRouter = Router();

router.use(requireServiceTokenOrSession);

/** Materialize a `deliverable-letter` atom instance from its row. */
function toDeliverableLetterAtom(
  row: DeliverableLetter,
  tenantId: string,
): DeliverableLetterAtomInstance {
  const createdAtIso = row.createdAt.toISOString();
  const domainFields = {
    engagementId: row.engagementId,
    title: row.title,
    status: row.status as DeliverableLetterStatus,
    recipientActorId: row.recipientActorId,
    sections: (row.sections ?? []) as LetterSection[],
    createdAt: createdAtIso,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    actorId: row.actorId,
    principalActorId: row.principalActorId,
    accessPolicy: "tenant-private" as const,
  };
  return {
    entityType: "deliverable-letter",
    entityId: row.id,
    jurisdictionTenant: tenantId,
    fetchedAt: createdAtIso,
    sourceAdapter: L_SURFACE_SOURCE_ADAPTER,
    sourceUrl: "",
    contentHash: contentHashOf(domainFields),
    ...domainFields,
  };
}

/** Load a letter row by id, or null. */
async function loadLetter(letterId: string): Promise<DeliverableLetter | null> {
  const rows = await db
    .select()
    .from(deliverableLetters)
    .where(eq(deliverableLetters.id, letterId))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/*    POST /api/engagements/:engagementId/deliverable-letters  — create        */
/* -------------------------------------------------------------------------- */

router.post(
  "/engagements/:engagementId/deliverable-letters",
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

    const parsed = parseCreateLetterBody(req.body);
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

      const sections: LetterSection[] = parsed.value.sections.map((s) => ({
        kind: s.kind,
        heading: s.heading,
        content: s.content,
        provenance: emptyProvenance(),
      }));

      const [row] = await db
        .insert(deliverableLetters)
        .values({
          engagementId,
          title: parsed.value.title,
          status: "draft",
          recipientActorId: parsed.value.recipientActorId,
          sections,
          actorId: parsed.value.actorId,
          principalActorId: parsed.value.principalActorId,
        })
        .returning();
      if (!row) throw new Error("deliverable_letters insert returned no row");

      const atom = toDeliverableLetterAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "deliverable-letter",
        entityId: row.id,
        eventType: "deliverable-letter.drafted",
        actor: resolveEventActor(req),
        payload: { engagementId, title: atom.title, sectionCount: sections.length },
      });

      res.status(201).json({ deliverableLetter: atom });
    } catch (err) {
      reqLog.error({ err, engagementId }, "create deliverable-letter failed");
      res.status(500).json({ error: "Failed to create deliverable letter" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  GET /api/engagements/:engagementId/deliverable-letters  — list             */
/*  GET /api/deliverable-letters/:letterId  — fetch                            */
/*                                                                            */
/*  NOT in the L2026-05-19 endpoint contract — added in C.4.3 because the L3   */
/*  design-tools UI cannot list or reload a letter without a read path, and    */
/*  the QA-readiness "state survives reload" requirement needs it. Surfaced    */
/*  to the planner in the C.4.3 PR; cc-agent-M's legacy-client.ts should grow  */
/*  matching listDeliverableLetters / getDeliverableLetter methods.            */
/* -------------------------------------------------------------------------- */

router.get(
  "/engagements/:engagementId/deliverable-letters",
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
      const engagementRows = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .limit(1);
      if (!engagementRows[0]) {
        res.status(404).json({ error: "engagement_not_found" });
        return;
      }

      const rows = await db
        .select()
        .from(deliverableLetters)
        .where(eq(deliverableLetters.engagementId, engagementId))
        .orderBy(desc(deliverableLetters.createdAt));

      const tenantId = resolveTenantId(req);
      res.json({
        deliverableLetters: rows.map((r) =>
          toDeliverableLetterAtom(r, tenantId),
        ),
      });
    } catch (err) {
      reqLog.error({ err, engagementId }, "list deliverable-letters failed");
      res.status(500).json({ error: "Failed to list deliverable letters" });
    }
  },
);

router.get(
  "/deliverable-letters/:letterId",
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
      res.json({
        deliverableLetter: toDeliverableLetterAtom(letter, resolveTenantId(req)),
      });
    } catch (err) {
      reqLog.error({ err, letterId }, "fetch deliverable-letter failed");
      res.status(500).json({ error: "Failed to fetch deliverable letter" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  GET /api/deliverable-letters/:letterId/export.pdf  — download / print      */
/*  GET /api/deliverable-letters/:letterId/preview.html — print layout HTML    */
/* -------------------------------------------------------------------------- */

function letterExportFilename(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "deliverable-letter"}.pdf`;
}

router.get(
  "/deliverable-letters/:letterId/export.pdf",
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

      const sections = (letter.sections ?? []) as LetterSection[];
      if (sections.length === 0) {
        res.status(422).json({ error: "no_letter_content_to_export" });
        return;
      }

      const pdfBuffer = await renderDeliverableLetterPdf({
        title: letter.title,
        sections,
      });
      const download = req.query.download === "1";
      const disposition = download ? "attachment" : "inline";
      const filename = letterExportFilename(letter.title);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${filename}"`,
      );
      res.setHeader("Content-Length", String(pdfBuffer.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.status(200).end(pdfBuffer);
    } catch (err) {
      reqLog.error({ err, letterId }, "deliverable-letter export.pdf failed");
      res.status(500).json({ error: "Failed to export deliverable letter" });
    }
  },
);

router.get(
  "/deliverable-letters/:letterId/preview.html",
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

      const sections = (letter.sections ?? []) as LetterSection[];
      const html = renderDeliverableLetterHtml({
        title: letter.title,
        sections,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store");
      res.status(200).send(html);
    } catch (err) {
      reqLog.error({ err, letterId }, "deliverable-letter preview.html failed");
      res.status(500).json({ error: "Failed to render deliverable letter preview" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       POST /api/deliverable-letters/:letterId/sections  — upsert section     */
/* -------------------------------------------------------------------------- */

router.post(
  "/deliverable-letters/:letterId/sections",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const letterId =
      typeof req.params.letterId === "string" ? req.params.letterId : "";

    if (!UUID_RE.test(letterId)) {
      res.status(404).json({ error: "deliverable_letter_not_found" });
      return;
    }

    const parsed = parseSectionUpsertBody(req.body);
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

      const current = (letter.sections ?? []) as LetterSection[];
      const result = upsertSection(current, parsed.value);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }

      const [row] = await db
        .update(deliverableLetters)
        .set({ sections: result.value, updatedAt: new Date() })
        .where(eq(deliverableLetters.id, letterId))
        .returning();
      if (!row) throw new Error("deliverable_letters update returned no row");

      const atom = toDeliverableLetterAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "deliverable-letter",
        entityId: row.id,
        eventType: "deliverable-letter.section-revised",
        actor: resolveEventActor(req),
        payload: {
          sectionIndex: parsed.value.sectionIndex,
          kind: parsed.value.kind,
        },
      });

      res.json({ deliverableLetter: atom });
    } catch (err) {
      reqLog.error({ err, letterId }, "upsert deliverable-letter section failed");
      res.status(500).json({ error: "Failed to update section" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  POST /api/deliverable-letters/:letterId/sections/:sectionIndex/provenance   */
/* -------------------------------------------------------------------------- */

router.post(
  "/deliverable-letters/:letterId/sections/:sectionIndex/provenance",
  async (req: Request, res: Response): Promise<void> => {
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    const letterId =
      typeof req.params.letterId === "string" ? req.params.letterId : "";
    const sectionIndexRaw =
      typeof req.params.sectionIndex === "string"
        ? req.params.sectionIndex
        : "";

    if (!UUID_RE.test(letterId)) {
      res.status(404).json({ error: "deliverable_letter_not_found" });
      return;
    }
    const sectionIndex = Number.parseInt(sectionIndexRaw, 10);
    if (Number.isNaN(sectionIndex)) {
      res.status(400).json({ error: "invalid_section_index" });
      return;
    }

    const parsed = parseProvenanceBody(req.body);
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

      const current = (letter.sections ?? []) as LetterSection[];
      const result = mergeProvenance(current, sectionIndex, parsed.value);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }

      const [row] = await db
        .update(deliverableLetters)
        .set({ sections: result.value, updatedAt: new Date() })
        .where(eq(deliverableLetters.id, letterId))
        .returning();
      if (!row) throw new Error("deliverable_letters update returned no row");

      const atom = toDeliverableLetterAtom(row, resolveTenantId(req));
      await recordLSurfaceEvent(reqLog, {
        entityType: "deliverable-letter",
        entityId: row.id,
        eventType: "deliverable-letter.section-revised",
        actor: resolveEventActor(req),
        payload: { sectionIndex, provenanceMerged: true },
      });

      res.json({ deliverableLetter: atom });
    } catch (err) {
      reqLog.error(
        { err, letterId },
        "merge deliverable-letter provenance failed",
      );
      res.status(500).json({ error: "Failed to merge provenance" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       GET /api/deliverable-letters/:letterId/completeness                   */
/* -------------------------------------------------------------------------- */

router.get(
  "/deliverable-letters/:letterId/completeness",
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
      const { complete, missing } = deliverableLetterCompleteness(
        (letter.sections ?? []) as LetterSection[],
      );
      res.json({ complete, missing });
    } catch (err) {
      reqLog.error(
        { err, letterId },
        "deliverable-letter completeness check failed",
      );
      res.status(500).json({ error: "Failed to check completeness" });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*       POST /api/deliverable-letters/:letterId/send  — draft → sent           */
/* -------------------------------------------------------------------------- */

router.post(
  "/deliverable-letters/:letterId/send",
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

      const sections = (letter.sections ?? []) as LetterSection[];
      const { complete, missing } = deliverableLetterCompleteness(sections);
      if (!complete) {
        res
          .status(409)
          .json({ error: "deliverable_letter_incomplete", missing });
        return;
      }

      // Idempotent: a re-send keeps the original sentAt stamp.
      const now = new Date();
      const [row] = await db
        .update(deliverableLetters)
        .set({
          status: "sent",
          sentAt: letter.sentAt ?? now,
          updatedAt: now,
        })
        .where(eq(deliverableLetters.id, letterId))
        .returning();
      if (!row) throw new Error("deliverable_letters update returned no row");

      const atom = toDeliverableLetterAtom(row, resolveTenantId(req));
      if (letter.status !== "sent") {
        await recordLSurfaceEvent(reqLog, {
          entityType: "deliverable-letter",
          entityId: row.id,
          eventType: "deliverable-letter.sent",
          actor: resolveEventActor(req),
          payload: { sectionCount: sections.length },
        });
      }

      res.json({ deliverableLetter: atom });
    } catch (err) {
      reqLog.error({ err, letterId }, "send deliverable-letter failed");
      res.status(500).json({ error: "Failed to send deliverable letter" });
    }
  },
);

export default router;
