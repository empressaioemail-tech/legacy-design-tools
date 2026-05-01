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
 * Task #39 reintroduced structured payload access via focus mode —
 * the chat route opts a turn in (an explicit `snapshotFocus: true`
 * request flag, an inline `{{atom|snapshot|<id>|focus}}` reference,
 * or — Task #44 — an explicit `snapshotFocusIds: string[]` body
 * field) and the formatter emits one `<snapshot_focus>` block per
 * snapshot the caller wanted to drill into. The dedicated block is
 * separate from `<framework_atoms>` so the model can mine the raw
 * payload for questions like "what's the area of room 204?" or
 * comparison questions like "how did the room schedule change
 * between yesterday's push and today's?". The default chat path
 * leaves {@link focusPayloads} empty/undefined and stays JSON-free.
 */
export interface PromptSnapshot {
  receivedAt: Date;
  /**
   * When non-empty, the prompt enters focus mode for this turn: each
   * entry's raw `snapshots.payload` blob is JSON-stringified into its
   * own `<snapshot_focus snapshot_id="…">` block, and a single
   * instruction line is added directing the model to use whichever
   * block the answer draws from for structured lookups. The
   * `snapshotId` on each entry must match the corresponding atom id
   * the engagement's `<framework_atoms>` snapshot entries advertise
   * so cross-block attribution stays consistent.
   *
   * Pre-Task-#44 this field was a single optional object; promoting
   * it to an array unblocks comparison questions that need to focus
   * on more than just the engagement's latest snapshot. Order matches
   * the order the chat route resolved the ids (request body first,
   * then inline references, then the latest-id fallback) — the model
   * sees the blocks in declaration order, but the per-id
   * `snapshot_id` attribute is the actual attribution target so
   * order is informational.
   */
  focusPayloads?: ReadonlyArray<{
    snapshotId: string;
    payload: unknown;
  }>;
}

/**
 * Hard cap on the JSON-serialized snapshot payload when focus mode is
 * on. Real Revit pushes can be tens of KB — far below Claude Sonnet's
 * context but worth bounding so a degenerate payload (e.g. an
 * accidentally-attached BIM family library) cannot starve the rest of
 * the prompt.
 *
 * Task #52 added the smart-trim path: the formatter calls
 * {@link shapeSnapshotPayloadForBudget} first so over-cap payloads get
 * a structurally-valid subset of the original JSON with low-priority
 * Revit metadata (families/parameters/...) shed before the high-value
 * collections chat questions actually mine (rooms/doors/sheets/
 * schedules). Tail-truncation remains as the fallback for payloads the
 * helper cannot shape (top-level arrays, single oversized primitives,
 * etc.) — when that path fires the resulting block is *not*
 * guaranteed to be valid JSON, and an explicit ellipsis + `[truncated:
 * payload exceeded the focus-mode size cap]` warning line is appended
 * so the model knows the payload was clipped.
 */
export const MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS = 60_000;

/**
 * Top-level snapshot-payload keys carrying the high-value information
 * the chat experience exists to mine — rooms, doors, sheets, schedules,
 * and so on. {@link shapeSnapshotPayloadForBudget} preserves these last
 * (and shrinks their arrays before dropping them outright) so a budget-
 * forced trim still leaves the data the user is most likely asking
 * about.
 *
 * Bias: keep this set small and conservative. Any unknown key falls
 * into the medium tier and gets shed before the high-value set, but
 * adding a key here makes it survive at the expense of unknown keys —
 * that should be a deliberate prioritisation choice.
 *
 * Audit (Task #61): the keys marked `// validated` were enumerated by
 * surveying every distinct top-level key across all production
 * `snapshots.payload` rows from real Revit add-in pushes. The keys
 * marked `// defensive` were not observed in production but match
 * Revit naming conventions and are kept so a future add-in version (or
 * a different jurisdiction's push) that includes them still has its
 * high-value branches preferred over unknown bloat. If your push uses
 * a different naming convention, add the corresponding key here.
 *
 * Note on the structural-element keys: in production the field-tested
 * `doors`, `windows`, and `walls` blocks ship as objects (e.g.
 * `{ count: 142, doorFamilies: [...] }`) rather than arrays, so
 * Phase 3's array-shrink step does not reach them — they survive
 * intact until Phase 4's last-resort drop, which is the desired
 * behaviour because the count + family/type listing is exactly the
 * structured fact chat answers about door/window/wall populations.
 */
export const HIGH_PRIORITY_SNAPSHOT_PAYLOAD_KEYS: ReadonlySet<string> =
  new Set([
    // Structural-element collections (validated in production pushes).
    "rooms", // validated — array of room records (name/level/number/areaSqFt)
    "sheets", // validated — array of sheet records (name/number/viewCount)
    "levels", // validated — array of level records (name/elevationFeet)
    "doors", // validated — object {count, doorFamilies[]}
    "windows", // validated — object {count, windowFamilies[]}
    "walls", // validated — object {count, wallTypes[], totalLengthFeet}
    // Project-identity scalars (validated in production pushes). These
    // are tiny strings, but listing them here guarantees they survive
    // even an aggressive Phase-4 squeeze so chat answers about the
    // project itself ("what's the address?", "what's the project
    // number?") still have ground truth.
    "address", // validated — top-level address string
    "projectName", // validated — project display name
    "projectNumber", // validated — Revit project number
    "documentTitle", // validated — Revit document title
    "clientName", // validated — Revit project client field
    // Defensive: not observed in production today, but match Revit
    // conventions (Schedules, Spaces, Areas are first-class Revit
    // categories; ProjectInformation is the Revit element wrapper that
    // carries address/client/etc. when an add-in serialises it as a
    // sub-object instead of top-level scalars).
    "schedules", // defensive
    "spaces", // defensive
    "areas", // defensive
    "projectInformation", // defensive — wrapper variant of address/client/etc.
  ]);

