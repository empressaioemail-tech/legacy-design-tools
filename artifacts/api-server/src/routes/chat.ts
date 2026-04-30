import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { db, snapshots, sheets } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
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
import { INLINE_ATOM_REGEX } from "@workspace/empressa-atom";
import { logger } from "../lib/logger";
import { getAtomRegistry } from "../atoms/registry";
import type { EngagementTypedPayload } from "../atoms/engagement.atom";
import { SNAPSHOT_SUPPORTED_MODES } from "../atoms/snapshot.atom";

/**
 * Render-mode token the inline-reference syntax uses to opt a chat
 * turn into snapshot focus mode (Task #39). Must be a member of
 * {@link SNAPSHOT_SUPPORTED_MODES} — the snapshot atom registration
 * already lists `focus` as a supported mode at the type level, and
 * this constant is the single hand-off between that registry vocabulary
 * and the chat path's parser. If the snapshot atom ever drops `focus`
 * from its supported modes, the assignment below stops type-checking,
 * which is the canary we want.
 */
const SNAPSHOT_FOCUS_MODE: (typeof SNAPSHOT_SUPPORTED_MODES)[number] = "focus";

/**
 * Scan `question` for any inline `{{atom:snapshot:<latestSnapshotId>:focus}}`
 * reference. The third capture group of {@link INLINE_ATOM_REGEX} is
 * the displayLabel slot — chat repurposes it as the focus opt-in
 * token, matching the documented opt-in path on the OpenAPI spec
 * (`ChatRequest.snapshotFocus`).
 *
 * Only references that target the **current** latest snapshot id flip
 * focus on. A stale id (e.g. the user pasted a reference from a chat
 * a week ago, before the engagement got a fresher snapshot) is
 * intentionally ignored — focus mode is always about the snapshot
 * the rest of the prompt is already framed around.
 */
function questionRequestsSnapshotFocus(
  question: string,
  latestSnapshotId: string,
): boolean {
  // Defensive copy: regex is module-scoped + `g`-flagged so we reset
  // lastIndex (parseInlineReferences upstream relies on the same dance).
  INLINE_ATOM_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_ATOM_REGEX.exec(question)) !== null) {
    const [, entityType, entityId, label] = match;
    if (
      entityType === "snapshot" &&
      entityId === latestSnapshotId &&
      label === SNAPSHOT_FOCUS_MODE
    ) {
      INLINE_ATOM_REGEX.lastIndex = 0;
      return true;
    }
  }
  return false;
}

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
 * Build the request-scoped {@link Scope} for chat from the authenticated
 * session attached by `middlewares/session.ts`. The session — not any
 * request header — is the source of truth for audience, requestor, and
 * permission claims; the previous `x-audience`-header path was trivially
 * spoofable (an applicant could set `x-audience: internal` and the
 * engagement atom would happily emit Revit-binding details meant only
 * for internal staff).
 *
 * Defaults & dev override
 * -----------------------
 * Anonymous requests get `audience: "user"` from the middleware, so the
 * engagement atom redacts internal-only fields by default. The
 * `x-audience` / `x-requestor` / `x-permissions` headers are still
 * honored as a development override — but the override happens inside
 * `sessionMiddleware`, gated on `NODE_ENV !== "production"`, so a
 * deployed server cannot be coerced via headers. See task #29 and
 * `middlewares/session.ts` for the full integration contract.
 */
function chatScopeFromSession(req: Request): Scope {
  const session = req.session;
  const scope: Scope = { audience: session.audience };
  if (session.requestor) scope.requestor = session.requestor;
  if (session.permissions && session.permissions.length > 0) {
    scope.permissions = session.permissions;
  }
  return scope;
}

