/**
 * Pure assembly of the chat system prompt + user-facing message blocks.
 *
 * Extracted from `artifacts/api-server/src/routes/chat.ts` so it can be
 * unit-tested without spinning up the route, and so future sprints (notably
 * A06) can change prompt shape without re-extracting.
 *
 * This module owns NOTHING stateful — no DB, no SDK, no logger. Inputs in,
 * strings + structured messages out.
 */

import type { RetrievedAtom } from "./retrieval";

/** Atom body is hard-truncated at this many chars when injected into the prompt. */
export const MAX_ATOM_BODY_CHARS = 1800;

/**
 * Framework-atom prose is hard-truncated at this many chars when injected.
 *
 * Bumped (Task #34) from 1200 → 2000 to make room for the snapshot
 * atom's compact sheet listing — chat used to paste the entire raw
 * snapshot JSON in a separate `<snapshot>` block, and that block has
 * been retired in favor of the snapshot atom's prose covering counts +
 * sheet identities. Worst-case snapshot prose stays well under this
 * cap (see `SNAPSHOT_PROSE_MAX_CHARS`).
 */
export const MAX_FRAMEWORK_ATOM_PROSE_CHARS = 2000;

/**
 * One framework-atom payload to inject into the system prompt. Mirrors the
 * subset of `ContextSummary` from `@workspace/empressa-atom` that the
 * prompt cares about — the formatter intentionally does not depend on the
 * framework package so this lib stays free of cross-cutting deps.
 *
 * Source of truth: `chat.ts` resolves the atom via the registry, calls
 * its `contextSummary`, and maps the result onto this shape.
 */
export interface PromptFrameworkAtom {
  entityType: string;
  entityId: string;
  /** Human-readable summary suitable for direct prompt insertion. */
  prose: string;
  /** History anchor for the latest event on this atom. */
  historyProvenance: {
    latestEventId: string;
    latestEventAt: string;
  };
}

/**
 * Per-atom-type description used to enumerate the inline-reference
 * vocabulary in the prompt. Mirrors `AtomPromptDescription` from
 * `@workspace/empressa-atom` — see comment on {@link PromptFrameworkAtom}
 * for why we duplicate the shape rather than depending on the framework.
 */
export interface PromptAtomTypeDescription {
  entityType: string;
  domain: string;
  composes: ReadonlyArray<string>;
}

export interface PromptEngagement {
  name: string;
  address: string | null;
  jurisdiction: string | null;
}

/**
 * Per-turn snapshot framing data. The timestamp is always consumed —
 * the chat prompt opens with "The most recent snapshot was captured
 * <relative-time>" and the snapshot atom (in `<framework_atoms>`)
 * carries the project name, counts, and sheet listing.
 *
 * Pre-Task #34 this carried the full snapshot `payload: unknown` blob
 * that was JSON-stringified into a `<snapshot>` system-prompt block on
 * every turn. That block dominated the token budget for real Revit
 * pushes, so it was dropped in favor of the atom-driven summary.
 *
 * Task #39 reintroduces structured payload access via the optional
 * {@link focusPayload} field — populated only when the chat route
 * detects the caller has opted *this turn* into "snapshot focus mode"
 * (an explicit `snapshotFocus: true` request flag, or an inline
 * `{{atom:snapshot:<id>:focus}}` reference embedded in the question).
 * When set, {@link buildChatPrompt} emits a dedicated
 * `<snapshot_focus>` block separate from `<framework_atoms>` so the
 * model can mine the raw payload for questions like "what's the area
 * of room 204?". The default chat path stays JSON-free.
 */
export interface PromptSnapshot {
  receivedAt: Date;
  /**
   * When set, the prompt enters focus mode for this turn: the raw
   * `snapshots.payload` blob is JSON-stringified into a
   * `<snapshot_focus>` block alongside an instruction directing the
   * model to use it for structured lookups. `snapshotId` is included
   * so the LLM can attribute its answer back to the same atom id the
   * `<framework_atoms>` snapshot entry advertises.
   */
  focusPayload?: {
    snapshotId: string;
    payload: unknown;
  };
}

/**
 * Hard cap on the JSON-serialized snapshot payload when focus mode is
 * on. Real Revit pushes can be tens of KB — far below Claude Sonnet's
 * context but worth bounding so a degenerate payload (e.g. an
 * accidentally-attached BIM family library) cannot starve the rest of
 * the prompt. The truncation is byte-naive (post-`JSON.stringify`
 * substring) so the resulting block is *not* guaranteed to be valid
 * JSON when the cap fires; we add an explicit ellipsis + warning line
 * inside the block so the model knows the payload was clipped.
 */