/**
 * Top-level snapshot-payload keys that are typically verbose, low-
 * signal Revit metadata — the BIM family library, applied parameters,
 * warnings about deprecated families, materials/categories/line styles
 * /fill patterns/view templates and so on, plus capture-time view
 * metadata and the snapshot ingest request envelope.
 * {@link shapeSnapshotPayloadForBudget} drops these first so the
 * high-value collections (see {@link HIGH_PRIORITY_SNAPSHOT_PAYLOAD_KEYS})
 * survive a budget-forced trim. As with the high-priority set, any
 * unknown key sits at medium priority — it's only the keys explicitly
 * listed here that get sacrificed first.
 *
 * Audit (Task #61): the keys marked `// validated` were enumerated by
 * surveying every distinct top-level key across all production
 * `snapshots.payload` rows. The remaining entries are `// defensive`
 * — not observed in production, but matching Revit naming
 * conventions for verbose metadata branches we want to shed first if
 * a future push includes them.
 */
export const LOW_PRIORITY_SNAPSHOT_PAYLOAD_KEYS: ReadonlySet<string> =
  new Set([
    // Capture-time view metadata (validated). The active view
    // recorded at push time has no value for chat answers about the
    // project itself — drop it first.
    "activeViewName", // validated — string, name of view active at capture
    "activeViewType", // validated — string, kind of view active at capture
    // Units-system marker (validated). In production this is a
    // scalar like "feetFractionalInches-1.0.0" — small, but if a
    // future push expands it into a verbose units block (per-
    // discipline rounding, formatting, etc.) we want it shed first.
    "units", // validated — units-system identifier
    // Snapshot ingest request envelope (validated). Because the route
    // stores `req.body` verbatim as the payload, the envelope fields
    // it discriminates on (engagementId vs. createNewEngagement, plus
    // the GUID/path identifiers) end up inside the payload. They are
    // request metadata, not Revit content — chat never needs them.
    "engagementId", // validated — request envelope (existing-engagement branch)
    "createNewEngagement", // validated — request envelope (create-new branch flag)
    "revitCentralGuid", // validated — request envelope identifier
    "revitDocumentPath", // validated — request envelope identifier
    // Defensive: classic verbose Revit metadata branches.
    "families", // defensive — BIM family library
    "materials", // defensive — material definitions
    "parameters", // defensive — applied parameter values
    "warnings", // defensive — model-check warnings
    "metadata", // defensive — generic metadata blob
    "revitMetadata", // defensive — Revit-specific metadata blob
    "categories", // defensive — category definitions
    "lineStyles", // defensive — line style library
    "fillPatterns", // defensive — fill pattern library
    "viewTemplates", // defensive — view template definitions
    "linkedFiles", // defensive — linked-file references
    "phases", // defensive — project phase definitions
    "appliedDisciplines", // defensive — discipline-applied settings
  ]);

/**
 * Cumulative cap across ALL `<snapshot_focus>` blocks emitted in a
 * single chat turn (Task #47). The chat route allows up to
 * `MAX_FOCUS_SNAPSHOTS` (currently 4) snapshots in focus mode at once;
 * with the per-block cap of {@link MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS},
 * the worst-case combined payload is ~240 KB, which can crowd out the
 * rest of the prompt (engagement framing, framework atoms, retrieved
 * code atoms) on Claude Sonnet's context budget.
 *
 * 120 KB = 2 × per-block cap leaves the first focus block fully intact
 * even at its individual worst case while still capping the combined
 * total at half of the previous worst case. When this cap fires, later
 * blocks (in declaration order) are progressively trimmed — the first
 * block stays untouched (subject to its own per-block cap) so
 * comparison questions still have a stable anchor.
 */
export const MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS = 120_000;

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
   * `{{atom|type|id|label}}` types it may emit. Empty/undefined → no
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
  /**
   * Per-turn accounting of how the cumulative `<snapshot_focus>` cap
   * shaped the emitted blocks for this prompt — see
   * {@link SnapshotFocusBlocksStats}. Always present (even when focus
   * mode was off, in which case every count is `0`) so callers can log
   * a stable shape; the chat route reads this to fire a warn-level log
   * when any block was downgraded by the cumulative cap (Task #51).
   */
  snapshotFocusStats: SnapshotFocusBlocksStats;
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
 * atom type the LLM may emit via `{{atom|type|id|label}}`. Returns `""`
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
 * Result of {@link shapeSnapshotPayloadForBudget}. Carries the chosen
 * JSON subset, a flag for whether any pruning happened, a flag for
 * whether the result actually fits the requested budget, and a
 * structured report describing what got shed (handy for surfacing a
 * "we trimmed N keys" note in the wrapper block, and for tests).
 */
export interface ShapeSnapshotPayloadResult {
  /**
   * Pretty-printed JSON of the chosen subset of the original payload.
   * Always parses (provided the input was JSON-serializable) — the
   * helper never tail-cuts mid-token.
   */
  json: string;
  /** True when the helper had to drop keys or shrink arrays. */
  trimmed: boolean;
  /**
   * True iff {@link json} fits under the requested byte budget.
   * Callers that need a hard size guarantee should fall back to
   * tail-truncation when this is false (e.g. for top-level array or
   * primitive payloads, which the helper cannot shape).
   */
  fitsBudget: boolean;
  /**
   * Keys removed from the payload, in the order they were shed (low-
   * priority first, then medium, then high as a last resort). Nested
   * keys are reported as dotted paths (e.g. `schedules.warnings`)
   * when the recursive shape pass (Task #60) peels out a sub-tree
   * from inside a parent that survives. Empty when nothing was
   * dropped.
   */
  droppedKeys: string[];
  /**
   * High-priority array keys whose element count was reduced to fit
   * the budget. `kept` is the number of leading items retained;
   * `total` is the original array length. The `key` is a dotted path
   * for nested arrays (e.g. `schedules.rooms`) so callers can
   * attribute exactly which branch was shrunk. Empty when no arrays
   * were shrunk.
   */
  truncatedArrays: ReadonlyArray<{
    key: string;
    kept: number;
    total: number;
  }>;
}

