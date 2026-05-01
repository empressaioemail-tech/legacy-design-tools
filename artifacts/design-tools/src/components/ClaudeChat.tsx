import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  BookOpen,
  Camera,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Telescope,
  X,
} from "lucide-react";
import type { SnapshotSummary } from "@workspace/api-client-react";
import { useSidebarState } from "@workspace/portal-ui";
import { useEngagementsStore } from "../store/engagements";
import { relativeTime } from "../lib/relativeTime";
import "./claude-markdown.css";

// [[CODE:atomId]] markers in assistant messages render as inline chips that
// link to the Code Library detail view. The atomId is a UUID — restrict the
// regex to that shape so we don't accidentally match unrelated double-bracket
// constructs the model might emit.
const ATOM_TOKEN_RE = /\[\[CODE:([0-9a-fA-F-]{8,})\]\]/g;
const CODE_LIBRARY_BASE = `${import.meta.env.BASE_URL}code-library`;

// `{{atom:snapshot:<uuid>:focus}}` markers in assistant messages render as
// snapshot attribution chips (Task #48). The model is instructed by the
// chat prompt's snapshot-focus citation rule (see
// `lib/codes/src/promptFormatter.ts`) to cite each snapshot it draws from
// with this exact form, so the regex is anchored to the `:focus` mode.
// Hex-id length matches the CODE chip to keep stale or malformed ids from
// rendering as chips.
const SNAPSHOT_FOCUS_TOKEN_RE =
  /\{\{atom:snapshot:([0-9a-fA-F-]{8,}):focus\}\}/g;

// Hard cap that mirrors `MAX_FOCUS_SNAPSHOTS` in
// `artifacts/api-server/src/routes/chat.ts`. Exceeding this client-side
// would just get the extras silently dropped server-side, so we surface
// the cap directly in the picker and disable additional checkboxes once
// it's reached.
const MAX_FOCUS_SNAPSHOTS = 4;

function CodeAtomChip({ atomId }: { atomId: string }) {
  const short = atomId.slice(0, 8);
  return (
    <a
      href={`${CODE_LIBRARY_BASE}?atom=${atomId}`}
      title={`Open atom ${atomId} in Code Library`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "rgba(99, 152, 170, 0.18)",
        color: "var(--cyan)",
        fontSize: 10,
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: 3,
        textTransform: "uppercase",
        textDecoration: "none",
        verticalAlign: "baseline",
        marginInline: 2,
      }}
    >
      <BookOpen size={9} />
      CODE·{short}
    </a>
  );
}

/**
 * Inline chip rendered for `{{atom:snapshot:<id>:focus}}` markers Claude
 * embeds when answering comparison-style questions (Task #48). The chip's
 * tooltip carries the snapshot's "captured X ago" timestamp when the
 * caller can resolve the id through {@link snapshotLookup}; ids that
 * aren't in the engagement's snapshot list still render as a chip but
 * with a generic tooltip — that's the expected degraded path for
 * archived/older snapshots whose summaries are no longer in memory.
 */
function SnapshotFocusChip({
  snapshotId,
  snapshotLookup,
}: {
  snapshotId: string;
  snapshotLookup?: ReadonlyMap<string, SnapshotSummary>;
}) {
  const short = snapshotId.slice(0, 8);
  const meta = snapshotLookup?.get(snapshotId);
  const tooltip = meta
    ? `Snapshot ${short} — captured ${relativeTime(meta.receivedAt)}`
    : `Snapshot ${snapshotId}`;
  return (
    <span
      data-testid={`snapshot-citation-${snapshotId}`}
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "rgba(99, 152, 170, 0.18)",
        color: "var(--cyan)",
        fontSize: 10,
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: 3,
        textTransform: "uppercase",
        verticalAlign: "baseline",
        marginInline: 2,
      }}
    >
      <Camera size={9} />
      SNAP·{short}
    </span>
  );
}

/**
 * Walks the children produced by ReactMarkdown and rewrites text nodes that
 * contain `[[CODE:atomId]]` or `{{atom:snapshot:<id>:focus}}` markers into
 * a mix of plain text and chip elements. Non-string children (e.g. nested
 * elements like <strong>, <code>) pass through untouched.
 *
 * Both regexes are scanned in a single pass over the string — the snapshot
 * marker uses curly braces so it can't overlap the square-bracket CODE
 * marker, but driving them off the same offset keeps the output ordering
 * stable when both kinds appear in the same paragraph.
 */
