import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { db, snapshots, sheets } from "@workspace/db";
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
import type { ContextSummary, Scope } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { getAtomRegistry } from "../atoms/registry";
import type { EngagementTypedPayload } from "../atoms/engagement.atom";

/**
 * Narrow an engagement atom's `ContextSummary.typed` (declared as
 * `Record<string, unknown>` by the framework) to the
 * {@link EngagementTypedPayload} the chat route relies on.
 *
 * Runtime check: every engagement atom payload — found OR not-found —
 * carries `id: string` and `found: boolean`, so a contract drift would
 * trip this guard at request time instead of silently producing
 * `undefined` lookups deeper in the prompt assembly. The check is
 * cheap (two property reads) and isolates the only `as`-cast in this
 * file behind a single named call site.
 */
function asEngagementPayload(
  typed: Record<string, unknown>,
): EngagementTypedPayload {
  if (typeof typed["id"] !== "string" || typeof typed["found"] !== "boolean") {
    throw new Error(
      "engagement atom contract drift: typed payload missing id/found fields",
    );
  }
  return typed as unknown as EngagementTypedPayload;
}

const router: IRouter = Router();

const MAX_REFERENCED_SHEETS = 4;
const MAX_REFERENCED_ATOMS = 6;
const MAX_RETRIEVED_ATOMS = 8;

/**
 * Build the request-scoped {@link Scope} for chat. Source order today:
 *   1. `x-audience` header — `"user" | "ai" | "internal"`. The applicant
 *      view sends `user` so the engagement atom omits Revit-binding
 *      details from prose + typed payload (engagement.atom.ts §scope).
 *   2. Default → `"internal"` so existing operator/server-to-server
 *      callers (Revit add-in, dev tools) keep the unredacted view they
 *      had before this route adopted the registry.
 *
 * Mirrors `parseScopeParam` in `routes/atoms.ts` but is intentionally
 * narrower: chat only cares about audience right now. Once a real auth
 * layer lands, the requestor + permission-claim fields can be derived
 * from the session and threaded in here without changing the call site
 * inside the handler.
 */
function chatScopeFromRequest(req: Request): Scope {
  const raw = req.header("x-audience");
  const audience: Scope["audience"] =
    raw === "user" || raw === "ai" || raw === "internal" ? raw : "internal";
  return { audience };
}

router.post("/chat", async (req: Request, res: Response) => {
  const parse = SendChatMessageBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid chat request" });
    return;
  }
  const { engagementId, question, history, referencedSheetIds, referencedAtomIds } =
    parse.data;

  // Resolve the engagement through the framework registry instead of a
  // hand-rolled Drizzle read (sprint A3 follow-up). Two reasons this
  // matters over the previous `db.select().from(engagements)`:
  //   - The atom's `contextSummary` already produces the prose,
  //     keyMetrics, and historyProvenance that chat / FE inline refs
  //     /atom-card share, so chat can ship that *same* prose into the
  //     `<framework_atoms>` block without re-deriving it here.
  //   - Scope (audience + future RBAC claims) is forwarded through the
  //     atom, so an applicant chat (`x-audience: user`) automatically
  //     gets the redacted variant — no per-route filter to maintain.
  const scope = chatScopeFromRequest(req);
  const engagementResolution = getAtomRegistry().resolve("engagement");
  if (!engagementResolution.ok) {
    // Boot validation should make this unreachable. If it ever fires,
    // it means the registry was constructed without the engagement
    // atom — a programming error worth surfacing as 500.
    logger.error(
      { err: engagementResolution.error.message },
      "chat: engagement atom not registered — refusing to serve",
    );
    res.status(500).json({ error: "Failed to load engagement" });
    return;
  }

  let engagementSummary: ContextSummary<"engagement">;
  try {
    engagementSummary = await engagementResolution.registration.contextSummary(
      engagementId,
      scope,
    );
  } catch (err) {
    logger.error({ err, engagementId }, "chat lookup failed");
    res.status(500).json({ error: "Failed to load engagement" });
    return;
  }

  // The atom returns 200-shaped `{ found: false }` rather than throwing
  // for stale/unknown ids; the chat path translates that to 404 to
  // preserve the previous wire contract.
  let engagementTyped: EngagementTypedPayload;
  try {
    engagementTyped = asEngagementPayload(engagementSummary.typed);
  } catch (err) {
    logger.error(
      { err, engagementId },
      "chat: engagement atom returned an unexpected typed payload shape",
    );
    res.status(500).json({ error: "Failed to load engagement" });
    return;
  }
  if (!engagementTyped.found) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  let latestSnapshot: typeof snapshots.$inferSelect | undefined;
  try {
    // Snapshot still loaded directly here: the snapshot atom's
    // `contextSummary` (sprint A2) intentionally omits the raw
    // `payload` blob, but the prompt builder needs that blob to render
    // the latest snapshot's Revit elements. The lookup is keyed off
    // the atom's typed id rather than the URL param so a single source
    // of truth (the registry) drives both branches.
    const sRows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.engagementId, engagementTyped.id))
      .orderBy(desc(snapshots.receivedAt))
      .limit(1);
    latestSnapshot = sRows[0];
  } catch (err) {
    logger.error({ err, engagementId }, "chat snapshot lookup failed");
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

  // Engagement is the first framework atom in the prompt (always
  // present once we got past the not-found branch above). Sheet atoms
  // get appended below when they're referenced. Order matters only for
  // human-readability of the rendered `<framework_atoms>` block; the
  // model treats each entry independently. Both paths share the same
  // request-scoped `scope` so a `user`-audience chat redacts the
  // engagement prose AND the sheet prose consistently.
  const frameworkAtoms: PromptFrameworkAtom[] = [
    {
      entityType: "engagement",
      entityId: engagementTyped.id,
      prose: engagementSummary.prose,
      historyProvenance: engagementSummary.historyProvenance,
    },
  ];

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
            eq(sheets.engagementId, engagementTyped.id),
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
              scope,
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
  // Pull jurisdiction-shape fields from the atom's typed payload —
  // same source the FE atom card consumes — so a future atom change
  // (e.g. switching `jurisdictionCity` to `localityCity`) is a one-file
  // refactor instead of a hunt across routes. Audience filtering on the
  // engagement atom does NOT redact these geographic fields, so the
  // jurisdiction-key resolution behaves identically across scopes.
  const jurisdictionKey = keyFromEngagement({
    jurisdictionCity: engagementTyped.jurisdictionCity ?? null,
    jurisdictionState: engagementTyped.jurisdictionState ?? null,
    jurisdiction: engagementTyped.jurisdiction ?? null,
    address: engagementTyped.address ?? null,
  });
  logger.info(
    {
      engagementId,
      address: engagementTyped.address,
      jurisdictionFreeform: engagementTyped.jurisdiction,
      jurisdictionCity: engagementTyped.jurisdictionCity,
      jurisdictionState: engagementTyped.jurisdictionState,
      resolvedJurisdictionKey: jurisdictionKey,
      audience: scope.audience,
      scopeFiltered: engagementSummary.scopeFiltered,
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
      // `engagementTyped.name` is required when `found: true`, but the
      // typed shape marks it optional (the not-found variant carries
      // only `id` + `found: false`). The `?? engagementId` fallback is
      // dead-code-defensive: the !engagementTyped.found branch above
      // already returned 404 before we get here.
      name: engagementTyped.name ?? engagementId,
      address: engagementTyped.address ?? null,
      jurisdiction: engagementTyped.jurisdiction ?? null,
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