/**
 * Maximum number of nesting levels {@link shapeSnapshotPayloadForBudget}
 * recurses into when peeling out sub-tree noise. Depth 0 is the root
 * payload; depth 1 is a key's direct value; depth 2 is a value's
 * value, etc. Bounded so a pathological payload (deeply nested junk)
 * can't blow up the formatter — three levels are enough to handle the
 * Revit shapes we see in practice (`{ schedules: { rooms, warnings,
 * meta: { … } } }`) while keeping the work bounded.
 */
const MAX_SHAPE_RECURSION_DEPTH = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursive worker for {@link shapeSnapshotPayloadForBudget}. Operates
 * in-place on a shallow-cloned `obj` and pushes any sheds into the
 * shared `droppedKeys` / `truncatedArrays` accumulators using
 * `pathPrefix` so nested entries get dotted paths
 * (e.g. `schedules.warnings`).
 *
 * `depth` tracks how many levels deep we are below the root payload
 * (root call is depth 0). Recursion is gated by
 * {@link MAX_SHAPE_RECURSION_DEPTH} so deeply-nested junk can't blow
 * up the formatter.
 */
function shapeObjectInPlace(
  obj: Record<string, unknown>,
  targetBytes: number,
  pathPrefix: string,
  droppedKeys: string[],
  truncatedArrays: { key: string; kept: number; total: number }[],
  depth: number,
): void {
  function priorityOf(key: string): "high" | "medium" | "low" {
    if (HIGH_PRIORITY_SNAPSHOT_PAYLOAD_KEYS.has(key)) return "high";
    if (LOW_PRIORITY_SNAPSHOT_PAYLOAD_KEYS.has(key)) return "low";
    return "medium";
  }

  function currentJson(): string {
    return JSON.stringify(obj, null, 2);
  }

  function fits(): boolean {
    return currentJson().length <= targetBytes;
  }

  function keysAtPriority(priority: "high" | "medium" | "low"): string[] {
    return Object.keys(obj)
      .filter((k) => priorityOf(k) === priority)
      .map((k) => ({ k, size: JSON.stringify(obj[k] ?? null).length }))
      .sort((a, b) => b.size - a.size)
      .map((e) => e.k);
  }

  /**
   * Try to shape the value at `key` (in place) so the parent fits.
   * Only attempts recursion when the value is a non-empty plain
   * object and we still have depth budget. Returns `true` iff the
   * recursion was both (a) successful at fitting the parent under
   * `targetBytes` and (b) left the nested object with at least one
   * surviving sub-key — if recursion empties the value out, the
   * caller should drop the parent instead so we don't surface a
   * meaningless `{}` literal in the output.
   *
   * The nested call's `targetBytes` is initially set to the value's
   * stand-alone JSON length minus how much we're over budget at the
   * parent level. The depth-N indentation cost differs from the
   * value's stand-alone pretty-print (each nested line gains +2
   * spaces per level), so the first attempt's budget is approximate.
   * On overshoot we tighten by the actual overshoot bytes and retry
   * up to a small fixed number of attempts; this converges quickly
   * because the indentation delta is linear in the number of
   * surviving lines. If we still don't fit after all attempts, the
   * value is restored and the caller drops the parent cleanly.
   */
  function tryRecurseInto(key: string): boolean {
    if (depth + 1 >= MAX_SHAPE_RECURSION_DEPTH) return false;
    const value = obj[key];
    if (!isPlainObject(value)) return false;
    if (Object.keys(value).length === 0) return false;
    if (currentJson().length <= targetBytes) return true;
    // Measure the parent's wrapper cost (everything except this key's
    // value) by temporarily replacing the value with `null` and re-
    // serialising. This gives an accurate base size to subtract from
    // `targetBytes` — naïvely using `valueJson.length - overBy` goes
    // negative when the value dominates the parent (because the
    // wrapper bytes outside the value don't appear in `valueJson`),
    // which would starve the nested recursion of any budget at all.
    obj[key] = null;
    const wrapperSize = currentJson().length;
    obj[key] = value;
    // `+4` credits back the "null" literal bytes the wrapper currently
    // includes; `-16` leaves a small safety margin for the depth-N
    // indentation overhead the standalone pretty-print doesn't see.
    let nestedTarget = targetBytes - wrapperSize + 4 - 16;
    if (nestedTarget <= 0) return false;
    const MAX_RECURSION_ATTEMPTS = 4;
    for (let attempt = 0; attempt < MAX_RECURSION_ATTEMPTS; attempt++) {
      const cloned: Record<string, unknown> = { ...value };
      const localDropped: string[] = [];
      const localTruncated: { key: string; kept: number; total: number }[] =
        [];
      shapeObjectInPlace(
        cloned,
        nestedTarget,
        `${pathPrefix}${key}.`,
        localDropped,
        localTruncated,
        depth + 1,
      );
      // If recursion fully emptied the nested object, prefer
      // dropping the parent — keeping a literal `{}` is
      // semantically equivalent to dropping and avoids confusing
      // droppedKeys with a partial sub-tree of paths under a key
      // that's effectively gone.
      if (Object.keys(cloned).length === 0) {
        return false;
      }
      obj[key] = cloned;
      const newSize = currentJson().length;
      if (newSize <= targetBytes) {
        for (const d of localDropped) droppedKeys.push(d);
        for (const t of localTruncated) truncatedArrays.push(t);
        return true;
      }
      // Overshoot — typically a small per-line indentation cost the
      // stand-alone pretty-print didn't account for. Tighten by the
      // actual overshoot bytes (with a small safety margin) and
      // retry. Restore the original value first so the next attempt
      // sees the same starting state.
      obj[key] = value;
      const overshoot = newSize - targetBytes;
      const tightened = nestedTarget - overshoot - 16;
      if (tightened <= 0 || tightened >= nestedTarget) break;
      nestedTarget = tightened;
    }
    obj[key] = value;
    return false;
  }

  // Phase 1: LOW priority — recurse to peel out nested junk first,
  // then drop the whole key if recursion didn't suffice.
  for (const key of keysAtPriority("low")) {
    if (fits()) break;
    if (tryRecurseInto(key)) continue;
    delete obj[key];
    droppedKeys.push(`${pathPrefix}${key}`);
  }

  // Phase 2: MEDIUM priority — same recurse-then-drop preference.
  if (!fits()) {
    for (const key of keysAtPriority("medium")) {
      if (fits()) break;
      if (tryRecurseInto(key)) continue;
      delete obj[key];
      droppedKeys.push(`${pathPrefix}${key}`);
    }
  }

  // Phase 3: shrink HIGH priority arrays, largest first. We halve the
  // kept count each iteration; this is O(log n) shrinks per array
  // and lands on a length that fits the remaining budget without
  // requiring a precise byte-by-byte search.
  if (!fits()) {
    for (const key of keysAtPriority("high")) {
      const value = obj[key];
      if (!Array.isArray(value) || value.length === 0) continue;
      const total = value.length;
      let kept = total;
      // Snapshot the original array so successive halvings always
      // slice from the full source rather than already-trimmed copies.
      const source = value;
      while (true) {
        obj[key] = source.slice(0, kept);
        if (fits() || kept <= 1) break;
        kept = Math.max(1, Math.floor(kept / 2));
      }
      if (kept < total) {
        truncatedArrays.push({ key: `${pathPrefix}${key}`, kept, total });
      }
      if (fits()) break;
    }
  }

  // Phase 4: last resort — for HIGH priority keys we still try
  // recursion first (so a payload like `{ schedules: { rooms,
  // warnings } }` keeps `schedules.rooms` by dropping
  // `schedules.warnings` instead of dropping the whole branch). If
  // recursion doesn't fit (or empties the value), drop the key.
  if (!fits()) {
    for (const key of keysAtPriority("high")) {
      if (fits()) break;
      if (tryRecurseInto(key)) continue;
      delete obj[key];
      droppedKeys.push(`${pathPrefix}${key}`);
    }
  }
}