export const MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS = 60_000;

export interface PromptAttachedSheet {
  id: string;
  sheetNumber: string;
  sheetName: string;
  pngBase64: string;
}

export interface PromptHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export type PromptContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/png"; data: string };
    };

export interface PromptOutputMessage {
  role: "user" | "assistant";
  content: string | PromptContentBlock[];
}

export interface BuildChatPromptInput {
  engagement: PromptEngagement;
  latestSnapshot: PromptSnapshot;
  allAtoms: RetrievedAtom[];
  attachedSheets: PromptAttachedSheet[];
  question: string;
  history?: PromptHistoryMessage[];
  /**
   * Resolved framework atoms (from `@workspace/empressa-atom`'s registry).
   * Each entry is a typed `ContextSummary` produced by the atom's
   * registration, narrowed to the prose + provenance the prompt cares
   * about. Empty/undefined → no `<framework_atoms>` block.
   */
  frameworkAtoms?: PromptFrameworkAtom[];
  /**
   * Output of `registry.describeForPrompt()`. Drives the
   * `<atom_vocabulary>` enumeration so the LLM knows exactly which
   * `{{atom:type:id:label}}` types it may emit. Empty/undefined → no
   * vocabulary block (and no inline-reference instruction).
   */
  atomTypeDescriptions?: ReadonlyArray<PromptAtomTypeDescription>;
  /**
   * Injectable clock so {@link relativeTime} branches are deterministic in
   * tests. Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

export interface BuildChatPromptOutput {
  systemPrompt: string;
  messages: PromptOutputMessage[];
}

/**
 * Assemble the `<reference_code_atoms>` XML block exactly as it appears
 * in the chat system prompt. Returns `""` when there are no atoms (which
 * matches the chat behavior — no empty `<reference_code_atoms></...>` tags
 * are emitted).
 *
 * Exported so the /dev/atoms/probe diagnostic can show the operator the
 * literal bytes that would be sent to Claude for a given retrieval result,
 * without duplicating the formatting logic. If you change the atom block
 * shape, update this function — buildChatPrompt and the probe will both
 * follow.
 */
export function formatReferenceCodeAtoms(atoms: RetrievedAtom[]): string {
  if (atoms.length === 0) return "";
  const inner = atoms
    .map((a) => {
      const body =
        a.body.length > MAX_ATOM_BODY_CHARS
          ? a.body.slice(0, MAX_ATOM_BODY_CHARS - 1) + "…"
          : a.body;
      const ref = a.sectionNumber ?? a.sectionTitle ?? a.codeBook;
      return `<atom id="${a.id}" code_book="${a.codeBook}" edition="${a.edition}" section="${ref ?? ""}" mode="${a.retrievalMode}">\n${body}\n</atom>`;
    })
    .join("\n");
  return `<reference_code_atoms>\n${inner}\n</reference_code_atoms>`;
}

/**
 * Assemble the `<atom_vocabulary>` block enumerating every registered
 * atom type the LLM may emit via `{{atom:type:id:label}}`. Returns `""`
 * when there are no descriptions so the prompt stays compact for the
 * common case (no atoms wired up yet).
 *
 * The framework's contract (Spec 20 §F) is that atom types are *resolved*
 * via the registry — the prompt no longer hardcodes "you can render
 * tasks/sheets/snapshots". This block is the single hand-off between
 * registry state and the prompt.
 */
export function formatAtomVocabulary(
  descriptions: ReadonlyArray<PromptAtomTypeDescription>,
): string {
  if (descriptions.length === 0) return "";
  const inner = descriptions
    .map((d) => {
      const composes = d.composes.length > 0 ? d.composes.join(",") : "";
      return `<atom_type entity_type="${d.entityType}" domain="${d.domain}" composes="${composes}" />`;
    })
    .join("\n");
  return `<atom_vocabulary>\n${inner}\n</atom_vocabulary>`;
}

/**
 * Assemble the `<framework_atoms>` block carrying typed atom payloads
 * (one per resolved entity). Each entry is wrapped in an `<atom>` tag
 * carrying the entity type + id + the latest history event id so the
 * model can attribute its answer; the prose body is the atom's
 * `contextSummary.prose`, hard-truncated.
 *
 * Returns `""` when there are no atoms to inject.
 */
export function formatFrameworkAtoms(atoms: PromptFrameworkAtom[]): string {
  if (atoms.length === 0) return "";
  const inner = atoms
    .map((a) => {
      const prose =
        a.prose.length > MAX_FRAMEWORK_ATOM_PROSE_CHARS
          ? a.prose.slice(0, MAX_FRAMEWORK_ATOM_PROSE_CHARS - 1) + "…"
          : a.prose;
      return `<atom entity_type="${a.entityType}" entity_id="${a.entityId}" latest_event_id="${a.historyProvenance.latestEventId}" latest_event_at="${a.historyProvenance.latestEventAt}">\n${prose}\n</atom>`;
    })
    .join("\n");
  return `<framework_atoms>\n${inner}\n</framework_atoms>`;
}

/**
 * Assemble the `<snapshot_focus>` block carrying the raw structured
 * `snapshots.payload` JSON for the engagement's latest snapshot. Only
 * emitted when chat is in focus mode for this turn (see
 * {@link PromptSnapshot.focusPayload}); the default chat path does NOT
 * call this helper, preserving the Task #34 contract that the
 * always-on prompt is JSON-free.
 *
 * The block is a sibling of `<framework_atoms>` rather than a child —
 * the model treats them independently, but the `snapshot_id` attribute
 * matches the `entity_id` on the snapshot atom so any answer the model
 * attributes via inline `{{atom:snapshot:<id>:…}}` references stays
 * consistent across the two surfaces.
 *
 * Payload longer than {@link MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS} is
 * tail-truncated with an explicit `…` and a `[truncated]` marker on a
 * new line so the LLM knows it cannot rely on the JSON being complete.
 */
export function formatSnapshotFocus(
  snapshotId: string,
  payload: unknown,
): string {
  const json = JSON.stringify(payload, null, 2);
  const body =
    json.length > MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS
      ? json.slice(0, MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS - 1) +
        "…\n[truncated: payload exceeded the focus-mode size cap]"
      : json;
  return `<snapshot_focus snapshot_id="${snapshotId}">\n${body}\n</snapshot_focus>`;
}

/**
 * Human-friendly age string for the snapshot timestamp. Round-trips through
 * second/minute/hour/day buckets. Exported for direct testing.
 */
export function relativeTime(from: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - from.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `about ${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `about ${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `about ${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

/**
 * Build the system prompt + Anthropic-style messages array for a chat turn.
 * Pure: same inputs → same outputs.
 *
 * - System prompt always includes the engagement framing (name + address +
 *   jurisdiction) and a one-line "captured <relative-time>" framing for the
 *   latest snapshot. Snapshot identity, counts, and the sheet listing are
 *   delivered through the snapshot framework atom (in `<framework_atoms>`),
 *   not as a raw JSON blob — the pre-Task-#34 `<snapshot received_at='…'>{…}</snapshot>`
 *   block has been retired so real Revit pushes (tens of KB of payload) no
 *   longer dominate the prompt token budget.
 * - When `allAtoms` is non-empty, a `<reference_code_atoms>` block is appended
 *   and a citation instruction is added directing the model to emit
 *   `[[CODE:atomId]]` markers.
 * - When `attachedSheets` is non-empty, the user message becomes a
 *   ContentBlock array carrying a text intro + base64 image blocks. Otherwise
 *   it's a plain string (matching Anthropic's lighter-weight string form).
 * - `history` is passed through verbatim, in original order, before the new
 *   user turn.
 */
export function buildChatPrompt(
  input: BuildChatPromptInput,
): BuildChatPromptOutput {
  const {
    engagement,
    latestSnapshot,
    allAtoms,
    attachedSheets,
    question,
    history,
    frameworkAtoms,
    atomTypeDescriptions,
    now = () => new Date(),
  } = input;

  const addressSuffix = engagement.address ? ` at ${engagement.address}` : "";
  const jurisdictionSuffix = engagement.jurisdiction
    ? ` (${engagement.jurisdiction})`
    : "";
  const captured = relativeTime(latestSnapshot.receivedAt, now());

  // The reference_code_atoms XML block is assembled by a helper so the
  // /dev/atoms/probe diagnostic can render the SAME bytes the LLM would
  // see, without re-implementing the format. The helper returns the block
  // by itself; the leading "\n\n" separator below is buildChatPrompt's job
  // because it depends on what comes immediately before in systemPrompt.
  const atomBlock =
    allAtoms.length > 0 ? "\n\n" + formatReferenceCodeAtoms(allAtoms) : "";

  // Framework atoms (typed `ContextSummary` payloads from
  // `@workspace/empressa-atom`) and the registry-driven atom vocabulary
  // are appended after the reference-code atoms so the LLM sees code
  // context first (which is jurisdiction-scoped retrieval) and the
  // engagement's typed atom payloads second (deterministic lookup by id).
  const frameworkAtomList = frameworkAtoms ?? [];
  const atomTypeList = atomTypeDescriptions ?? [];
  const frameworkAtomBlock =
    frameworkAtomList.length > 0
      ? "\n\n" + formatFrameworkAtoms(frameworkAtomList)
      : "";
  const atomVocabularyBlock =
    atomTypeList.length > 0
      ? "\n\n" + formatAtomVocabulary(atomTypeList)
      : "";

  const codeCitationInstruction =
    allAtoms.length > 0
      ? "\n\nWhen you cite a Reference Code Atom in your answer, include a marker of the form `[[CODE:atomId]]` at the end of the relevant sentence (the architect's UI will render these as clickable chips). Use only atom ids that appear in <reference_code_atoms> above. Prefer paraphrasing over quoting; quote sparingly and only when the exact wording matters."
      : "";

  // Inline-reference instruction: emitted only when at least one atom
  // type is registered. Lists the registered entityTypes verbatim from
  // `registry.describeForPrompt()` rather than hardcoding them, so adding
  // a new atom registration automatically expands the prompt vocabulary
  // (Spec 20 §F / recon H6).
  const atomReferenceInstruction =
    atomTypeList.length > 0
      ? `\n\nWhen you reference an entity from <framework_atoms> or one the user can plausibly drill into, embed an inline reference of the form \`{{atom:type:id:label}}\` where \`type\` is one of: ${atomTypeList
          .map((d) => `\`${d.entityType}\``)
          .join(", ")}. Use only entity ids that appear in <framework_atoms> — never invent ids.`
      : "";

  // Snapshot focus mode (Task #39). When the chat route detects the
  // caller has opted *this turn* into focus mode — explicit
  // `snapshotFocus: true` flag or an inline
  // `{{atom:snapshot:<id>:focus}}` reference — it forwards the raw
  // `snapshots.payload` blob through `latestSnapshot.focusPayload`.
  // We then emit a dedicated `<snapshot_focus>` block (sibling of
  // `<framework_atoms>`) plus an instruction line telling the model
  // it may use the JSON for structured lookups. Default chat path
  // leaves `focusPayload` undefined, both blocks stay empty, and the
  // Task #34 JSON-free contract is preserved.
  const focusPayload = latestSnapshot.focusPayload;
  const snapshotFocusBlock = focusPayload
    ? "\n\n" +
      formatSnapshotFocus(focusPayload.snapshotId, focusPayload.payload)
    : "";
  const snapshotFocusInstruction = focusPayload
    ? "\n\nA `<snapshot_focus>` block below carries the raw structured snapshot payload for this turn. Use it to answer fine-grained questions about specific rooms, doors, schedules, or any item the snapshot atom's prose would have summarised away. Cite the snapshot you draw from with `{{atom:snapshot:" +
      focusPayload.snapshotId +
      ":focus}}` so the answer stays attributable."
    : "";

  // The legacy *always-on* `<snapshot received_at='…'>{full JSON}</snapshot>`
  // block from before Task #34 stays retired — focus mode is opt-in
  // per turn and uses the new `<snapshot_focus>` shape above. The
  // snapshot atom's prose (in `<framework_atoms>`) keeps carrying
  // project name, counts, and the compact sheet listing on every turn.
  const systemPrompt =
    `You are helping an architect understand their Revit model for the engagement '${engagement.name}'${addressSuffix}${jurisdictionSuffix}. The most recent snapshot was captured ${captured}.\n\n` +
    "Answer grounded in the structured atoms below. If the data does not contain what's asked, say so plainly. Be terse and operational in tone — this is a professional tool, not a chatbot." +
    codeCitationInstruction +
    atomReferenceInstruction +
    snapshotFocusInstruction +
    atomBlock +
    frameworkAtomBlock +
    atomVocabularyBlock +
    snapshotFocusBlock;

  const userBlocks: PromptContentBlock[] = [];
  if (attachedSheets.length > 0) {
    const sheetList = attachedSheets
      .map((s) => `${s.sheetNumber} ${s.sheetName}`)
      .join(", ");
    userBlocks.push({
      type: "text",
      text: `User question: ${question}\n\nThe following sheets are attached for visual reference: ${sheetList}`,
    });
    for (const s of attachedSheets) {
      userBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: s.pngBase64,
        },
      });
    }
  } else {
    userBlocks.push({ type: "text", text: question });
  }

  const messages: PromptOutputMessage[] = [
    ...(history ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: "user" as const,
      content:
        attachedSheets.length > 0
          ? userBlocks
          : (userBlocks[0] as { type: "text"; text: string }).text,
    },
  ];

  return { systemPrompt, messages };
}
