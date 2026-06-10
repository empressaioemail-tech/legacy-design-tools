import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Camera,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  FileText,
  Paperclip,
  Telescope,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import type { SnapshotSummary } from "@workspace/api-client-react";
import { useSidebarState } from "@workspace/portal-ui";
import { useEngagementsStore } from "../store/engagements";
import { relativeTime } from "../lib/relativeTime";
import {
  renderWithAtomChips,
  type SnapshotChipCompareContext,
} from "./atomChips";
import "./claude-markdown.css";

// Hard cap that mirrors `MAX_FOCUS_SNAPSHOTS` in
// `artifacts/api-server/src/routes/chat.ts`. Exceeding this client-side
// would just get the extras silently dropped server-side, so we surface
// the cap directly in the picker and disable additional checkboxes once
// it's reached.
const MAX_FOCUS_SNAPSHOTS = 4;

/**
 * Distance (px) from the bottom of the message list within which the user
 * still counts as "at the bottom" and the panel keeps auto-following the
 * streaming response (QA-19). Generous enough that a near-bottom read is
 * not treated as a deliberate scroll-up.
 */
const SCROLL_STICK_THRESHOLD_PX = 64;

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
      <path
        d="M12 2 L21.5 7 L21.5 17 L12 22 L2.5 17 L2.5 7 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Human labels for the WS-C agent tools — keeps the tool-activity status
 * lines readable instead of echoing raw snake_case tool names.
 */
const TOOL_LABELS: Record<string, string> = {
  list_sheets: "Listed sheets",
  read_sheet: "Read a sheet",
  list_findings: "Read findings",
  list_submissions: "Read submissions",
  list_snapshots: "Read snapshots",
  list_response_tasks: "Read response tasks",
  list_detail_callout_specs: "Read detail callouts",
  list_product_spec_references: "Read product specs",
  read_site_context: "Read site context",
  create_response_tasks: "Created response tasks",
  draft_detail_callout_spec: "Drafted a detail callout",
  draft_product_spec_reference: "Drafted a product spec",
  list_attached_documents: "Read attached documents",
  list_client_materials: "Listed client materials",
  read_attached_document: "Read an attached document",
  generate_deliverable_letter: "Drafted a client letter",
  generate_presentation_packet: "Drafted a presentation packet",
  list_engagements: "Listed projects",
  summarize_inbox: "Summarized inbox",
};

/**
 * File types the "Attach file" picker offers (QA-18). The server accepts
 * any `application/pdf`, `image/*`, or `text/*` upload — this `accept`
 * string just nudges the OS picker toward client PDFs, photos, and notes.
 */
const DOCUMENT_UPLOAD_ACCEPT = ".pdf,application/pdf,image/*,.txt,.md,text/plain";

interface ClaudeChatProps {
  engagementId: string;
  hasSnapshots: boolean;
  /**
   * Recent snapshots for the active engagement, ordered most-recent
   * first by the parent (matches the engagement detail page's snapshot
   * list). Used to (1) populate the "Compare pushes" picker and (2)
   * resolve `{{atom|snapshot|<id>|focus}}` citation tooltips with the
   * snapshot's relative timestamp. Defaults to `[]` so the existing
   * non-comparison call sites don't have to thread the prop through.
   */
  snapshots?: ReadonlyArray<SnapshotSummary>;
  /**
   * WS-C — the engagement-detail tab the operator is currently viewing,
   * forwarded to the chat route as ambient context so the agent knows
   * where the operator is without being told.
   */
  activeTab?: string;
  /** QA-45 — dashboard/portfolio chat without an open engagement. */
  chatScope?: "engagement" | "workspace";
}

