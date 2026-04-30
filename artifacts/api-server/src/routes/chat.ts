import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { db, engagements, snapshots, sheets } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  keyFromEngagement,
  retrieveAtomsForQuestion,
  getAtomsByIds,
  buildChatPrompt,
  type RetrievedAtom,
  type PromptAttachedSheet,
  type PromptFrameworkAtom,
} from "@workspace/codes";
import { defaultScope } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { getAtomRegistry } from "../atoms/registry";

const router: IRouter = Router();

const MAX_REFERENCED_SHEETS = 4;
const MAX_REFERENCED_ATOMS = 6;
const MAX_RETRIEVED_ATOMS = 8;

router.post("/chat", async (req: Request, res: Response) => {
  const parse = SendChatMessageBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid chat request" });
    return;
  }
  const { engagementId, question, history, referencedSheetIds, referencedAtomIds } =
    parse.data;

  let engagement: typeof engagements.$inferSelect | undefined;
  let latestSnapshot: typeof snapshots.$inferSelect | undefined;

  try {
    const eRows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .limit(1);
    engagement = eRows[0];

    if (!engagement) {
      res.status(404).json({ error: "Engagement not found" });
      return;
    }

    const sRows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.engagementId, engagement.id))
      .orderBy(desc(snapshots.receivedAt))
      .limit(1);
    latestSnapshot = sRows[0];
  } catch (err) {
    logger.error({ err, engagementId }, "chat lookup failed");
    res.status(500).json({ error: "Failed to load engagement" });
    return;
  }

  if (!latestSnapshot) {
    res.status(400).json({
      error: "no_snapshots",
      message:
        "No snapshots yet for this engagement. Send one from Revit first.",
    });
    return;
  }

  // Resolve attached sheets, scoped to this engagement so the user can't
  // hand-craft a request that exfiltrates someone else's images.
  //
  // Two parallel resolutions happen for each referenced sheet id:
  //   1. The full PNG is loaded so vision-enabled models receive an image
  //      block (existing behavior).
  //   2. The `sheet` atom's `contextSummary` is fetched through the
  //      registry so the system prompt also carries a typed,
  //      provenance-stamped prose block describing the sheet. The two
  //      paths use the same id list, so they always agree.
  const attachedSheets: PromptAttachedSheet[] = [];
  const frameworkAtoms: PromptFrameworkAtom[] = [];
  if (referencedSheetIds && referencedSheetIds.length > 0) {
    const ids = referencedSheetIds.slice(0, MAX_REFERENCED_SHEETS);
    try {
      const rows = await db
        .select({
          id: sheets.id,
          sheetNumber: sheets.sheetNumber,
          sheetName: sheets.sheetName,
          fullPng: sheets.fullPng,
        })
        .from(sheets)
        .where(
          and(
            inArray(sheets.id, ids),
            eq(sheets.engagementId, engagement.id),
          ),
        );
      for (const r of rows) {
        const buf = Buffer.isBuffer(r.fullPng)
          ? r.fullPng
          : Buffer.from(r.fullPng as Uint8Array);
        attachedSheets.push({
          id: r.id,
          sheetNumber: r.sheetNumber,
          sheetName: r.sheetName,
          pngBase64: buf.toString("base64"),
        });
      }

      // Resolve each tenant-scoped sheet id through the atom registry so
      // the prompt carries the typed summary, not just the image. The
      // registry is the single source of truth — adding a new atom here
      // means registering it in src/atoms/registry.ts, no chat.ts edit.
      const registry = getAtomRegistry();
      const sheetAtom = registry.resolve("sheet");
      if (sheetAtom.ok) {
        const validIds = new Set(rows.map((r) => r.id));
        for (const id of ids) {
          if (!validIds.has(id)) continue;
          try {
            const summary = await sheetAtom.registration.contextSummary(
              id,
              defaultScope(),
            );
            frameworkAtoms.push({
              entityType: "sheet",
              entityId: id,
              prose: summary.prose,
              historyProvenance: summary.historyProvenance,
            });
          } catch (err) {
            logger.warn(
              { err, engagementId, sheetId: id },
              "chat: sheet atom contextSummary threw — skipping",
            );
          }
        }
      } else {
        logger.warn(
          { err: sheetAtom.error.message },
          "chat: sheet atom not registered — typed summaries skipped",
        );
      }
    } catch (err) {
      logger.warn(
        { err, engagementId, count: ids.length },
        "failed to load attached sheets — proceeding without vision",
      );
    }
  }

  // Resolve atoms to inject. Two sources:
  //   1. User-attached referencedAtomIds (cap 6)
  //   2. Retrieval over the engagement's jurisdiction (cap 8)
  // Both are scoped to the engagement's jurisdiction key so cross-tenant
  // leakage is impossible. If the engagement has no recognized jurisdiction
  // (no geocode yet, or location not in our registry), we skip atom injection
  // entirely.
  const jurisdictionKey = keyFromEngagement({
    jurisdictionCity: engagement.jurisdictionCity,
    jurisdictionState: engagement.jurisdictionState,
    jurisdiction: engagement.jurisdiction,
    address: engagement.address,
  });
  logger.info(
    {
      engagementId,
      address: engagement.address,
      jurisdictionFreeform: engagement.jurisdiction,
      jurisdictionCity: engagement.jurisdictionCity,
      jurisdictionState: engagement.jurisdictionState,
      resolvedJurisdictionKey: jurisdictionKey,
    },
    "chat: resolved jurisdiction for atom retrieval",
  );
  const explicitAtoms: RetrievedAtom[] = [];
  const retrievedAtoms: RetrievedAtom[] = [];
  if (jurisdictionKey) {
    if (referencedAtomIds && referencedAtomIds.length > 0) {
      try {
        const ids = referencedAtomIds.slice(0, MAX_REFERENCED_ATOMS);
        const atoms = await getAtomsByIds(ids, jurisdictionKey);
        explicitAtoms.push(...atoms);
      } catch (err) {
        logger.warn(
          { err, engagementId, jurisdictionKey },
          "chat: explicit atom lookup failed",
        );
      }
    }
    try {
      const atoms = await retrieveAtomsForQuestion({
        jurisdictionKey,
        question,
        limit: MAX_RETRIEVED_ATOMS,
        logger,
      });
      // Don't double-count atoms already provided explicitly.
      const explicitIds = new Set(explicitAtoms.map((a) => a.id));
      for (const a of atoms) {
        if (!explicitIds.has(a.id)) retrievedAtoms.push(a);
      }
    } catch (err) {
      logger.warn(
        { err, engagementId, jurisdictionKey },
        "chat: atom retrieval failed — continuing without code context",
      );
    }
  }
  const allAtoms = [...explicitAtoms, ...retrievedAtoms];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Pull the inline-reference vocabulary directly from the registry so
  // the prompt enumerates registered atoms instead of hardcoding them.
  // Adding a new atom registration → it shows up in <atom_vocabulary>
  // automatically (Spec 20 §F / recon H6).
  const atomTypeDescriptions = getAtomRegistry().describeForPrompt();

  const { systemPrompt, messages } = buildChatPrompt({
    engagement: {
      name: engagement.name,
      address: engagement.address,
      jurisdiction: engagement.jurisdiction,
    },
    latestSnapshot: {
      receivedAt: latestSnapshot.receivedAt,
      payload: latestSnapshot.payload,
    },
    allAtoms,
    attachedSheets,
    question,
    history,
    frameworkAtoms,
    atomTypeDescriptions,
  });

  if (attachedSheets.length > 0) {
    logger.info(
      {
        engagementId,
        sheetCount: attachedSheets.length,
        approxAddedTokens: attachedSheets.reduce(
          (sum, s) => sum + Math.round(s.pngBase64.length / 4),
          0,
        ),
      },
      "chat with vision attachments",
    );
  }
  if (allAtoms.length > 0) {
    logger.info(
      {
        engagementId,
        jurisdictionKey,
        explicitAtoms: explicitAtoms.length,
        retrievedAtoms: retrievedAtoms.length,
        retrievalModes: Array.from(new Set(allAtoms.map((a) => a.retrievalMode))),
      },
      "chat with code-atom context",
    );
  }

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      // The SDK accepts string OR content-block arrays for user content; the
      // type union here is wider than the generated typings expose.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    logger.error({ err, engagementId }, "chat stream failed");
    try {
      res.write(`data: ${JSON.stringify({ error: "stream_failed" })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      // socket already closed
    }
  }
});

export default router;