/**
 * Walk a snapshot payload and return a structurally-valid JSON subset
 * that fits under `targetBytes`, sacrificing low-value Revit metadata
 * branches (families, parameters, warnings, ...) before the high-value
 * collections chat questions actually mine (rooms, doors, sheets,
 * schedules, ...).
 *
 * Strategy (applied to the root object, then recursively to each
 * plain-object value up to {@link MAX_SHAPE_RECURSION_DEPTH} levels
 * deep — see {@link shapeObjectInPlace} for the in-place worker):
 *   1. If the full pretty-printed JSON already fits, return it
 *      verbatim with `trimmed: false`.
 *   2. Drop {@link LOW_PRIORITY_SNAPSHOT_PAYLOAD_KEYS}, largest first.
 *      If a key holds a plain object, first try recursing into it
 *      (Task #60) so a low-priority parent that hides high-value
 *      sub-keys (e.g. `metadata: { rooms: [...] }`) doesn't get
 *      dropped wholesale.
 *   3. Drop medium-priority keys (anything not in the high or low
 *      sets) with the same recurse-then-drop preference.
 *   4. Shrink {@link HIGH_PRIORITY_SNAPSHOT_PAYLOAD_KEYS} arrays by
 *      halving `length` until each fits the remaining budget,
 *      recording how many leading items were kept vs. originally
 *      present.
 *   5. As a last resort, drop high-priority keys — but recurse first
 *      so a payload like `{ schedules: { rooms: [...],
 *      warnings: [...] } }` keeps the `schedules.rooms` branch by
 *      peeling out `schedules.warnings` from inside, instead of
 *      dropping the whole `schedules` key.
 *
 * The trim report records dotted paths for nested entries
 * (`schedules.warnings` for a dropped sub-key, `schedules.rooms` with
 * `kept`/`total` for a nested array that got shrunk) so downstream UI
 * / logging can attribute exactly which branch was shed.
 *
 * Top-level arrays / primitives / null payloads are returned verbatim
 * (the helper only knows how to prune object keys); the result's
 * `fitsBudget` flag tells callers whether a fallback is needed.
 */
export function shapeSnapshotPayloadForBudget(
  payload: unknown,
  targetBytes: number,
): ShapeSnapshotPayloadResult {
  const fullJson = JSON.stringify(payload, null, 2) ?? "null";
  if (fullJson.length <= targetBytes) {
    return {
      json: fullJson,
      trimmed: false,
      fitsBudget: true,
      droppedKeys: [],
      truncatedArrays: [],
    };
  }

  // Only plain objects are shapeable — arrays / primitives / null
  // have no key tree to walk. Caller is expected to fall back to
  // tail-truncation when fitsBudget is false.
  if (!isPlainObject(payload)) {
    return {
      json: fullJson,
      trimmed: false,
      fitsBudget: false,
      droppedKeys: [],
      truncatedArrays: [],
    };
  }

  const obj: Record<string, unknown> = { ...payload };
  const droppedKeys: string[] = [];
  const truncatedArrays: { key: string; kept: number; total: number }[] = [];

  shapeObjectInPlace(obj, targetBytes, "", droppedKeys, truncatedArrays, 0);

  const finalJson = JSON.stringify(obj, null, 2);
  return {
    json: finalJson,
    trimmed: true,
    fitsBudget: finalJson.length <= targetBytes,
    droppedKeys,
    truncatedArrays,
  };
}

/**
 * Marker emitted inside a `<snapshot_focus>` block when the smart
 * shape-trim helper successfully reduced the payload to fit under the
 * per-block cap. Distinct from the tail-truncation marker so the
 * model (and a human reading the prompt) can tell that the JSON above
 * is still structurally valid (just a subset).
 *
 * Begins with `[truncated:` so existing consumers searching for that
 * sentinel keep working.
 */
const SHAPE_TRIM_MARKER_PREFIX =
  "[truncated: snapshot payload was shape-trimmed to fit the focus-mode size cap";

