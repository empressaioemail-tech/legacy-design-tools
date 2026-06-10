import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendChatMessageBody } from "@workspace/api-zod";
import { db, snapshots, sheets } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  keyFromEngagement,
  retrieveAtomsForQuestion,
  getAtomsByIds,
  countAtomsForJurisdiction,
  buildChatPrompt,
  MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
  type RetrievedAtom,
  type PromptAttachedSheet,
  type PromptFrameworkAtom,
} from "@workspace/codes";
import type { ContextSummary, Scope } from "@hauska/atom-contract";
import { INLINE_ATOM_REGEX } from "@hauska/atom-contract";
import { logger } from "../lib/logger";
import { getAtomRegistry } from "../atoms/registry";
import type { EngagementTypedPayload } from "../atoms/engagement.atom";
import { SNAPSHOT_SUPPORTED_MODES } from "../atoms/snapshot.atom";
import {
  CHAT_AGENT_TOOLS,
  executeAgentTool,
  buildAgentToolGuidance,
  type ToolContext,
  type ToolRunResult,
} from "./chatAgentTools";
import {
  buildCoverageGuardrail,
  type JurisdictionCoverage,
} from "./coverageGuardrail";
import { handleWorkspaceChat } from "./chatWorkspace";

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
 * Scan `question` for every inline `{{atom|snapshot|<id>|focus}}`
 * reference and return the set of snapshot ids the user named. The
 * third capture group of {@link INLINE_ATOM_REGEX} is the displayLabel
 * slot — chat repurposes it as the focus opt-in token, matching the
 * documented opt-in path on the OpenAPI spec
 * (`ChatRequest.snapshotFocus` / `ChatRequest.snapshotFocusIds`).
 *
 * Validation against the engagement's snapshot history happens at the
 * call site — this function purely *parses*. The caller intersects
 * the returned set with the engagement's known snapshot ids before
 * loading any payloads, so a stale id (e.g. the user pasted a
 * reference from a chat a week ago, before the engagement got a
 * fresher snapshot) and a foreign-tenant id are both rejected at the
 * same boundary.
 *
 * Pre-Task-#44 this returned a `boolean` keyed off the engagement's
 * *latest* snapshot id only — comparison questions ("how did the room
 * schedule change between yesterday's push and today's?") were
 * impossible because older ids were intentionally ignored. The set
 * shape unblocks that flow.
 */
function parseInlineSnapshotFocusIds(question: string): Set<string> {
  const ids = new Set<string>();
  // Defensive copy: regex is module-scoped + `g`-flagged so we reset
  // lastIndex (parseInlineReferences upstream relies on the same dance).
  INLINE_ATOM_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_ATOM_REGEX.exec(question)) !== null) {
    const [, entityType, entityId, label] = match;
    if (entityType === "snapshot" && label === SNAPSHOT_FOCUS_MODE) {
      ids.add(entityId);
    }
  }
  INLINE_ATOM_REGEX.lastIndex = 0;
  return ids;
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
 * Hard cap on the number of snapshots a single chat turn may enter
 * focus mode against (Task #44). Comparison-style questions usually
 * span 2–3 snapshots; allowing more would risk pushing the prompt
 * past Claude's context budget once each per-block payload is
 * serialized (see `MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS` in the
 * promptFormatter — worst case ~60 KB per block). Applies to the
 * resolved set across all opt-in channels (explicit body list +
 * inline references + latest-id fallback).
 */
const MAX_FOCUS_SNAPSHOTS = 4;

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
    snapshotFocusIds: explicitSnapshotFocusIds,
  } = parse.data;

  // `activeTab` is the ambient "which tab is the operator viewing" signal
  // for the WS-C in-app agent. It is not part of the Orval-generated
  // `SendChatMessageBody` schema, so it is read directly off the body —
  // `SendChatMessageBody` is a non-strict `z.object`, so the extra key
  // passes validation and is simply stripped from `parse.data`. A
  // non-string value is ignored.
  const activeTab =
    typeof (req.body as { activeTab?: unknown }).activeTab === "string"
      ? (req.body as { activeTab: string }).activeTab
      : null;

  const chatScope =
    (req.body as { chatScope?: unknown }).chatScope === "workspace"
      ? "workspace"
      : "engagement";

  if (chatScope === "workspace") {
    try {
      await handleWorkspaceChat(req, res, {
        question,
        history: history ?? [],
        activeTab,
        scope: chatScopeFromSession(req),
      });
    } catch (err) {
      logger.error({ err }, "workspace chat failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Chat failed" });
      }
    }
    return;
  }

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
  const hasSnapshots = latestSnapshotRef != null;
  const latestSnapshotId = latestSnapshotRef?.entityId;

  // Snapshot focus requires a pushed model — the default chat path does not.
  if (!hasSnapshots) {
    const wantsFocus =
      explicitSnapshotFocus === true ||
      (explicitSnapshotFocusIds != null &&
        explicitSnapshotFocusIds.length > 0) ||
      parseInlineSnapshotFocusIds(question).size > 0;
    if (wantsFocus) {
      res.status(400).json({
        error: "no_snapshots",
        message:
          "Snapshot focus requires a pushed Revit model. Upload plans and chat without focus until a snapshot arrives.",
      });
      return;
    }
  }

  // Build the engagement's full snapshot id set (sorted most-recent
  // first) once, off the same `relatedAtoms` view the latest-id lookup
  // above uses. This is the single source of truth for "is snapshot
  // <id> known to belong to this engagement?" — every focus-mode
  // validation below intersects with this set, so a foreign-tenant id
  // (cross-tenant exfil attempt) and a stale-but-deleted id are both
  // rejected at the same boundary.
  const validSnapshotIds = new Set<string>();
  for (const ref of engagementSummary.relatedAtoms) {
    if (ref.entityType === "snapshot") {
      validSnapshotIds.add(ref.entityId);
    }
  }

  // Snapshot framework atom — pushed into `<framework_atoms>` so the
  // model receives the same provenance-stamped narrative the FE atom
  // card sees, instead of inferring everything from the raw payload
  // blob below. Best-effort: a contract drift inside the snapshot atom
  // (e.g. throwing on a stale id) drops the framework entry but lets
  // the chat continue with engagement + raw payload.
  let snapshotSummary: ContextSummary<"snapshot"> | null = null;
  if (hasSnapshots && latestSnapshotId) {
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
  }

  // Snapshot focus mode (Task #39, expanded by Task #44). Three opt-in
  // channels feed the same resolved id list, all intersected with the
  // engagement's known snapshot ids before any payload is loaded:
  //   1. `snapshotFocus: true` on the request body — backwards-compat
  //      shorthand for "focus on the latest snapshot" (programmatic
  //      callers + the existing "deep dive" UI button).
  //   2. `snapshotFocusIds: string[]` on the request body — explicit
  //      list for comparison-style questions ("how did the room
  //      schedule change between yesterday's push and today's?").
  //      Foreign ids → 400; the route fails closed instead of silently
  //      dropping them so a programmatic caller learns about the bug.
  //   3. Inline `{{atom|snapshot|<id>|focus}}` references embedded in
  //      the question text (so a power user can opt in by chaining off
  //      a snapshot atom card). Stale/foreign ids here are silently
  //      filtered — copy-pasted references from older chats are an
  //      expected ergonomic, not a programming error worth a 400.
  // Whichever channels fire, the resolved set drives a single batched
  // `payload` read and one `<snapshot_focus>` block per id in the
  // prompt. The default chat path stays JSON-free per Task #34.
  const requestedFocusIds: string[] = [];
  const requestedFocusSeen = new Set<string>();
  const addFocusId = (id: string): void => {
    if (!requestedFocusSeen.has(id)) {
      requestedFocusSeen.add(id);
      requestedFocusIds.push(id);
    }
  };

  // (2) explicit body list — validated up-front so the caller gets a
  // clean 400 instead of a silently-empty focus block.
  if (explicitSnapshotFocusIds && explicitSnapshotFocusIds.length > 0) {
    const foreign = explicitSnapshotFocusIds.filter(
      (id) => !validSnapshotIds.has(id),
    );
    if (foreign.length > 0) {
      logger.warn(
        {
          engagementId,
          foreignIds: foreign,
          audience: scope.audience,
        },
        "chat: snapshotFocusIds contained ids not on this engagement — refusing",
      );
      res.status(400).json({
        error: "snapshot_not_in_engagement",
        message:
          "One or more snapshotFocusIds do not belong to this engagement.",
      });
      return;
    }
    for (const id of explicitSnapshotFocusIds.slice(0, MAX_FOCUS_SNAPSHOTS)) {
      addFocusId(id);
    }
  }

  // (3) inline references — silently filtered to ids the engagement
  // actually owns. The cap is shared with the explicit channel: the
  // worst case (cap=4 inline + cap=4 explicit) still stays well under
  // the prompt budget thanks to formatSnapshotFocus's per-block
  // truncation, but capping the *resolved* set keeps comparison
  // questions deterministic.
  const inlineFocusIds = parseInlineSnapshotFocusIds(question);
  for (const id of inlineFocusIds) {
    if (validSnapshotIds.has(id) && requestedFocusIds.length < MAX_FOCUS_SNAPSHOTS) {
      addFocusId(id);
    }
  }

  // (1) latest-id fallback for the legacy `snapshotFocus: true` flag —
  // appended last so an explicit `snapshotFocusIds` list takes
  // precedence over the implicit "and also the latest" interpretation.
  // Skipped entirely if the latest id is already in the set.
  if (
    hasSnapshots &&
    latestSnapshotId &&
    explicitSnapshotFocus === true &&
    requestedFocusIds.length < MAX_FOCUS_SNAPSHOTS
  ) {
    addFocusId(latestSnapshotId);
  }

  const snapshotFocusOn = requestedFocusIds.length > 0;

  let snapshotReceivedAt: Date | undefined;
  const focusPayloadById = new Map<string, unknown>();
  if (hasSnapshots && latestSnapshotId) {
    try {
      // `receivedAt` for the *latest* snapshot is always needed (it
      // drives the "captured <relative-time> ago" framing sentence).
      // When focus mode is on for this turn we batch the latest-id
      // lookup with the focus-id payload reads via a single `inArray`
      // query, so the worst case is still one round-trip. Default path
      // stays a single-row primary-key lookup.
      if (snapshotFocusOn) {
        // Always include latestSnapshotId so we can populate
        // `snapshotReceivedAt`, even if the caller is only focusing on
        // older snapshots. The set lookup below is keyed off the row's
        // own id so the merge stays unambiguous.
        const ids = new Set<string>(requestedFocusIds);
        ids.add(latestSnapshotId);
        const sRows = await db
          .select({
            id: snapshots.id,
            receivedAt: snapshots.receivedAt,
            payload: snapshots.payload,
          })
          .from(snapshots)
          .where(inArray(snapshots.id, Array.from(ids)));
        for (const row of sRows) {
          if (row.id === latestSnapshotId) {
            snapshotReceivedAt = row.receivedAt;
          }
          if (requestedFocusSeen.has(row.id)) {
            focusPayloadById.set(row.id, row.payload as unknown);
          }
        }
      } else {
        const sRows = await db
          .select({ receivedAt: snapshots.receivedAt })
          .from(snapshots)
          .where(eq(snapshots.id, latestSnapshotId))
          .limit(1);
        snapshotReceivedAt = sRows[0]?.receivedAt;
      }
    } catch (err) {
      logger.error(
        { err, engagementId, snapshotIds: requestedFocusIds },
        "chat snapshot lookup failed",
      );
      res.status(500).json({ error: "Failed to load engagement" });
      return;
    }

    if (!snapshotReceivedAt) {
      // The engagement atom said this snapshot existed a moment ago. If
      // the row is gone now (deleted between reads) continue without
      // snapshot framing — geometry enriches, never gates.
      logger.warn(
        { engagementId, snapshotId: latestSnapshotId },
        "chat: snapshot row missing after atom read — proceeding without snapshot framing",
      );
    }
  }

  // Materialize `focusPayloads` in the same order the route resolved
  // the requested ids (body-explicit → inline → latest-fallback). A
  // requested id whose row vanished between the engagement-atom read
  // and the focus payload read is skipped with a logger.warn — the
  // rest of the focus-mode prompt still ships, but the missing block
  // is observable.
  const focusPayloads: Array<{ snapshotId: string; payload: unknown }> = [];
  for (const id of requestedFocusIds) {
    if (focusPayloadById.has(id)) {
      focusPayloads.push({
        snapshotId: id,
        payload: focusPayloadById.get(id),
      });
    } else {
      logger.warn(
        { engagementId, snapshotId: id },
        "chat: snapshot focus payload row missing — skipping focus block for this id",
      );
    }
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
  if (snapshotSummary && latestSnapshotId) {
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

  // QA-23 / v2 — prefer persisted coverageStatus; fall back to atom probe.
  const storedStatus = engagementTyped.coverageStatus;
  let jurisdictionCoverage: JurisdictionCoverage;
  if (storedStatus === "ready") {
    jurisdictionCoverage = "covered";
  } else if (
    storedStatus === "not_in_catalog" ||
    storedStatus === "substrate_only" ||
    storedStatus === "warming"
  ) {
    jurisdictionCoverage = "no_atoms";
  } else if (storedStatus === "unknown") {
    jurisdictionCoverage = "unrecognized";
  } else if (!jurisdictionKey) {
    jurisdictionCoverage = "unrecognized";
  } else if (allAtoms.length > 0) {
    jurisdictionCoverage = "covered";
  } else {
    try {
      const atomCount = await countAtomsForJurisdiction(jurisdictionKey);
      jurisdictionCoverage = atomCount > 0 ? "covered" : "no_atoms";
    } catch (err) {
      logger.warn(
        { err, engagementId, jurisdictionKey },
        "chat: jurisdiction coverage check failed — treating as no coverage",
      );
      jurisdictionCoverage = "no_atoms";
    }
  }
  const jurisdictionLabel =
    engagementTyped.jurisdiction?.trim() ||
    [engagementTyped.jurisdictionCity, engagementTyped.jurisdictionState]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join(", ") ||
    engagementTyped.address?.trim() ||
    "this engagement's location";
  if (jurisdictionCoverage !== "covered") {
    logger.info(
      {
        engagementId,
        jurisdictionKey,
        jurisdictionLabel,
        coverage: jurisdictionCoverage,
      },
      "chat: jurisdiction has no grounded code coverage — honesty guardrail engaged",
    );
  }

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

  const { systemPrompt, messages, snapshotFocusStats } = buildChatPrompt({
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
    latestSnapshot:
      snapshotReceivedAt != null
        ? {
            receivedAt: snapshotReceivedAt,
            // Focus mode (Task #39, expanded by Task #44): array of one
            // entry per snapshot the caller opted into for this turn (via
            // explicit flag, explicit `snapshotFocusIds`, and/or inline
            // `{{atom|snapshot|<id>|focus}}` references). Each payload is
            // forwarded as-is — the formatter owns the serialization +
            // per-block size cap. When a payload is null (the row exists
            // but `payload` happens to be JSON null) we still honor focus
            // mode for that id and the formatter emits `null` in the
            // block, making it obvious the snapshot has no structured
            // detail to mine. Empty array → formatter omits both the
            // `<snapshot_focus>` blocks and the instruction line.
            ...(focusPayloads.length > 0 ? { focusPayloads } : {}),
          }
        : null,
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
    // focus mode actually used?" and "how often does a turn drill
    // into more than one snapshot?" without having to parse the
    // prompt. The payloads themselves aren't logged — they're tenant
    // data and may run tens of KB each. `triggeredBy` records every
    // channel that fired this turn so a regression that breaks any
    // single channel surfaces here.
    const triggeredBy: Array<"flag" | "explicit_ids" | "inline_reference"> = [];
    if (explicitSnapshotFocus === true) triggeredBy.push("flag");
    if (explicitSnapshotFocusIds && explicitSnapshotFocusIds.length > 0) {
      triggeredBy.push("explicit_ids");
    }
    if (inlineFocusIds.size > 0) triggeredBy.push("inline_reference");
    // Task #51: surface the cumulative-cap downgrade counts on the
    // existing focus log + fire a sibling warn when any block was
    // downgraded so operators can alert on it. The stats are derived
    // by `formatSnapshotFocusBlocks` and threaded through
    // `buildChatPrompt`'s output — see SnapshotFocusBlocksStats.
    const downgradedCount =
      snapshotFocusStats.combinedCapTruncatedCount +
      snapshotFocusStats.combinedCapOmittedCount;
    const focusLogPayload = {
      engagementId,
      snapshotIds: focusPayloads.map((fp) => fp.snapshotId),
      focusCount: focusPayloads.length,
      triggeredBy,
      nullPayloadCount: focusPayloads.filter((fp) => fp.payload === null)
        .length,
      combinedCapTruncatedCount:
        snapshotFocusStats.combinedCapTruncatedCount,
      combinedCapOmittedCount: snapshotFocusStats.combinedCapOmittedCount,
    };
    logger.info(focusLogPayload, "chat with snapshot focus payload");
    if (downgradedCount > 0) {
      // Prefer the per-request logger (carries the pino-http request
      // id when wired) so the warn correlates with the originating
      // chat request; fall back to the singleton for callers that
      // bypass pino-http (notably the in-process test harness).
      const reqLog =
        (req as unknown as { log?: typeof logger }).log ?? logger;
      reqLog.warn(
        {
          ...focusLogPayload,
          downgradedCount,
          // Field is sourced from `MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS`,
          // which is a character count (the JSON-stringified payload's
          // `.length` is char-counted, not byte-counted). Naming the
          // log field "Chars" — instead of the misleading "Bytes" —
          // keeps operators tuning the cap from confusing the unit
          // (UTF-8 multi-byte characters would inflate a true byte
          // count vs. what the prompt cap actually measures).
          cumulativeCapChars: MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS,
        },
        "snapshot focus payloads downgraded by cumulative cap",
      );
    }
  }

  // WS-C — tool-use agentic loop. The chat route is no longer a single
  // text stream: the model may call tools (read platform state, create
  // response-tasks, draft L4/L5 specs), the route executes each in-process
  // against cortex-api's own tables, appends the `tool_result`, and
  // continues until the model returns a final text turn. SSE text deltas
  // still stream to the panel exactly as before; tool calls + agent writes
  // are surfaced as their own SSE event types (`tool_use`, `agent_action`,
  // `agent_draft`). A plain question that needs no tool takes one pass,
  // identical to the pre-WS-C behaviour.
  const augmentedSystemPrompt =
    systemPrompt +
    buildAgentToolGuidance({
      engagementName: engagementTyped.name ?? engagementId,
      activeTab,
    }) +
    // QA-23 — appended last so the grounding rule is the final, most
    // salient instruction. Empty string when the jurisdiction is covered.
    buildCoverageGuardrail({
      coverage: jurisdictionCoverage,
      jurisdictionLabel,
    });

  const toolContext: ToolContext = {
    engagementId: engagementTyped.id,
    scope,
    req,
    reqLog: (req as Request & { log?: typeof logger }).log ?? logger,
  };

  /** Bound the loop so a misbehaving model cannot call tools forever. */
  const MAX_AGENT_ITERATIONS = 8;

  // `buildChatPrompt` returns `PromptOutputMessage[]`; the loop appends
  // assistant tool_use turns and user tool_result turns whose content-block
  // shapes are wider than that type. The SDK's accepted message union is
  // wider than the generated typings, so the working array is loosely typed
  // (same pattern as the pre-WS-C `messages as any` cast).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convo: any[] = [...messages];

  try {
    let iterations = 0;
    while (true) {
      iterations += 1;
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: augmentedSystemPrompt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: convo as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: CHAT_AGENT_TOOLS as any,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }

      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason !== "tool_use") break;

      // Record the model's tool-calling turn verbatim, then run each tool.
      convo.push({ role: "assistant", content: finalMessage.content });
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Extract<typeof b, { type: "tool_use" }> =>
          b.type === "tool_use",
      );

      // Iteration budget spent: feed the model an error result for every
      // pending tool call so it closes out with a text turn instead of
      // calling more tools.
      if (iterations >= MAX_AGENT_ITERATIONS) {
        convo.push({
          role: "user",
          content: toolUseBlocks.map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content:
              "Tool-call budget for this turn is exhausted. Summarize what you have and finish.",
            is_error: true,
          })),
        });
        const closing = anthropic.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: augmentedSystemPrompt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: convo as any,
        });
        for await (const event of closing) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            res.write(
              `data: ${JSON.stringify({ text: event.delta.text })}\n\n`,
            );
          }
        }
        break;
      }

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];
      for (const block of toolUseBlocks) {
        // Status line so the panel can show "Reading findings…".
        res.write(
          `data: ${JSON.stringify({ type: "tool_use", tool: block.name })}\n\n`,
        );
        let run: ToolRunResult;
        try {
          run = await executeAgentTool(
            block.name,
            block.input,
            toolContext,
          );
        } catch (toolErr) {
          toolContext.reqLog.error(
            { err: toolErr, tool: block.name, engagementId },
            "chat agent tool threw",
          );
          run = {
            resultText: `Error: the "${block.name}" tool failed unexpectedly.`,
            isError: true,
          };
        }
        // Surface writes + drafts to the panel (agent-action log / form
        // pre-fill) before the model's next turn.
        for (const eff of run.events ?? []) {
          res.write(`data: ${JSON.stringify(eff)}\n\n`);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: run.resultText,
          ...(run.isError ? { is_error: true } : {}),
        });
      }
      convo.push({ role: "user", content: toolResults });
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