function renderWithAtomChips(
  children: ReactNode,
  snapshotLookup?: ReadonlyMap<string, SnapshotSummary>,
): ReactNode {
  if (typeof children === "string") {
    const text = children;
    type Hit = { index: number; length: number; node: ReactNode };
    const hits: Hit[] = [];
    let m: RegExpExecArray | null;
    let key = 0;
    // Both regexes are /g + module-scoped, so their `lastIndex` survives
    // across calls. Always reset immediately before iterating to keep
    // every render call deterministic — never rely on a precheck `.test`
    // because `.test` advances `lastIndex` on a /g regex too.
    ATOM_TOKEN_RE.lastIndex = 0;
    while ((m = ATOM_TOKEN_RE.exec(text)) !== null) {
      hits.push({
        index: m.index,
        length: m[0].length,
        node: <CodeAtomChip key={`code-${key++}`} atomId={m[1]} />,
      });
    }
    SNAPSHOT_FOCUS_TOKEN_RE.lastIndex = 0;
    while ((m = SNAPSHOT_FOCUS_TOKEN_RE.exec(text)) !== null) {
      hits.push({
        index: m.index,
        length: m[0].length,
        node: (
          <SnapshotFocusChip
            key={`snap-${key++}`}
            snapshotId={m[1]}
            snapshotLookup={snapshotLookup}
          />
        ),
      });
    }
    if (hits.length === 0) return text;
    hits.sort((a, b) => a.index - b.index);

    const out: ReactNode[] = [];
    let lastIdx = 0;
    for (const h of hits) {
      if (h.index < lastIdx) continue; // shouldn't happen, defensive
      if (h.index > lastIdx) out.push(text.slice(lastIdx, h.index));
      out.push(h.node);
      lastIdx = h.index + h.length;
    }
    if (lastIdx < text.length) out.push(text.slice(lastIdx));
    return out;
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <span key={`mc-${i}`}>{renderWithAtomChips(c, snapshotLookup)}</span>
    ));
  }
  return children;
}

function HexGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M12 2 L21.5 7 L21.5 17 L12 22 L2.5 17 L2.5 7 Z" fill="#6398AA" />
    </svg>
  );
}

interface ClaudeChatProps {
  engagementId: string;
  hasSnapshots: boolean;
  /**
   * Recent snapshots for the active engagement, ordered most-recent
   * first by the parent (matches the engagement detail page's snapshot
   * list). Used to (1) populate the "Compare pushes" picker and (2)
   * resolve `{{atom:snapshot:<id>:focus}}` citation tooltips with the
   * snapshot's relative timestamp. Defaults to `[]` so the existing
   * non-comparison call sites don't have to thread the prop through.
   */
  snapshots?: ReadonlyArray<SnapshotSummary>;
}