function shapeTrimMarker(result: ShapeSnapshotPayloadResult): string {
  const parts: string[] = [];
  if (result.droppedKeys.length > 0) {
    parts.push(`dropped keys: ${result.droppedKeys.join(",")}`);
  }
  if (result.truncatedArrays.length > 0) {
    parts.push(
      `truncated arrays: ${result.truncatedArrays
        .map((t) => `${t.key} (${t.kept}/${t.total})`)
        .join(",")}`,
    );
  }
  const detail = parts.length > 0 ? `; ${parts.join("; ")}` : "";
  return `${SHAPE_TRIM_MARKER_PREFIX}${detail}]`;
}

/**
 * Assemble the `<snapshot_focus>` block carrying the structured
 * `snapshots.payload` JSON for the engagement's latest snapshot. Only
 * emitted when chat is in focus mode for this turn (see
 * {@link PromptSnapshot.focusPayloads}); the default chat path does NOT
 * call this helper, preserving the Task #34 contract that the
 * always-on prompt is JSON-free.
 *
 * The block is a sibling of `<framework_atoms>` rather than a child —
 * the model treats them independently, but the `snapshot_id` attribute
 * matches the `entity_id` on the snapshot atom so any answer the model
 * attributes via inline `{{atom|snapshot|<id>|…}}` references stays
 * consistent across the two surfaces.
 *
 * When the JSON would exceed {@link MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS}
 * the formatter first tries the smart trim path
 * ({@link shapeSnapshotPayloadForBudget}) which returns a
 * structurally-valid JSON subset prioritising the high-value Revit
 * collections. If smart trim cannot fit (top-level array / primitive
 * payloads), the formatter falls back to tail-truncation with an
 * explicit `…` + `[truncated]` marker so the LLM knows the JSON is
 * incomplete.
 */
export function formatSnapshotFocus(
  snapshotId: string,
  payload: unknown,
): string {
  const shaped = shapeSnapshotPayloadForBudget(
    payload,
    MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS,
  );
  if (shaped.fitsBudget) {
    const body = shaped.trimmed
      ? `${shaped.json}\n${shapeTrimMarker(shaped)}`
      : shaped.json;
    return `<snapshot_focus snapshot_id="${snapshotId}">\n${body}\n</snapshot_focus>`;
  }
  // Smart trim couldn't fit (degenerate payload — top-level array or
  // primitive bigger than the cap). Fall back to tail-truncation so
  // the per-block cap stays bounded.
  const body =
    shaped.json.slice(0, MAX_SNAPSHOT_FOCUS_PAYLOAD_CHARS - 1) +
    "…\n[truncated: payload exceeded the focus-mode size cap]";
  return `<snapshot_focus snapshot_id="${snapshotId}">\n${body}\n</snapshot_focus>`;
}

/**
 * Marker emitted inside a `<snapshot_focus>` block when the *cumulative*
 * cap (across blocks in the same turn — see
 * {@link MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS}) forces a downgrade of
 * a later block. Distinct from the per-block truncation marker used by
 * {@link formatSnapshotFocus} so the model (and a human reading the
 * prompt) can tell the two failure modes apart.
 */
const COMBINED_CAP_TRUNC_MARKER =
  "\n[truncated: combined snapshot focus payloads exceeded the cumulative size cap]";

/**
 * Marker emitted in lieu of any payload bytes when the cumulative cap
 * has already been spent before this block could fit anything. Keeps
 * the `<snapshot_focus snapshot_id="…">` shell so the snapshot id stays
 * citable even though the payload is gone.
 */
const COMBINED_CAP_OMITTED_MARKER =
  "[truncated: combined snapshot focus payloads exceeded the cumulative size cap; full payload omitted]";

/**
 * Per-turn accounting for how the cumulative cap shaped the emitted
 * `<snapshot_focus>` blocks. The chat route (and any other caller that
 * cares about observability) reads this off
 * {@link formatSnapshotFocusBlocks} so it can log when the cumulative
 * cap actually fired in production — Task #51 wired this into a
 * `req.log.warn` so operators can tell whether 120 KB is the right
 * budget without having to grep the prompt itself.
 *
 * Counts are mutually exclusive per block:
 *  - `intactCount` — block emitted verbatim by {@link formatSnapshotFocus}
 *    (subject to the per-block cap, which this metadata does NOT track —
 *    that's a different failure mode and is already visible to the
 *    model via its own `[truncated: payload exceeded …]` marker).
 *  - `combinedCapTruncatedCount` — block carried a partial payload plus
 *    {@link COMBINED_CAP_TRUNC_MARKER} because the cumulative budget
 *    forced it to be clipped.
 *  - `combinedCapOmittedCount` — block carried only
 *    {@link COMBINED_CAP_OMITTED_MARKER} (no payload bytes) because the
 *    cumulative budget was already spent before this block could fit
 *    anything meaningful.
 *
 * `totalCount` is always `intactCount + combinedCapTruncatedCount +
 * combinedCapOmittedCount`.
 */
export interface SnapshotFocusBlocksStats {
  totalCount: number;
  intactCount: number;
  combinedCapTruncatedCount: number;
  combinedCapOmittedCount: number;
}

export interface SnapshotFocusBlocksResult {
  blocks: string[];
  stats: SnapshotFocusBlocksStats;
}

/**
 * Format every `<snapshot_focus>` block for a turn, enforcing both the
 * per-block cap (via {@link formatSnapshotFocus}) and the cumulative
 * cap {@link MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS} across the set.
 *
 * Contract:
 *  - The first block is always emitted intact (subject to its own
 *    per-block cap) so comparison questions retain a stable anchor
 *    even when the rest of the set has to be clipped.
 *  - Subsequent blocks fit only as long as cumulative size stays under
 *    the budget. Once a block would push past the budget, its body is
 *    truncated to the remaining room and tagged with
 *    {@link COMBINED_CAP_TRUNC_MARKER}.
 *  - If a later block has zero remaining budget, the block is still
 *    emitted but carries only {@link COMBINED_CAP_OMITTED_MARKER} so
 *    the snapshot id stays present (and citable) in the prompt.
 *
 * Note: the cumulative cap is intentionally **soft-bounded** — we
 * always preserve a `<snapshot_focus snapshot_id="…">` shell + closing
 * tag for every requested snapshot id (so the instruction line's
 * citation hints stay valid), and the wrapper bytes themselves are
 * accounted for after the cap is checked. Worst-case overshoot is the
 * size of one shell + one omitted marker per remaining snapshot —
 * roughly tens of bytes per entry, which is negligible vs. the cap. If
 * the snapshot-count limit (`MAX_FOCUS_SNAPSHOTS` in the chat route)
 * grows materially, revisit this trade-off — either lower the cap to
 * keep the strict total bounded, or have callers drop trailing shells
 * when no room remains.
 *
 * Returns one string per input entry, in input order, plus
 * per-turn downgrade {@link SnapshotFocusBlocksStats} so callers can
 * observe whether the cumulative cap fired without having to re-parse
 * the emitted blocks for marker strings.
 */