router.post("/chat", async (req: Request, res: Response) => {
  const parse = SendChatMessageBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid chat request" });
    return;
  }
  const {
    engagementId,
    question,
    history,
    referencedSheetIds,
    referencedAtomIds,
    snapshotFocus: explicitSnapshotFocus,
  } = parse.data;

  // Resolve the engagement through the framework registry instead of a
  // hand-rolled Drizzle read (sprint A3 follow-up). Two reasons this
  // matters over the previous `db.select().from(engagements)`:
  //   - The atom's `contextSummary` already produces the prose,
  //     keyMetrics, and historyProvenance that chat / FE inline refs
  //     /atom-card share, so chat can ship that *same* prose into the
  //     `<framework_atoms>` block without re-deriving it here.
  //   - Scope (audience + future RBAC claims) is forwarded through the
  //     atom, so an applicant chat (`req.session.audience === "user"`)
  //     automatically gets the redacted variant — no per-route filter
  //     to maintain. The session is built by `middlewares/session.ts`,
  //     which fails closed in production; see that file for the trust
  //     model.
  const scope = chatScopeFromSession(req);
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

  // Resolve the latest snapshot through the engagement atom's
  // `relatedAtoms` instead of running a second `engagementId + ORDER BY
  // receivedAt DESC` query here. The engagement atom already loads its
  // child snapshots most-recent-first via `resolveComposition`, so
  // taking the first `snapshot` ref off that list is equivalent to the
  // previous Drizzle read but keyed off the registry's view of the
  // engagement — the same source of truth the FE atom card sees.
  const latestSnapshotRef = engagementSummary.relatedAtoms.find(
    (r) => r.entityType === "snapshot",
  );
  if (!latestSnapshotRef) {
    res.status(400).json({
      error: "no_snapshots",
      message:
        "No snapshots yet for this engagement. Send one from Revit first.",
    });
    return;
  }
  const latestSnapshotId = latestSnapshotRef.entityId;

  // Snapshot framework atom — pushed into `<framework_atoms>` so the
  // model receives the same provenance-stamped narrative the FE atom
  // card sees, instead of inferring everything from the raw payload
  // blob below. Best-effort: a contract drift inside the snapshot atom
  // (e.g. throwing on a stale id) drops the framework entry but lets
  // the chat continue with engagement + raw payload.
  let snapshotSummary: ContextSummary<"snapshot"> | null = null;
  const snapshotResolution = getAtomRegistry().resolve("snapshot");
  if (snapshotResolution.ok) {
    try {
      snapshotSummary = await snapshotResolution.registration.contextSummary(
        latestSnapshotId,
        scope,
      );
    } catch (err) {
      logger.warn(
        { err, engagementId, snapshotId: latestSnapshotId },
        "chat: snapshot atom contextSummary threw — skipping framework entry",
      );
    }
  } else {
    logger.warn(
      { err: snapshotResolution.error.message },
      "chat: snapshot atom not registered — typed snapshot summary skipped",
    );
  }

  // Snapshot focus mode (Task #39). Two opt-in channels feed the same
  // boolean: an explicit `snapshotFocus: true` flag on the request body
  // (programmatic callers / a future "deep dive" UI button), and an
  // inline `{{atom:snapshot:<latestSnapshotId>:focus}}` reference
  // embedded in the question text (so a power user can opt in by
  // chaining off the snapshot atom card). Either path triggers the
  // raw `snapshots.payload` blob to be loaded and threaded through to
  // the prompt formatter inside a dedicated `<snapshot_focus>` block;
  // the default path stays JSON-free per Task #34.
  const snapshotFocusOn =
    explicitSnapshotFocus === true ||
    questionRequestsSnapshotFocus(question, latestSnapshotId);

  let snapshotReceivedAt: Date | undefined;
  let snapshotFocusPayload: unknown = undefined;
  try {
    // `receivedAt` is always needed (it drives the "captured
    // <relative-time> ago" framing sentence). `payload` is only loaded
    // when focus mode is on for this turn — by default the snapshot
    // framework atom's prose carries everything the model needs and we
    // skip paying the tens-of-KB tax (Task #34 contract). When focus
    // mode IS on, the same single-row primary-key lookup pulls both
    // columns so we don't issue a second round-trip.
    const sRows = snapshotFocusOn
      ? await db
          .select({
            receivedAt: snapshots.receivedAt,
            payload: snapshots.payload,
          })
          .from(snapshots)
          .where(eq(snapshots.id, latestSnapshotId))
          .limit(1)
      : await db
          .select({ receivedAt: snapshots.receivedAt })
          .from(snapshots)
          .where(eq(snapshots.id, latestSnapshotId))
          .limit(1);
    snapshotReceivedAt = sRows[0]?.receivedAt;
    if (snapshotFocusOn) {
      // The narrowed `select` shape above means `payload` is only
      // populated on the focus branch; the cast lets us read it without
      // re-narrowing every consumer. `payload` is intentionally typed
      // as `unknown` downstream — buildChatPrompt JSON-stringifies it
      // verbatim, no schema assumed.
      snapshotFocusPayload = (
        sRows[0] as { payload?: unknown } | undefined
      )?.payload;
    }
  } catch (err) {
    logger.error(
      { err, engagementId, snapshotId: latestSnapshotId },
      "chat snapshot lookup failed",
    );
    res.status(500).json({ error: "Failed to load engagement" });
    return;
  }

  if (!snapshotReceivedAt) {
    // The engagement atom said this snapshot existed a moment ago. If
    // the row is gone now (deleted between reads) treat it the same as
    // "no snapshots" — the wire contract callers expect.
    res.status(400).json({
      error: "no_snapshots",
      message:
        "No snapshots yet for this engagement. Send one from Revit first.",
    });
    return;
  }

  // Engagement is the first framework atom in the prompt (always
  // present once we got past the not-found branch above), followed by
  // the latest snapshot's typed summary when the atom resolved
  // successfully. Sheet atoms get appended below when they're
  // referenced. Order matters only for human-readability of the
  // rendered `<framework_atoms>` block; the model treats each entry
  // independently. All paths share the same request-scoped `scope` so
  // a `user`-audience chat redacts the engagement prose AND the sheet
  // prose AND the snapshot prose consistently.
  const frameworkAtoms: PromptFrameworkAtom[] = [
    {
      entityType: "engagement",
      entityId: engagementTyped.id,
      prose: engagementSummary.prose,
      historyProvenance: engagementSummary.historyProvenance,
    },
  ];
  if (snapshotSummary) {
    frameworkAtoms.push({
      entityType: "snapshot",
      entityId: latestSnapshotId,
      prose: snapshotSummary.prose,
      historyProvenance: snapshotSummary.historyProvenance,
    });
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
      receivedAt: snapshotReceivedAt,
      // Focus mode (Task #39): only set when the caller opted in via
      // explicit flag or inline `{{atom:snapshot:<id>:focus}}` reference.
      // The payload is forwarded as-is — the formatter owns the
      // serialization + size-cap. When `snapshotFocusPayload` is null
      // (the row exists but `payload` happens to be JSON null) we still
      // honor focus mode and the formatter emits `null` in the block,
      // making it obvious the snapshot has no structured detail to mine.
      ...(snapshotFocusOn
        ? {
            focusPayload: {
              snapshotId: latestSnapshotId,
              payload: snapshotFocusPayload,
            },
          }
        : {}),
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
  if (snapshotFocusOn) {
    // One-line audit so prod observability can answer "how often is
    // focus mode actually used?" without having to parse the prompt.
    // The payload itself isn't logged — it's tenant data and may run
    // tens of KB. `triggeredBy` distinguishes the explicit body flag
    // from the inline-reference path so a regression that breaks
    // either channel surfaces here.
    const triggeredBy: "flag" | "inline_reference" =
      explicitSnapshotFocus === true ? "flag" : "inline_reference";
    logger.info(
      {
        engagementId,
        snapshotId: latestSnapshotId,
        triggeredBy,
        payloadIsNull: snapshotFocusPayload === null,
      },
      "chat with snapshot focus payload",
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
