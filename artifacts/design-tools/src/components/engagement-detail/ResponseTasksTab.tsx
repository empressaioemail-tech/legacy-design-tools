import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListResponseTasks,
  getListResponseTasksQueryKey,
  useCreateResponseTask,
  useUpdateResponseTaskState,
  useLinkResponseTaskFinding,
  ApiError,
  type ResponseTaskAtom,
  type ResponseTaskState,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  AtSign,
  CheckCircle2,
  Clock,
  Hash,
  MessageSquare,
  MoreHorizontal,
  Search,
  Sparkles,
  User,
  XCircle,
} from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import { relativeTime } from "../../lib/relativeTime";

/**
 * State → left-rail accent and avatar palette. Mirrors the
 * Activity Stream mockup's vocabulary: red for "needs you" /
 * cancelled, cyan for in-progress and AI-drafted, green for
 * completed, slate for closed/cancelled.
 */
const ACCENT_BY_STATE: Record<
  ResponseTaskState,
  {
    accent: string;
    iconBg: string;
    iconFg: string;
    Icon: typeof Clock;
    label: string;
  }
> = {
  open: {
    accent: "var(--danger)",
    iconBg: "var(--danger-dim)",
    iconFg: "var(--danger-text)",
    Icon: AlertCircle,
    label: "Needs you",
  },
  "in-progress": {
    accent: "var(--cyan)",
    iconBg: "var(--cyan-accent-bg)",
    iconFg: "var(--cyan-text)",
    Icon: Clock,
    label: "In progress",
  },
  done: {
    accent: "var(--success)",
    iconBg: "var(--success-dim)",
    iconFg: "var(--success-text)",
    Icon: CheckCircle2,
    label: "Complete",
  },
  cancelled: {
    accent: "var(--border-default)",
    iconBg: "var(--bg-input)",
    iconFg: "var(--text-muted)",
    Icon: XCircle,
    label: "Cancelled",
  },
};

/**
 * Cortex L1 (Lane C.4 / C.4.1) — architect-side response-task surface.
 *
 * Surfaces the engagement's response-tasks — the persistent task state
 * for the client-comment response flow. An architect receives client
 * comments, opens response-tasks to track the work, transitions them
 * through `open → in-progress → done` (or `cancelled`), and links each
 * to the finding it addresses.
 *
 * This is the design-tools (architect-facing) side. The L1 spec in
 * `42_design_accelerator_program_plan.md` left the design-tools vs
 * plan-review side open "at L1 dispatch time"; design-tools is correct
 * because the response-task IS the architect's working unit — they
 * open it, work it, and complete it. Reviewers author the client
 * comments that motivate tasks but do not own task execution.
 *
 * Co-designed with cc-agent-M's `cortex_response_task_*` MCP tools:
 * the create form accepts the same `sourceClientCommentId` /
 * `findingId` linking inputs the `createResponseTask` MCP tool does, so
 * an operator opening a task from a client comment gets the same atom
 * whether they go through the UI or an agent.
 */

/**
 * `actorId` the WS-C in-app agent stamps onto every response-task it
 * creates. Kept in lock-step with `AI_AGENT_ACTOR_ID` in
 * `api-server/src/routes/chatAgentTools.ts` — the marker that makes an
 * agent-created task visibly distinct from an operator-created one
 * (WSC.5).
 */
const AI_AGENT_ACTOR_ID = "cortex-in-app-agent";