export function formatSnapshotFocusBlocks(
  focusPayloads: ReadonlyArray<{ snapshotId: string; payload: unknown }>,
): SnapshotFocusBlocksResult {
  const blocks: string[] = [];
  const stats: SnapshotFocusBlocksStats = {
    totalCount: focusPayloads.length,
    intactCount: 0,
    combinedCapTruncatedCount: 0,
    combinedCapOmittedCount: 0,
  };
  let cumulative = 0;
  for (let i = 0; i < focusPayloads.length; i++) {
    const fp = focusPayloads[i];
    const fullBlock = formatSnapshotFocus(fp.snapshotId, fp.payload);

    // Always keep the first block intact (per-block cap already
    // enforced by formatSnapshotFocus). The cumulative cap exists to
    // protect the rest of the prompt; sacrificing the anchor block
    // would defeat the point of focus mode for comparison questions.
    if (i === 0) {
      blocks.push(fullBlock);
      cumulative += fullBlock.length;
      stats.intactCount += 1;
      continue;
    }

    const remaining = MAX_SNAPSHOT_FOCUS_TOTAL_PAYLOAD_CHARS - cumulative;
    if (fullBlock.length <= remaining) {
      blocks.push(fullBlock);
      cumulative += fullBlock.length;
      stats.intactCount += 1;
      continue;
    }

    // Need to downgrade this block. Compute how much room is left for
    // a payload body after accounting for the wrapper tags + the
    // combined-cap truncation marker.
    const header = `<snapshot_focus snapshot_id="${fp.snapshotId}">\n`;
    const footer = "\n</snapshot_focus>";
    const overhead = header.length + footer.length;

    // First-pass try: emit the wrapper + a partial body + truncation
    // marker. If that whole shape is already too big for the
    // remaining budget, fall through to the payload-omitted shape.
    const bodyRoom =
      remaining - overhead - COMBINED_CAP_TRUNC_MARKER.length - 1; // -1 for the leading "…"
    if (bodyRoom > 0) {
      // Task #52: try smart shaping first so the downgraded block
      // ships a structurally-valid JSON subset instead of a
      // mid-token tail-cut. Falls back to tail-truncation when the
      // payload isn't shapeable (top-level arrays / primitives) or
      // when even an aggressively-trimmed subset cannot fit the
      // remaining budget.
      const shaped = shapeSnapshotPayloadForBudget(fp.payload, bodyRoom);
      if (shaped.fitsBudget) {
        const block =
          header + shaped.json + COMBINED_CAP_TRUNC_MARKER + footer;
        blocks.push(block);
        cumulative += block.length;
        // The block carries COMBINED_CAP_TRUNC_MARKER, meaning the
        // cumulative cap forced a downgrade from the intact form —
        // even though smart trim landed a structurally-valid JSON
        // subset rather than a tail-cut. Count it the same as the
        // tail-truncation branch so the chat route's
        // `downgradedCount > 0` warn fires for the realistic
        // shapeable-object case (real Revit pushes), not just for
        // top-level arrays / primitives.
        stats.combinedCapTruncatedCount += 1;
        continue;
      }
      const json = shaped.json;
      const partial =
        json.length > bodyRoom ? json.slice(0, bodyRoom) : json;
      const body = partial + "…" + COMBINED_CAP_TRUNC_MARKER;
      const block = header + body + footer;
      blocks.push(block);
      cumulative += block.length;
      stats.combinedCapTruncatedCount += 1;
      continue;
    }

    // Zero (or negative) bytes left for any payload — emit a marker-
    // only block so the snapshot id stays present and citable.
    const placeholder = header + COMBINED_CAP_OMITTED_MARKER + footer;
    blocks.push(placeholder);
    cumulative += placeholder.length;
    stats.combinedCapOmittedCount += 1;
  }
  return { blocks, stats };
}

/**
 * Hard cap on how many entity labels (added or removed) we list inline
 * inside a `<snapshot_diff>` block per entity bucket (Task #54). Anything
 * beyond this gets summarised as `+N more` so the count is still
 * accurate. Comparison answers usually only need a handful of named
 * deltas; we cap to keep the diff block from balooning when a snapshot
 * adds/removes hundreds of rooms in one push (e.g. a new floor on a
 * residential tower).
 */
export const SNAPSHOT_DIFF_NAME_LIMIT = 10;

/**
 * Per-label cap inside a `<snapshot_diff>` listing. Mirrors the snapshot
 * atom's prose cap (`SHEET_LABEL_MAX_CHARS`) so a degenerate room name
 * (user-pasted-essay) cannot blow the block budget.
 */
export const SNAPSHOT_DIFF_LABEL_MAX_CHARS = 60;

/**
 * Entity buckets the snapshot-diff block knows how to identity-key. For
 * each bucket we list the candidate fields used to derive a stable key
 * (first non-empty wins) and a separate set used to produce a
 * human-friendly label after the key. Order in `keyFields` matters —
 * Revit pushes vary slightly across project templates, and a missing
 * `number` should fall back to `id` rather than turn the whole entry
 * into a no-key skip.
 *
 * `walls` is intentionally absent from this list because real Revit
 * walls don't carry a stable user-facing identifier the way rooms /
 * sheets / levels do; the diff renders walls as a count-only delta
 * instead. Areas mirror rooms (number + name).
 */
