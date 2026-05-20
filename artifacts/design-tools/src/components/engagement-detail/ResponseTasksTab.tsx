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
import { relativeTime } from "../../lib/relativeTime";

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

  return (
    <div
      data-testid={`response-task-row-${task.entityId}`}
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span
          className="sc-medium"
          style={{ color: "var(--text-primary)", fontSize: 13, flex: 1 }}
        >
          {task.title}
        </span>
        <ResponseTaskStateBadge state={state} />
      </div>

      {task.description && (
        <div
          className="sc-body"
          style={{
            color: "var(--text-secondary)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {task.description}
        </div>
      )}

      <div
        className="sc-meta"
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          color: "var(--text-secondary)",
          fontSize: 11,
        }}
      >
        <span title={new Date(task.createdAt).toLocaleString()}>
          Opened {relativeTime(task.createdAt)}
        </span>
        {task.dueAt && (
          <span
            data-testid={`response-task-due-${task.entityId}`}
            title={new Date(task.dueAt).toLocaleString()}
          >
            Due {relativeTime(task.dueAt)}
          </span>
        )}
        {task.completedAt && (
          <span title={new Date(task.completedAt).toLocaleString()}>
            Completed {relativeTime(task.completedAt)}
          </span>
        )}
        <span data-testid={`response-task-finding-${task.entityId}`}>
          {task.findingId ? `Finding: ${task.findingId}` : "No finding linked"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {NEXT_ACTIONS[state].map((action) => (
          <button
            key={action.to}
            type="button"
            className="sc-btn-ghost sc-btn-sm"
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
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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

      {error && (
        <div
          data-testid={`response-task-${task.entityId}-error`}
          role="alert"
          className="sc-meta"
          style={{ color: "var(--danger-text)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Tab                                        */
/* -------------------------------------------------------------------------- */

export function ResponseTasksTab({ engagementId }: { engagementId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useListResponseTasks(engagementId, undefined, {
    query: {
      enabled: !!engagementId,
      queryKey: getListResponseTasksQueryKey(engagementId),
    },
  });

  const tasks = useMemo(() => data?.responseTasks ?? [], [data]);

  return (
    <>
      <div className="sc-card flex flex-col" data-testid="response-tasks-list">
        <div className="sc-card-header sc-row-sb">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label">RESPONSE TASKS</span>
            <span className="sc-meta" style={{ opacity: 0.7 }}>
              {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-primary"
            data-testid="response-tasks-new"
            onClick={() => setCreateOpen(true)}
          >
            New response task
          </button>
        </div>

        {isLoading ? (
          <div className="p-6 text-center" data-testid="response-tasks-loading">
            <div className="sc-body opacity-60">Loading response tasks…</div>
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-6 text-center" data-testid="response-tasks-empty">
            <div className="sc-prose opacity-70" style={{ maxWidth: 460 }}>
              No response tasks yet. Open one with{" "}
              <strong>New response task</strong> to track a piece of the
              client-comment response.
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {tasks.map((task) => (
              <ResponseTaskRow
                key={task.entityId}
                task={task}
                engagementId={engagementId}
              />
            ))}
          </div>
        )}
      </div>

      <CreateResponseTaskDialog
        engagementId={engagementId}
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