export function ClaudeChat({
  engagementId,
  hasSnapshots,
  snapshots = [],
}: ClaudeChatProps) {
  const messagesByEngagement = useEngagementsStore(
    (s) => s.messagesByEngagement,
  );
  const attachedSheetsByEngagement = useEngagementsStore(
    (s) => s.attachedSheetsByEngagement,
  );
  const streaming = useEngagementsStore((s) => s.streaming);
  const sendMessage = useEngagementsStore((s) => s.sendMessage);
  const detachSheet = useEngagementsStore((s) => s.detachSheet);
  const clearAttachedSheets = useEngagementsStore((s) => s.clearAttachedSheets);
  const consumePendingChatInput = useEngagementsStore(
    (s) => s.consumePendingChatInput,
  );
  const pendingChatInputByEngagement = useEngagementsStore(
    (s) => s.pendingChatInputByEngagement,
  );
  const focusSnapshotIdsByEngagement = useEngagementsStore(
    (s) => s.focusSnapshotIdsByEngagement,
  );
  const toggleFocusSnapshot = useEngagementsStore(
    (s) => s.toggleFocusSnapshot,
  );
  const clearFocusSnapshots = useEngagementsStore(
    (s) => s.clearFocusSnapshots,
  );
  const collapsed = useSidebarState((s) => s.rightCollapsed);
  const toggleRight = useSidebarState((s) => s.toggleRight);
  const [input, setInput] = useState("");
  // Snapshot focus opts in for one turn at a time. It's intentionally off by
  // default and resets after each send so users don't pay the focus cost on
  // every follow-up.
  const [snapshotFocus, setSnapshotFocus] = useState(false);
  // Whether the comparison picker panel is expanded. Open state is local —
  // selection state lives in the store so it survives panel collapse and
  // is read by handleSend below.
  const [pickerOpen, setPickerOpen] = useState(false);

  const messages = messagesByEngagement[engagementId] || [];
  const attachedSheets = attachedSheetsByEngagement[engagementId] ?? [];
  const focusSnapshotIds = focusSnapshotIdsByEngagement[engagementId] ?? [];

  // Lookup table for chip tooltips and picker rows. Memoized so the
  // SnapshotFocusChip components don't get a fresh map identity on every
  // streaming token tick.
  const snapshotLookup = useMemo(() => {
    const m = new Map<string, SnapshotSummary>();
    for (const s of snapshots) m.set(s.id, s);
    return m;
  }, [snapshots]);

  // Pull any pending input that the SheetViewer "Ask Claude" button queued up.
  // We do this in an effect (not render) so we don't loop, and we only
  // consume it when the panel is expanded so the user actually sees it.
  useEffect(() => {
    if (collapsed) return;
    const pending = pendingChatInputByEngagement[engagementId];
    if (pending !== undefined) {
      const value = consumePendingChatInput(engagementId);
      if (value !== null) setInput(value);
    }
  }, [
    collapsed,
    engagementId,
    pendingChatInputByEngagement,
    consumePendingChatInput,
  ]);

  const handleSend = () => {
    if (!input.trim() || !hasSnapshots || streaming) return;
    // Cap the staged ids client-side too — the server caps at the same
    // value, but trimming here keeps the user message chip honest about
    // what was actually compared.
    const stagedFocusIds = focusSnapshotIds.slice(0, MAX_FOCUS_SNAPSHOTS);
    sendMessage(engagementId, input, {
      snapshotFocus,
      ...(stagedFocusIds.length > 0
        ? { snapshotFocusIds: stagedFocusIds }
        : {}),
    });
    setInput("");
    setSnapshotFocus(false);
    // The store also clears these inside sendMessage, but doing it here
    // collapses the picker panel synchronously so the UI doesn't briefly
    // show a stale selection while the request is in flight.
    if (stagedFocusIds.length > 0) clearFocusSnapshots(engagementId);
    setPickerOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  if (collapsed) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          height: "100%",
          padding: "16px 0",
          gap: 12,
        }}
      >
        <HexGlyph size={20} />
        <button
          onClick={toggleRight}
          title="Expand Claude (⇤)"
          aria-label="Expand Claude"
          style={{
            width: 28,
            height: 28,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          <ChevronLeft size={14} />
        </button>
      </div>
    );
  }

  const placeholder = hasSnapshots
    ? "Ask a question (Cmd/Ctrl + Enter to send)"
    : "Send a snapshot from Revit first.";

  return (
    <div className="flex flex-col h-full">
      <div className="sc-card-header flex flex-col gap-1 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HexGlyph />
            <span className="sc-label">CLAUDE</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="sc-body opacity-70">Ask about this model</div>
            <button
              onClick={toggleRight}
              title="Collapse Claude"
              aria-label="Collapse Claude"
              style={{
                width: 24,
                height: 24,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "1px solid var(--border-default)",
                color: "var(--text-secondary)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
        <div className="sc-meta opacity-60">
          Chat history is session-only — refreshing the page clears it.
        </div>
      </div>

      <div className="flex-1 overflow-y-auto sc-scroll p-4 flex flex-col gap-4">
        {messages.map((msg, i) => {
          const isUser = msg.role === "user";
          const isLastAssistant = !isUser && i === messages.length - 1;

          if (isUser) {
            const comparedCount = msg.snapshotFocusIds?.length ?? 0;
            return (
              <div
                key={i}
                className="self-end max-w-[80%] flex flex-col items-end gap-1"
              >
                <div
                  className="rounded-lg px-3 py-2 text-white sc-ui"
                  style={{ background: "var(--cyan)" }}
                >
                  {msg.content}
                </div>
                {msg.snapshotFocus && (
                  <span
                    className="sc-ui"
                    title="Sent with Dive deeper — full snapshot loaded for this turn"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 10,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      padding: "2px 6px",
                      borderRadius: 3,
                      background: "rgba(0,180,216,0.15)",
                      color: "var(--cyan)",
                      border: "1px solid var(--cyan)",
                    }}
                  >
                    <Telescope size={10} />
                    Snapshot focus
                  </span>
                )}
                {comparedCount > 0 && (
                  <span
                    className="sc-ui"
                    title={`Compared ${comparedCount} snapshot${comparedCount === 1 ? "" : "s"} on this turn`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 10,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      padding: "2px 6px",
                      borderRadius: 3,
                      background: "rgba(0,180,216,0.15)",
                      color: "var(--cyan)",
                      border: "1px solid var(--cyan)",
                    }}
                  >
                    <Camera size={10} />
                    Comparing {comparedCount} push
                    {comparedCount === 1 ? "" : "es"}
                  </span>
                )}
              </div>
            );
          }

          return (
            <div key={i} className="self-start max-w-[90%]">
              <div className="sc-card sc-accent-cyan px-3.5 py-2.5">
                <div className="claude-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      p: ({ children }) => (
                        <p>
                          {renderWithAtomChips(children, snapshotLookup)}
                        </p>
                      ),
                      li: ({ children }) => (
                        <li>
                          {renderWithAtomChips(children, snapshotLookup)}
                        </li>
                      ),
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                  {isLastAssistant && streaming && (
                    <span
                      className="inline-block ml-2 w-1.5 h-1.5 rounded-full sc-dot-pulse"
                      style={{
                        background: "var(--cyan)",
                        boxShadow: "0 0 7px rgba(0,180,216,0.75)",
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="p-4 border-t flex-shrink-0 flex flex-col gap-2"
        style={{ borderColor: "var(--border-default)" }}
      >
        {focusSnapshotIds.length > 0 && (
          <div
            className="flex items-center gap-2 flex-wrap"
            aria-label="Snapshots staged for comparison"
          >
            {focusSnapshotIds.map((sid) => {
              const meta = snapshotLookup.get(sid);
              const label = meta
                ? relativeTime(meta.receivedAt)
                : `${sid.slice(0, 8)}…`;
              return (
                <span
                  key={sid}
                  className="sc-pill"
                  data-testid={`focus-snapshot-pill-${sid}`}
                  title={
                    meta
                      ? `Snapshot ${sid} — captured ${relativeTime(meta.receivedAt)}`
                      : `Snapshot ${sid}`
                  }
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "rgba(0,180,216,0.15)",
                    color: "var(--cyan)",
                    fontSize: 11,
                    letterSpacing: "0.04em",
                    padding: "3px 4px 3px 8px",
                    borderRadius: 4,
                    textTransform: "uppercase",
                  }}
                >
                  <Camera size={11} />
                  {label}
                  <button
                    type="button"
                    onClick={() => toggleFocusSnapshot(engagementId, sid)}
                    aria-label={`Remove ${label} from comparison`}
                    style={{
                      width: 16,
                      height: 16,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: "none",
                      color: "var(--cyan)",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            {focusSnapshotIds.length >= 2 && (
              <button
                type="button"
                onClick={() => clearFocusSnapshots(engagementId)}
                className="sc-meta"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  textDecoration: "underline",
                  padding: 0,
                  fontSize: 11,
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}
        {pickerOpen && (
          <div
            role="region"
            aria-label="Compare snapshots picker"
            className="sc-card sc-scroll"
            style={{
              maxHeight: 220,
              overflowY: "auto",
              padding: 8,
              background: "var(--bg-input)",
            }}
          >
            <div
              className="sc-meta opacity-70"
              style={{ padding: "2px 4px 8px", fontSize: 11 }}
            >
              Pick snapshots to compare on the next turn (up to{" "}
              {MAX_FOCUS_SNAPSHOTS}).
            </div>
            {snapshots.length === 0 ? (
              <div className="sc-meta opacity-70" style={{ padding: "6px 4px" }}>
                No snapshots yet.
              </div>
            ) : (
              snapshots.map((s) => {
                const checked = focusSnapshotIds.includes(s.id);
                const atCap =
                  !checked &&
                  focusSnapshotIds.length >= MAX_FOCUS_SNAPSHOTS;
                return (
                  <label
                    key={s.id}
                    data-testid={`snapshot-picker-row-${s.id}`}
                    className="flex items-center gap-2"
                    style={{
                      padding: "6px 4px",
                      cursor: atCap ? "not-allowed" : "pointer",
                      opacity: atCap ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={atCap || streaming}
                      onChange={() => toggleFocusSnapshot(engagementId, s.id)}
                      aria-label={`Compare snapshot from ${relativeTime(s.receivedAt)}`}
                    />
                    <div className="flex flex-col">
                      <span className="sc-medium" style={{ fontSize: 12 }}>
                        {relativeTime(s.receivedAt)}
                      </span>
                      <span className="sc-meta opacity-70" style={{ fontSize: 11 }}>
                        {s.sheetCount ?? "—"}sh · {s.roomCount ?? "—"}rm ·{" "}
                        {s.levelCount ?? "—"}lv · {s.wallCount ?? "—"}w
                      </span>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        )}
        {attachedSheets.length > 0 && (
          <div
            className="flex items-center gap-2 flex-wrap"
            aria-label="Attached sheets"
          >
            {attachedSheets.map((s) => (
              <span
                key={s.id}
                className="sc-pill"
                title={`${s.sheetNumber} ${s.sheetName}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "rgba(0,180,216,0.15)",
                  color: "var(--cyan)",
                  fontSize: 11,
                  letterSpacing: "0.04em",
                  padding: "3px 4px 3px 8px",
                  borderRadius: 4,
                  textTransform: "uppercase",
                }}
              >
                {s.sheetNumber}
                <button
                  type="button"
                  onClick={() => detachSheet(engagementId, s.id)}
                  aria-label={`Remove ${s.sheetNumber}`}
                  style={{
                    width: 16,
                    height: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    color: "var(--cyan)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {attachedSheets.length >= 2 && (
              <button
                type="button"
                onClick={() => clearAttachedSheets(engagementId)}
                className="sc-meta"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  textDecoration: "underline",
                  padding: 0,
                  fontSize: 11,
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!hasSnapshots || streaming}
          placeholder={placeholder}
          className="w-full resize-none rounded-md sc-ui sc-scroll"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            padding: "8px 12px",
            height: "72px",
            outline: "none",
          }}
          onFocus={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-focus)")
          }
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-default)")
          }
        />
        <div className="flex justify-between items-center">
          <div className="sc-meta opacity-60">
            {attachedSheets.length > 0
              ? `${attachedSheets.length} sheet${attachedSheets.length === 1 ? "" : "s"} attached for vision`
              : ""}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              disabled={!hasSnapshots || streaming || snapshots.length === 0}
              aria-pressed={pickerOpen}
              aria-expanded={pickerOpen}
              aria-label="Compare past snapshots"
              title={
                snapshots.length === 0
                  ? "No snapshots available to compare"
                  : pickerOpen
                    ? "Hide snapshot comparison picker"
                    : "Pick past snapshots to compare on the next turn"
              }
              className="sc-ui"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "4px 8px",
                borderRadius: 4,
                cursor:
                  !hasSnapshots || streaming || snapshots.length === 0
                    ? "not-allowed"
                    : "pointer",
                background:
                  pickerOpen || focusSnapshotIds.length > 0
                    ? "rgba(0,180,216,0.15)"
                    : "transparent",
                border: `1px solid ${
                  pickerOpen || focusSnapshotIds.length > 0
                    ? "var(--cyan)"
                    : "var(--border-default)"
                }`,
                color:
                  pickerOpen || focusSnapshotIds.length > 0
                    ? "var(--cyan)"
                    : "var(--text-secondary)",
                opacity:
                  !hasSnapshots || streaming || snapshots.length === 0
                    ? 0.5
                    : 1,
              }}
            >
              <Camera size={12} />
              Compare
              {focusSnapshotIds.length > 0
                ? ` (${focusSnapshotIds.length})`
                : ""}
              <ChevronDown
                size={10}
                style={{
                  transform: pickerOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.15s",
                }}
              />
            </button>
            <button
              type="button"
              onClick={() => setSnapshotFocus((v) => !v)}
              disabled={!hasSnapshots || streaming}
              aria-pressed={snapshotFocus}
              aria-label="Dive deeper into the latest snapshot"
              title={
                snapshotFocus
                  ? "Snapshot focus on — next message will include the full snapshot payload"
                  : "Dive deeper: include the full latest snapshot in the next message (resets after send)"
              }
              className="sc-ui"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "4px 8px",
                borderRadius: 4,
                cursor:
                  !hasSnapshots || streaming ? "not-allowed" : "pointer",
                background: snapshotFocus
                  ? "rgba(0,180,216,0.15)"
                  : "transparent",
                border: `1px solid ${snapshotFocus ? "var(--cyan)" : "var(--border-default)"}`,
                color: snapshotFocus ? "var(--cyan)" : "var(--text-secondary)",
                opacity: !hasSnapshots || streaming ? 0.5 : 1,
              }}
            >
              <Telescope size={12} />
              Dive deeper
            </button>
            <button
              className="sc-btn-primary"
              onClick={handleSend}
              disabled={!hasSnapshots || streaming || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