const SNAPSHOT_DIFF_ENTITY_SPECS: ReadonlyArray<{
  payloadKey: string;
  label: string;
  keyFields: ReadonlyArray<string>;
  nameFields: ReadonlyArray<string>;
}> = [
  {
    payloadKey: "rooms",
    label: "Rooms",
    keyFields: ["number", "id", "uniqueId", "name"],
    nameFields: ["name"],
  },
  {
    payloadKey: "sheets",
    label: "Sheets",
    keyFields: ["sheetNumber", "number", "id", "uniqueId"],
    nameFields: ["sheetName", "name"],
  },
  {
    payloadKey: "levels",
    label: "Levels",
    keyFields: ["name", "id", "uniqueId"],
    nameFields: ["name"],
  },
  {
    payloadKey: "areas",
    label: "Areas",
    keyFields: ["number", "id", "uniqueId", "name"],
    nameFields: ["name"],
  },
];

/**
 * Pick the first non-empty value from `item` whose key appears in
 * `fields`. Strings are trimmed; numbers are stringified. Returns `null`
 * when no candidate field carries a usable value, signalling "no stable
 * identity available" — such items are skipped during diffing rather
 * than collapsed onto the same anonymous bucket (which would mis-attribute
 * adds/removes).
 */
function pickFirstStringy(
  item: unknown,
  fields: ReadonlyArray<string>,
): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function clipLabel(label: string): string {
  return label.length > SNAPSHOT_DIFF_LABEL_MAX_CHARS
    ? label.slice(0, SNAPSHOT_DIFF_LABEL_MAX_CHARS - 1) + "…"
    : label;
}

function entityLabel(
  item: unknown,
  keyFields: ReadonlyArray<string>,
  nameFields: ReadonlyArray<string>,
): string {
  const key = pickFirstStringy(item, keyFields) ?? "?";
  const name = pickFirstStringy(item, nameFields);
  // Avoid duplicating the key when name and key share a value (e.g.
  // levels keyed by name — `Level 1 Level 1` would be silly).
  return name && name !== key ? clipLabel(`${key} ${name}`) : clipLabel(key);
}

function getArrayField(payload: unknown, key: string): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : null;
}

function countWalls(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const walls = (payload as Record<string, unknown>)["walls"];
  if (Array.isArray(walls)) return walls.length;
  if (walls && typeof walls === "object") {
    const wObj = walls as Record<string, unknown>;
    if (typeof wObj["count"] === "number") return wObj["count"] as number;
    if (Array.isArray(wObj["items"])) return (wObj["items"] as unknown[]).length;
  }
  return null;
}

function formatLabelList(labels: string[]): string {
  if (labels.length <= SNAPSHOT_DIFF_NAME_LIMIT) return labels.join("; ");
  const visible = labels.slice(0, SNAPSHOT_DIFF_NAME_LIMIT);
  const remainder = labels.length - visible.length;
  return `${visible.join("; ")}; +${remainder} more`;
}

/**
 * Pure pairwise diff between two snapshot payloads (Task #54).
 *
 * Renders a `<snapshot_diff base="…" head="…">` block summarising what
 * changed for every entity bucket the formatter knows how to identity-key
 * (rooms, sheets, levels, areas, walls). Labels are clipped and capped so
 * the block stays bounded even on very wide snapshots; counts are always
 * shown so the model can answer "how many rooms changed?" even when the
 * named-entry list got truncated.
 *
 * The two snapshots are referred to as "base" and "head" deliberately
 * (matching git terminology) so the model has an unambiguous frame —
 * "added" means present in head but missing from base; "removed" means
 * present in base but missing from head. The `snapshot_id` attributes
 * line up with the corresponding `<snapshot_focus>` blocks so a model
 * citation like `{{atom|snapshot|<id>|focus}}` resolves to the same
 * snapshot the diff describes.
 *
 * Pure: no DB, no network, no logger. Caller decides which pairs to
 * diff (see {@link formatSnapshotDiffBlocks}).
 */
