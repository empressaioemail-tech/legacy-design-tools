import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { BookOpen, ChevronLeft, ChevronRight, Telescope, X } from "lucide-react";
import { useSidebarState } from "@workspace/portal-ui";
import { useEngagementsStore } from "../store/engagements";
import "./claude-markdown.css";

// [[CODE:atomId]] markers in assistant messages render as inline chips that
// link to the Code Library detail view. The atomId is a UUID — restrict the
// regex to that shape so we don't accidentally match unrelated double-bracket
// constructs the model might emit.
const ATOM_TOKEN_RE = /\[\[CODE:([0-9a-fA-F-]{8,})\]\]/g;
const CODE_LIBRARY_BASE = `${import.meta.env.BASE_URL}code-library`;

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
 * Walks the children produced by ReactMarkdown and rewrites text nodes that
 * contain [[CODE:atomId]] markers into a mix of plain text and chip elements.
 * Non-string children (e.g. nested elements like <strong>, <code>) pass
 * through untouched.
 */
function renderWithAtomChips(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    if (!ATOM_TOKEN_RE.test(children)) return children;
    ATOM_TOKEN_RE.lastIndex = 0;
    const out: ReactNode[] = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = ATOM_TOKEN_RE.exec(children)) !== null) {
      if (m.index > lastIdx) out.push(children.slice(lastIdx, m.index));
      out.push(<CodeAtomChip key={`atom-${key++}`} atomId={m[1]} />);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < children.length) out.push(children.slice(lastIdx));
    return out;
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <span key={`mc-${i}`}>{renderWithAtomChips(c)}</span>
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
}

export function ClaudeChat({ engagementId, hasSnapshots }: ClaudeChatProps) {
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
  const collapsed = useSidebarState((s) => s.rightCollapsed);
  const toggleRight = useSidebarState((s) => s.toggleRight);
  const [input, setInput] = useState("");
  // Snapshot focus opts in for one turn at a time. It's intentionally off by
  // default and resets after each send so users don't pay the focus cost on
  // every follow-up.
  const [snapshotFocus, setSnapshotFocus] = useState(false);

  const messages = messagesByEngagement[engagementId] || [];
  const attachedSheets = attachedSheetsByEngagement[engagementId] ?? [];

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
    sendMessage(engagementId, input, { snapshotFocus });
    setInput("");
    setSnapshotFocus(false);
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
            return (
              <div key={i} className="self-end max-w-[80%]">
                <div
                  className="rounded-lg px-3 py-2 text-white sc-ui"
                  style={{ background: "var(--cyan)" }}
                >
                  {msg.content}
                </div>
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
                        <p>{renderWithAtomChips(children)}</p>
                      ),
                      li: ({ children }) => (
                        <li>{renderWithAtomChips(children)}</li>
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