export function ClaudeChat({
  engagementId,
  hasSnapshots,
  snapshots = [],
  activeTab,
  chatScope = "engagement",
}: ClaudeChatProps) {
  const workspaceMode = chatScope === "workspace";
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
  const agentActionsByEngagement = useEngagementsStore(
    (s) => s.agentActionsByEngagement,
  );
  const artifactNavByEngagement = useEngagementsStore(
    (s) => s.artifactNavByEngagement,
  );
  const reverseAgentAction = useEngagementsStore((s) => s.reverseAgentAction);
  const applyArtifactNav = useEngagementsStore((s) => s.applyArtifactNav);
  // QA-18 — engagement-scoped client documents.
  const attachedDocumentsByEngagement = useEngagementsStore(
    (s) => s.attachedDocumentsByEngagement,
  );
  const uploadingDocumentByEngagement = useEngagementsStore(
    (s) => s.uploadingDocumentByEngagement,
  );
  const documentUploadErrorByEngagement = useEngagementsStore(
    (s) => s.documentUploadErrorByEngagement,
  );
  const loadAttachedDocuments = useEngagementsStore(
    (s) => s.loadAttachedDocuments,
  );
  const uploadAttachedDocument = useEngagementsStore(
    (s) => s.uploadAttachedDocument,
  );
  const collapsed = useSidebarState((s) => s.rightCollapsed);
  const toggleRight = useSidebarState((s) => s.toggleRight);
  const [input, setInput] = useState("");
  // QA-19 — auto-scroll. `scrollRef` is the message list; `stickToBottom`
  // is true while the user is at (or near) the bottom and flips to false
  // the moment they deliberately scroll up, so a streaming response never
  // yanks an operator away from earlier output they are reading.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  // QA-18 — hidden file input driven by the "Attach file" button.
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  // WS-C — agent-action log for this engagement (WSC.5). The engagement
  // page watches the same list to refresh the Response Tasks query and
  // navigate there once a create turn settles, so this component itself
  // stays free of react-query.
  const agentActions = agentActionsByEngagement[engagementId] ?? [];
  const pendingArtifactNav = artifactNavByEngagement[engagementId] ?? null;
  // QA-18 — persisted client documents for this engagement.
  const attachedDocuments = attachedDocumentsByEngagement[engagementId] ?? [];
  const uploadingDocument =
    uploadingDocumentByEngagement[engagementId] ?? false;
  const documentUploadError =
    documentUploadErrorByEngagement[engagementId] ?? null;

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

  // QA-19 — a primitive that changes on every streamed token (the last
  // message grows) and on every new turn (the count grows), so the
  // auto-scroll effect re-runs as the response streams in.
  const lastMessage = messages[messages.length - 1];
  const streamSignal = `${messages.length}:${lastMessage?.content.length ?? 0}`;

  // Auto-scroll the message list to the bottom as content streams in.
  // Skipped while `stickToBottom` is false — i.e. the operator has
  // scrolled up to read earlier output and must not be pulled back down.
  useEffect(() => {
    if (collapsed || !stickToBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [streamSignal, collapsed, stickToBottom]);

  // Switching engagements opens a different conversation — re-arm
  // auto-scroll so the new thread starts pinned to its latest message.
  useEffect(() => {
    setStickToBottom(true);
  }, [engagementId]);

  // Track whether the user is at the bottom. A deliberate scroll-up
  // suppresses auto-follow; scrolling back down within the threshold
  // re-arms it. Programmatic scroll-to-bottom lands within the threshold
  // and simply keeps the flag true — no feedback loop.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= SCROLL_STICK_THRESHOLD_PX);
  };

  // QA-18 — load the engagement's persisted client documents so the
  // chip row shows what the in-app agent can reach.
  useEffect(() => {
    if (workspaceMode) return;
    void loadAttachedDocuments(engagementId);
  }, [engagementId, loadAttachedDocuments, workspaceMode]);

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the value so re-selecting the same file still fires onChange.
    e.target.value = "";
    if (file) void uploadAttachedDocument(engagementId, file);
  };

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
      ...(activeTab ? { activeTab } : {}),
      ...(workspaceMode ? { chatScope: "workspace" as const } : {}),
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
        <span style={{ color: "var(--cyan)" }}>
        <HexGlyph size={20} />
      </span>
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

  const placeholder = workspaceMode
    ? "Ask which projects need attention (Cmd/Ctrl + Enter)"
    : hasSnapshots
      ? "Ask a question (Cmd/Ctrl + Enter to send)"
      : "Send a snapshot from Revit first.";

  return (
    <div className="flex flex-col h-full">
      <div className="sc-card-header flex flex-col gap-1 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--cyan)" }}>
              <HexGlyph />
            </span>
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

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="claude-chat-scroll"
        className="flex-1 overflow-y-auto sc-scroll p-4 flex flex-col gap-4"
      >
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
                <div className="rounded-lg px-3 py-2 claude-chat-user-bubble">
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
                      background: "var(--cyan-accent-bg)",
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
                      background: "var(--cyan-accent-bg)",
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

          // Walk back to find this assistant message's preceding user
          // turn so we can read the snapshot ids the user staged for
          // comparison on that turn (Task #54). The store's send flow
          // always inserts a user msg followed by an assistant msg
          // sequentially, so messages[i-1] is the right turn — but be
          // defensive in case the message list shape ever changes.
          const priorUser = (() => {
            for (let j = i - 1; j >= 0; j--) {
              if (messages[j]?.role === "user") return messages[j];
            }
            return undefined;
          })();
          const compareContext: SnapshotChipCompareContext | null =
            priorUser?.snapshotFocusIds && priorUser.snapshotFocusIds.length > 0
              ? {
                  engagementId,
                  comparePartnerIds: priorUser.snapshotFocusIds,
                }
              : { engagementId, comparePartnerIds: [] };

          return (
            <div key={i} className="self-start max-w-[90%]">
              <div className="sc-card sc-accent-cyan px-3.5 py-2.5">
                {msg.toolActivity && msg.toolActivity.length > 0 && (
                  <div
                    className="flex flex-col gap-1"
                    style={{ marginBottom: 6 }}
                  >
                    {msg.toolActivity.map((tool, ti) => (
                      <span
                        key={ti}
                        className="sc-meta"
                        data-testid="claude-tool-activity"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          fontSize: 11,
                          color: "var(--text-secondary)",
                          opacity: 0.85,
                        }}
                      >
                        <Wrench size={10} />
                        {TOOL_LABELS[tool] ?? tool}
                      </span>
                    ))}
                  </div>
                )}
                <div className="claude-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      p: ({ children }) => (
                        <p>
                          {renderWithAtomChips(
                            children,
                            snapshotLookup,
                            compareContext,
                          )}
                        </p>
                      ),
                      li: ({ children }) => (
                        <li>
                          {renderWithAtomChips(
                            children,
                            snapshotLookup,
                            compareContext,
                          )}
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
                        boxShadow: "0 0 7px var(--cyan-accent-glow)",
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {pendingArtifactNav && !workspaceMode && (
        <div
          className="flex-shrink-0 border-t"
          data-testid="artifact-nav-banner"
          style={{
            borderColor: "var(--border-default)",
            padding: "10px 12px",
          }}
        >
          <button
            type="button"
            className="sc-btn-primary sc-btn-sm"
            data-testid="artifact-nav-open"
            onClick={() => applyArtifactNav(engagementId)}
            style={{ width: "100%" }}
          >
            Open {pendingArtifactNav.label} →
          </button>
        </div>
      )}

      {agentActions.length > 0 && (
        <div
          className="flex-shrink-0 border-t"
          data-testid="agent-action-log"
          style={{
            borderColor: "var(--border-default)",
            padding: "10px 12px",
          }}
        >
          <div
            className="sc-label"
            style={{ color: "var(--text-secondary)", marginBottom: 6 }}
          >
            AGENT ACTIONS THIS SESSION
          </div>
          <div
            className="flex flex-col gap-1.5 sc-scroll"
            style={{ maxHeight: 132, overflowY: "auto" }}
          >
            {agentActions.map((action) => (
              <div
                key={action.entityId}
                data-testid={`agent-action-${action.entityId}`}
                className="flex items-center gap-2"
                style={{ fontSize: 11.5, color: "var(--text-secondary)" }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={`Created response task: ${action.label}`}
                >
                  Created task: {action.label}
                </span>
                {action.reversed ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      color: "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  >
                    <CheckCircle2 size={11} />
                    Reversed
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={`agent-action-reverse-${action.entityId}`}
                    onClick={() => {
                      void reverseAgentAction(engagementId, action.entityId);
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      flexShrink: 0,
                      background: "transparent",
                      border: "1px solid var(--border-default)",
                      color: "var(--text-secondary)",
                      borderRadius: 3,
                      padding: "2px 6px",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    <Undo2 size={11} />
                    Reverse
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
                    background: "var(--cyan-accent-bg)",
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
                  background: "var(--cyan-accent-bg)",
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
        {attachedDocuments.length > 0 && (
          <div
            className="flex items-center gap-2 flex-wrap"
            aria-label="Attached client documents"
          >
            {attachedDocuments.map((doc) => (
              <span
                key={doc.id}
                className="sc-pill"
                data-testid={`attached-document-${doc.id}`}
                title={`${doc.title} — ${doc.documentType}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  maxWidth: 200,
                  background: "var(--bg-input)",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-default)",
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 4,
                }}
              >
                <FileText size={11} style={{ flexShrink: 0 }} />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {doc.title}
                </span>
              </span>
            ))}
          </div>
        )}
        {documentUploadError && (
          <div
            className="sc-meta"
            role="alert"
            style={{ color: "var(--danger)", fontSize: 11 }}
          >
            {documentUploadError}
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
            <input
              ref={fileInputRef}
              type="file"
              accept={DOCUMENT_UPLOAD_ACCEPT}
              onChange={handleFileSelected}
              data-testid="claude-chat-file-input"
              aria-hidden="true"
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={handleAttachClick}
              disabled={!hasSnapshots || streaming || uploadingDocument}
              aria-label="Attach a client document"
              title="Attach a client PDF, photo, or note to this engagement"
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
                  !hasSnapshots || streaming || uploadingDocument
                    ? "not-allowed"
                    : "pointer",
                background: "transparent",
                border: "1px solid var(--border-default)",
                color: "var(--text-secondary)",
                opacity:
                  !hasSnapshots || streaming || uploadingDocument ? 0.5 : 1,
              }}
            >
              <Paperclip size={12} />
              {uploadingDocument ? "Uploading…" : "Attach"}
            </button>
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
                    ? "var(--cyan-accent-bg)"
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
                  ? "var(--cyan-accent-bg)"
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