export function formatSnapshotDiffBlock(
  base: { snapshotId: string; payload: unknown },
  head: { snapshotId: string; payload: unknown },
): string {
  const lines: string[] = [];

  for (const spec of SNAPSHOT_DIFF_ENTITY_SPECS) {
    const baseArr = getArrayField(base.payload, spec.payloadKey);
    const headArr = getArrayField(head.payload, spec.payloadKey);
    if (baseArr === null && headArr === null) continue;
    const a = baseArr ?? [];
    const b = headArr ?? [];

    const aMap = new Map<string, string>();
    for (const item of a) {
      const key = pickFirstStringy(item, spec.keyFields);
      if (key !== null) {
        aMap.set(key, entityLabel(item, spec.keyFields, spec.nameFields));
      }
    }
    const bMap = new Map<string, string>();
    for (const item of b) {
      const key = pickFirstStringy(item, spec.keyFields);
      if (key !== null) {
        bMap.set(key, entityLabel(item, spec.keyFields, spec.nameFields));
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    for (const [key, label] of bMap) if (!aMap.has(key)) added.push(label);
    for (const [key, label] of aMap) if (!bMap.has(key)) removed.push(label);

    const headline = `${spec.label}: ${a.length} → ${b.length} (+${added.length}/-${removed.length})`;
    lines.push(headline);
    if (added.length > 0) lines.push(`  added: ${formatLabelList(added)}`);
    if (removed.length > 0) {
      lines.push(`  removed: ${formatLabelList(removed)}`);
    }
  }

  // Walls: count-only — Revit walls don't carry a stable user-facing
  // identifier the way rooms/sheets do, so a name-list diff would be
  // noise. The chat prompt cares about the magnitude of change, not the
  // wall instance ids.
  const aWalls = countWalls(base.payload);
  const bWalls = countWalls(head.payload);
  if (aWalls !== null || bWalls !== null) {
    const ac = aWalls ?? 0;
    const bc = bWalls ?? 0;
    const delta = bc - ac;
    // Always show an explicit sign on the delta so the line scans the
    // same as the named-entity buckets above ("+15", "-3", "+0"). A
    // bare "0" reads ambiguously next to "+15" further up the block.
    const sign = delta >= 0 ? "+" : "";
    lines.push(`Walls: ${ac} → ${bc} (${sign}${delta})`);
  }

  const body =
    lines.length > 0
      ? lines.join("\n")
      : "No structural deltas detected between these snapshots.";
  return `<snapshot_diff base="${base.snapshotId}" head="${head.snapshotId}">\n${body}\n</snapshot_diff>`;
}

/**
 * Build the per-pair `<snapshot_diff>` blocks for a focus-mode turn
 * (Task #54). Returns `[]` when there are fewer than two focus payloads
 * (a single-snapshot turn has nothing to diff against).
 *
 * Diffing is **consecutive-pair** rather than star-diff against the
 * first entry: for `[A, B, C]` we emit `A→B` and `B→C`. This matches
 * how Revit pushes evolve over time (each push is the previous one
 * plus changes) and keeps the per-block size bounded by the largest
 * single push delta rather than by an O(n²) cross-product. The model
 * can still answer "what changed between A and C" by chaining the two
 * blocks; the blocks themselves stay compact.
 *
 * Order matches the input order — the chat route assembles
 * `focusPayloads` in the same order it resolved the requested ids
 * (explicit-body → inline-reference → latest-fallback), so the diff
 * sequence matches the order the user picked snapshots in the
 * comparison picker.
 */
export function formatSnapshotDiffBlocks(
  focusPayloads: ReadonlyArray<{ snapshotId: string; payload: unknown }>,
): string[] {
  if (focusPayloads.length < 2) return [];
  const blocks: string[] = [];
  for (let i = 1; i < focusPayloads.length; i++) {
    blocks.push(
      formatSnapshotDiffBlock(focusPayloads[i - 1], focusPayloads[i]),
    );
  }
  return blocks;
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
      ? `\n\nWhen you reference an entity from <framework_atoms> or one the user can plausibly drill into, embed an inline reference of the form \`{{atom|type|id|label}}\` where \`type\` is one of: ${atomTypeList
          .map((d) => `\`${d.entityType}\``)
          .join(", ")}. Use only entity ids that appear in <framework_atoms> — never invent ids.`
      : "";

  // Snapshot focus mode (Task #39, expanded by Task #44). When the
  // chat route detects the caller has opted *this turn* into focus
  // mode — explicit `snapshotFocus: true` flag, an inline
  // `{{atom|snapshot|<id>|focus}}` reference, or the explicit
  // `snapshotFocusIds: string[]` body field — it forwards the raw
  // `snapshots.payload` blob(s) through `latestSnapshot.focusPayloads`.
  // We then emit one dedicated `<snapshot_focus snapshot_id="…">`
  // block per id (siblings of `<framework_atoms>`) plus a single
  // instruction line telling the model it may use the JSON for
  // structured lookups and naming each candidate id as a citation
  // target. Default chat path leaves `focusPayloads` empty, both
  // surfaces stay empty, and the Task #34 JSON-free contract is
  // preserved.
  const focusPayloads = latestSnapshot.focusPayloads ?? [];
  const focusFormatted =
    focusPayloads.length > 0
      ? formatSnapshotFocusBlocks(focusPayloads)
      : {
          blocks: [] as string[],
          stats: {
            totalCount: 0,
            intactCount: 0,
            combinedCapTruncatedCount: 0,
            combinedCapOmittedCount: 0,
          } satisfies SnapshotFocusBlocksStats,
        };
  const snapshotFocusBlock =
    focusFormatted.blocks.length > 0
      ? "\n\n" + focusFormatted.blocks.join("\n\n")
      : "";

  // Per-pair `<snapshot_diff>` summaries (Task #54). Only emitted when
  // the user staged 2+ snapshots for comparison this turn — a single
  // focus snapshot has nothing to diff against. The diff is a sibling
  // of the raw `<snapshot_focus>` blocks above; it does NOT replace
  // them, because the model still needs the raw payload to answer
  // fine-grained "what's the area of room 204 on the head snapshot?"
  // questions. The diff block is the comparison-question shortcut: it
  // pre-computes added/removed entities so the model doesn't have to
  // rederive them by walking two large JSON blobs in its head, which
  // it does poorly at any scale.
  const snapshotDiffBlocks =
    focusPayloads.length >= 2 ? formatSnapshotDiffBlocks(focusPayloads) : [];
  const snapshotDiffBlock =
    snapshotDiffBlocks.length > 0
      ? "\n\n" + snapshotDiffBlocks.join("\n\n")
      : "";

  const snapshotFocusInstruction =
    focusPayloads.length > 0
      ? "\n\n" +
        (focusPayloads.length === 1
          ? "A `<snapshot_focus>` block below carries the raw structured snapshot payload for this turn. "
          : `${focusPayloads.length} \`<snapshot_focus>\` blocks below carry the raw structured snapshot payloads for this turn — one per snapshot you may compare against. `) +
        "Use them to answer fine-grained questions about specific rooms, doors, schedules, or any item the snapshot atom's prose would have summarised away. Cite the snapshot you draw from with " +
        focusPayloads
          .map((fp) => `\`{{atom|snapshot|${fp.snapshotId}|focus}}\``)
          .join(" or ") +
        " so the answer stays attributable to the right snapshot." +
        (snapshotDiffBlocks.length > 0
          ? ` A pre-computed \`<snapshot_diff>\` block is also included for each consecutive pair (base→head) summarising rooms, sheets, levels, areas, and walls added or removed — prefer those summaries over re-deriving deltas from the raw payloads, and cite the head snapshot when you reference a delta.`
          : "")
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
    snapshotFocusBlock +
    snapshotDiffBlock;

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

  return {
    systemPrompt,
    messages,
    snapshotFocusStats: focusFormatted.stats,
  };
}