const RESPONSE_TASK_STATE_LABELS: Record<ResponseTaskState, string> = {
  open: "Open",
  "in-progress": "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

const RESPONSE_TASK_STATE_COLORS: Record<
  ResponseTaskState,
  { bg: string; fg: string }
> = {
  open: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  "in-progress": { bg: "var(--warning-dim)", fg: "var(--warning-text)" },
  done: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  cancelled: { bg: "var(--bg-input)", fg: "var(--text-muted)" },
};

/**
 * Legal next-state actions per current state — mirrors the api-server
 * transition table in `responseTasks.logic.ts`. The backend is the
 * authority (an illegal transition 409s); this map just keeps the UI
 * from offering buttons that would always fail.
 */
const NEXT_ACTIONS: Record<
  ResponseTaskState,
  ReadonlyArray<{ to: ResponseTaskState; label: string }>
> = {
  open: [
    { to: "in-progress", label: "Start" },
    { to: "done", label: "Complete" },
    { to: "cancelled", label: "Cancel" },
  ],
  "in-progress": [
    { to: "done", label: "Complete" },
    { to: "open", label: "Move to open" },
    { to: "cancelled", label: "Cancel" },
  ],
  done: [{ to: "in-progress", label: "Reopen" }],
  cancelled: [{ to: "open", label: "Reopen" }],
};

function ResponseTaskStateBadge({ state }: { state: ResponseTaskState }) {
  const label = RESPONSE_TASK_STATE_LABELS[state] ?? state;
  const palette =
    RESPONSE_TASK_STATE_COLORS[state] ?? RESPONSE_TASK_STATE_COLORS.open;
  return (
    <span
      data-testid={`response-task-state-badge-${state}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  );
}

function formatResponseTaskError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "That state change isn't allowed from the task's current state. Refresh and try again.";
    }
    if (err.status === 404) {
      return "This response task no longer exists. Refresh the list.";
    }
    if (err.status === 400) {
      return "The request was rejected as invalid — check the fields and retry.";
    }
    if (err.status >= 500) {
      return "The server hit a snag. Try again in a moment.";
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong — please try again.";
}

/* -------------------------------------------------------------------------- */
/*                          Create-task dialog                                */
/* -------------------------------------------------------------------------- */

function CreateResponseTaskDialog({
  engagementId,
  isOpen,
  onClose,
}: {
  engagementId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [sourceClientCommentId, setSourceClientCommentId] = useState("");
  const [findingId, setFindingId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle("");
      setDescription("");
      setDueAt("");
      setSourceClientCommentId("");
      setFindingId("");
      setError(null);
    }
  }, [isOpen]);

  const mutation = useCreateResponseTask({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({
          queryKey: getListResponseTasksQueryKey(engagementId),
        });
        onClose();
      },
      onError: (err: unknown) => setError(formatResponseTaskError(err)),
    },
  });

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || mutation.isPending) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose, mutation.isPending]);

  if (!isOpen) return null;

  const submitting = mutation.isPending;
  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    mutation.mutate({
      engagementId,
      data: {
        title: trimmedTitle,
        description: description.trim(),
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        ...(sourceClientCommentId.trim()
          ? { sourceClientCommentId: sourceClientCommentId.trim() }
          : {}),
        ...(findingId.trim() ? { findingId: findingId.trim() } : {}),
      },
    });
  };

  return (
    <div
      onClick={() => {
        if (!submitting) onClose();
      }}
      data-testid="create-response-task-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-response-task-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 520,
          maxHeight: "90vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header">
          <div className="flex flex-col gap-1">
            <span
              id="create-response-task-title"
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              New response task
            </span>
            <span className="sc-meta opacity-70">
              Track a piece of the client-comment response. The task
              persists across sessions; link it to the source comment
              or finding so its provenance is intact.
            </span>
          </div>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12 }}>
          <Field label="Title (required)">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              data-testid="create-response-task-title-input"
              placeholder='e.g. "Resolve egress-width comment on A-101"'
              style={inputStyle}
            />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              rows={3}
              data-testid="create-response-task-description-input"
              className="sc-scroll"
              style={{ ...inputStyle, resize: "vertical", minHeight: 64 }}
            />
          </Field>
          <Field label="Due date (optional)">
            <input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              disabled={submitting}
              data-testid="create-response-task-due-input"
              style={inputStyle}
            />
          </Field>
          <Field label="Source client comment ID (optional)">
            <input
              type="text"
              value={sourceClientCommentId}
              onChange={(e) => setSourceClientCommentId(e.target.value)}
              disabled={submitting}
              data-testid="create-response-task-comment-input"
              placeholder="client-comment atom entityId"
              style={inputStyle}
            />
          </Field>
          <Field label="Finding ID (optional)">
            <input
              type="text"
              value={findingId}
              onChange={(e) => setFindingId(e.target.value)}
              disabled={submitting}
              data-testid="create-response-task-finding-input"
              placeholder="finding entityId"
              style={inputStyle}
            />
          </Field>

          {error && (
            <div
              data-testid="create-response-task-error"
              role="alert"
              className="sc-meta"
              style={{ color: "var(--danger-text)" }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="p-4 flex justify-end gap-2"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="create-response-task-submit"
          >
            {submitting ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  borderRadius: 4,
  outline: "none",
  fontSize: 12.5,
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Single task row                                */
/* -------------------------------------------------------------------------- */

function ResponseTaskRow({
  task,
  engagementId,
}: {
  task: ResponseTaskAtom;
  engagementId: string;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: getListResponseTasksQueryKey(engagementId),
    });

  const stateMutation = useUpdateResponseTaskState({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await invalidate();
      },
      onError: (err: unknown) => setError(formatResponseTaskError(err)),
    },
  });

  const linkMutation = useLinkResponseTaskFinding({
    mutation: {
      onSuccess: async () => {
        setError(null);
        setLinkOpen(false);
        setLinkValue("");
        await invalidate();
      },
      onError: (err: unknown) => setError(formatResponseTaskError(err)),
    },
  });

  const busy = stateMutation.isPending || linkMutation.isPending;
  const state = task.state as ResponseTaskState;
  const isAi = task.actorId === AI_AGENT_ACTOR_ID;
  const palette = ACCENT_BY_STATE[state] ?? ACCENT_BY_STATE.open;
  // AI-drafted tasks ride the cyan accent rather than the state default,
  // mirroring the violet AI card in the Activity Stream mockup.
  const accent = isAi ? "var(--cyan)" : palette.accent;
  const iconBg = isAi ? "var(--cyan-accent-bg)" : palette.iconBg;
  const iconFg = isAi ? "var(--cyan-text)" : palette.iconFg;
  const Icon = isAi ? Sparkles : palette.Icon;

  return (
    <article
      data-testid={`response-task-row-${task.entityId}`}
      style={{
        position: "relative",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: 8,
        padding: 14,
        paddingLeft: 18,
        overflow: "hidden",
        display: "flex",
        gap: 14,
        boxShadow: "var(--depth-inset), var(--depth-shadow-md)",
      }}
    >
      {/* Left accent bar */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: accent,
        }}
      />

      {/* Avatar / icon circle */}
      <div
        style={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: 999,
          background: iconBg,
          color: iconFg,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <Icon size={18} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header line: title + AI badge + state badge + timestamp */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span
            className="sc-medium"
            style={{
              color: "var(--text-primary)",
              fontSize: 13,
              fontWeight: 600,
              flex: 1,
              minWidth: 0,
              wordBreak: "break-word",
            }}
          >
            {task.title}
          </span>
          {isAi && (
            <span
              data-testid={`response-task-ai-badge-${task.entityId}`}
              title="Drafted by the Cortex in-app agent — review before relying on it"
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 7px",
                borderRadius: 999,
                background: "var(--cyan-accent-bg)",
                color: "var(--cyan)",
                border: "1px solid var(--cyan)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.3,
                textTransform: "uppercase",
                lineHeight: 1.4,
                flexShrink: 0,
              }}
            >
              AI-drafted
            </span>
          )}
          <ResponseTaskStateBadge state={state} />
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
            title={new Date(task.createdAt).toLocaleString()}
          >
            {relativeTime(task.createdAt)}
          </span>
        </div>

        {/* Description quote-block */}
        {task.description && (
          <div
            style={{
              background: "var(--bg-base)",
              border: "1px solid var(--border-soft)",
              borderRadius: 6,
              padding: "8px 10px",
              marginBottom: 8,
              fontSize: 12,
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              lineHeight: 1.45,
            }}
          >
            “{task.description}”
          </div>
        )}

        {/* Meta chip row */}
        <div
          className="sc-meta"
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          {task.dueAt && (
            <span
              data-testid={`response-task-due-${task.entityId}`}
              title={new Date(task.dueAt).toLocaleString()}
              style={chipStyle}
            >
              <Clock size={10} aria-hidden="true" />
              Due {relativeTime(task.dueAt)}
            </span>
          )}
          {task.completedAt && (
            <span
              title={new Date(task.completedAt).toLocaleString()}
              style={chipStyle}
            >
              <CheckCircle2 size={10} aria-hidden="true" />
              Completed {relativeTime(task.completedAt)}
            </span>
          )}
          <span
            data-testid={`response-task-finding-${task.entityId}`}
            style={chipStyle}
          >
            <AtSign size={10} aria-hidden="true" />
            {task.findingId ? `Finding: ${task.findingId}` : "No finding linked"}
          </span>
        </div>

        {/* Action bar */}
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {NEXT_ACTIONS[state].map((action, idx) => (
            <button
              key={action.to}
              type="button"
              className={idx === 0 ? "sc-btn-primary sc-btn-sm" : "sc-btn-ghost sc-btn-sm"}
              disabled={busy}
              data-testid={`response-task-${task.entityId}-to-${action.to}`}
              onClick={() =>
                stateMutation.mutate({
                  responseTaskId: task.entityId,
                  data: { state: action.to },
                })
              }
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm"
            disabled={busy}
            data-testid={`response-task-${task.entityId}-link-toggle`}
            onClick={() => {
              setLinkValue(task.findingId ?? "");
              setLinkOpen((v) => !v);
            }}
          >
            {task.findingId ? "Change finding" : "Link finding"}
          </button>
        </div>

        {linkOpen && (
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              marginTop: 8,
            }}
          >
            <input
              type="text"
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              disabled={busy}
              placeholder="finding entityId"
              data-testid={`response-task-${task.entityId}-link-input`}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              className="sc-btn-primary sc-btn-sm"
              disabled={busy || linkValue.trim().length === 0}
              data-testid={`response-task-${task.entityId}-link-save`}
              onClick={() =>
                linkMutation.mutate({
                  responseTaskId: task.entityId,
                  data: { findingId: linkValue.trim() },
                })
              }
            >
              Save
            </button>
          </div>
        )}

        {/* Reply composer affordance for tasks that still need work */}
        {!busy && (state === "open" || state === "in-progress") && (
          <div
            style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid var(--border-soft)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                background: "var(--bg-input)",
                color: "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <User size={11} />
            </div>
            <div
              style={{
                flex: 1,
                background: "var(--bg-base)",
                border: "1px solid var(--border-soft)",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 11.5,
                color: "var(--text-muted)",
              }}
            >
              Reply to this thread…
            </div>
          </div>
        )}

        {error && (
          <div
            data-testid={`response-task-${task.entityId}-error`}
            role="alert"
            className="sc-meta"
            style={{
              color: "var(--danger-text)",
              marginTop: 8,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </article>
  );
}

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 8px",
  borderRadius: 4,
  background: "var(--bg-base)",
  border: "1px solid var(--border-default)",
  color: "var(--text-secondary)",
  fontSize: 11,
};

/* -------------------------------------------------------------------------- */
/*                                 Tab                                        */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

function groupTasksByDay(tasks: ResponseTaskAtom[]) {
  const now = Date.now();
  const today: ResponseTaskAtom[] = [];
  const yesterday: ResponseTaskAtom[] = [];
  const older: ResponseTaskAtom[] = [];
  for (const t of tasks) {
    const ts = new Date(t.createdAt).getTime();
    const ageDays = (now - ts) / DAY_MS;
    if (ageDays < 1) today.push(t);
    else if (ageDays < 2) yesterday.push(t);
    else older.push(t);
  }
  return { today, yesterday, older };
}

function FeedSection({
  label,
  count,
  children,
  dim,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  dim?: boolean;
}) {
  if (count === 0) return null;
  return (
    <section style={{ marginBottom: 20, opacity: dim ? 0.85 : 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <h3
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: dim ? "var(--text-secondary)" : "var(--text-primary)",
            margin: 0,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          {label}
        </h3>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {count}
        </span>
        <div
          style={{ flex: 1, height: 1, background: "var(--border-soft)" }}
          aria-hidden="true"
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
      </div>
    </section>
  );
}

export function ResponseTasksTab({ engagementId }: { engagementId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useListResponseTasks(engagementId, undefined, {
    query: {
      enabled: !!engagementId,
      queryKey: getListResponseTasksQueryKey(engagementId),
    },
  });

  const tasks = useMemo(() => data?.responseTasks ?? [], [data]);
  const grouped = useMemo(() => groupTasksByDay(tasks), [tasks]);
  const unreadCount = useMemo(
    () =>
      tasks.filter((t) => t.state === "open" || t.state === "in-progress")
        .length,
    [tasks],
  );

  return (
    <div className="cockpit-tab" data-testid="response-tasks-tab-shell">
      <TabHeader
        overline="Review · group"
        title="Response tasks"
        subtitle="Track the architect-side response to each finding. The in-app agent can create tasks; you can reverse any agent action from the chat log."
      />
      <div
        className="flex flex-col"
        data-testid="response-tasks-list"
        style={{
          background: "var(--bg-base)",
          border: "1px solid var(--border-default)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {/* Channel header strip */}
        <div
          style={{
            padding: "14px 16px 0",
            background: "var(--bg-chrome)",
            borderBottom: "1px solid var(--border-default)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <Hash
                size={18}
                color="var(--text-muted)"
                aria-hidden="true"
              />
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                Activity
              </span>
              {unreadCount > 0 && (
                <span
                  style={{
                    background: "var(--cyan-accent-bg)",
                    color: "var(--cyan-text)",
                    padding: "1px 8px",
                    borderRadius: 999,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.3,
                    textTransform: "uppercase",
                  }}
                >
                  {unreadCount} need{unreadCount === 1 ? "s" : ""} you
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <button
                type="button"
                disabled
                title="Search the response-task feed (coming soon)"
                aria-label="Search response tasks"
                style={iconBtnStyle}
              >
                <Search size={14} />
              </button>
              <button
                type="button"
                disabled
                title="Feed options (coming soon)"
                aria-label="More options"
                style={iconBtnStyle}
              >
                <MoreHorizontal size={14} />
              </button>
              <button
                type="button"
                className="sc-btn-primary"
                data-testid="response-tasks-new"
                onClick={() => setCreateOpen(true)}
              >
                New response task
              </button>
            </div>
          </div>

          {/* Sub-tab pills (visual only, "Activity" is active) */}
          <div
            style={{ display: "flex", gap: 18, fontSize: 12, fontWeight: 600 }}
          >
            <span
              style={{
                paddingBottom: 8,
                color: "var(--text-primary)",
                borderBottom: "2px solid var(--cyan)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Activity
              <span
                style={{
                  background: "var(--cyan-accent-bg)",
                  color: "var(--cyan-text)",
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {tasks.length}
              </span>
            </span>
            <span
              style={{
                paddingBottom: 8,
                color: "var(--text-muted)",
                opacity: 0.7,
              }}
              title="Inline submissions view coming soon"
            >
              Submissions
            </span>
            <span
              style={{
                paddingBottom: 8,
                color: "var(--text-muted)",
                opacity: 0.7,
              }}
              title="Inline findings view coming soon"
            >
              Findings
            </span>
            <span
              style={{
                paddingBottom: 8,
                color: "var(--text-muted)",
                opacity: 0.7,
              }}
              title="Inline letters view coming soon"
            >
              Letters
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="p-6 text-center" data-testid="response-tasks-loading">
            <div className="sc-body opacity-60">Loading response tasks…</div>
          </div>
        ) : tasks.length === 0 ? (
          <div
            className="p-6 text-center"
            data-testid="response-tasks-empty"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: 40,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                background: "var(--bg-input)",
                color: "var(--text-muted)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MessageSquare size={20} />
            </div>
            <div className="sc-prose opacity-70" style={{ maxWidth: 460 }}>
              No activity yet. Open a thread with{" "}
              <strong>New response task</strong> to start the client-comment
              response trail.
            </div>
          </div>
        ) : (
          <div style={{ padding: 16 }}>
            <FeedSection label="Today" count={grouped.today.length}>
              {grouped.today.map((task) => (
                <ResponseTaskRow
                  key={task.entityId}
                  task={task}
                  engagementId={engagementId}
                />
              ))}
            </FeedSection>
            <FeedSection
              label="Yesterday"
              count={grouped.yesterday.length}
              dim
            >
              {grouped.yesterday.map((task) => (
                <ResponseTaskRow
                  key={task.entityId}
                  task={task}
                  engagementId={engagementId}
                />
              ))}
            </FeedSection>
            <FeedSection label="Older" count={grouped.older.length} dim>
              {grouped.older.map((task) => (
                <ResponseTaskRow
                  key={task.entityId}
                  task={task}
                  engagementId={engagementId}
                />
              ))}
            </FeedSection>
          </div>
        )}
      </div>

      <CreateResponseTaskDialog
        engagementId={engagementId}
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 4,
  background: "transparent",
  border: "1px solid transparent",
  color: "var(--text-secondary)",
  cursor: "not-allowed",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  opacity: 0.7,
};
