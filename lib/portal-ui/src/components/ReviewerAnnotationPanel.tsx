/**
 * ReviewerAnnotationPanel — threaded scratch-note surface for the
 * reviewer-annotation atom (Wave 2 Sprint C / Spec 307).
 *
 * Renders as a side-sheet style modal anchored to a single
 * (submission, targetEntityType, targetEntityId) tuple:
 *
 *   - Lists existing annotations (newest-first), grouped into
 *     top-level threads with their replies indented underneath.
 *   - Each reviewer-only annotation has a "Promote to architect"
 *     button (or a checkbox when `multiPromote` is on, so the
 *     reviewer can flip several at once via the bulk endpoint).
 *   - Promoted annotations are rendered immutable with a "Promoted"
 *     badge and the relative promote timestamp.
 *   - A compose form at the bottom posts top-level annotations.
 *     A single inline reply box opens under whichever annotation the
 *     reviewer hits "Reply" on (single-level threading per the v1
 *     contract).
 *
 * Audience-gated: same `audience === "internal"` guard as the
 * affordance — the route would 403 a non-reviewer call anyway.
 */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateReviewerAnnotation,
  useListReviewerAnnotations,
  usePromoteReviewerAnnotations,
  getListReviewerAnnotationsQueryKey,
  type ReviewerAnnotation,
} from "@workspace/api-client-react";
import { createReviewerAnnotationBodyBodyMax } from "@workspace/api-zod";

const CATEGORIES = ["concern", "question", "note", "requires-followup"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  concern: "Concern",
  question: "Question",
  note: "Note",
  "requires-followup": "Follow-up",
};

const CATEGORY_PALETTE: Record<Category, { bg: string; fg: string }> = {
  concern: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
  question: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  note: { bg: "var(--bg-input)", fg: "var(--text-secondary)" },
  "requires-followup": {
    bg: "var(--warning-dim)",
    fg: "var(--warning-text)",
  },
};

export interface ReviewerAnnotationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  submissionId: string;
  targetEntityType:
    | "submission"
    | "briefing-source"
    | "materializable-element"
    | "briefing-divergence"
    | "sheet"
    | "parcel-briefing";
  targetEntityId: string;
  audience: "internal" | "user" | "ai";
  /**
   * Optional annotation id to scroll into view on open. Used by the
   * URL-hash deep-link handler (`#annotation=<id>`) so a reviewer
   * pasting a link from chat lands on the relevant note.
   */
  highlightAnnotationId?: string | null;
}

/**
 * Format an ISO timestamp as a short "Xm ago" / "2h ago" / "3d ago"
 * relative label. Inlined so portal-ui doesn't have to take a new
 * dep on a date helper just for this surface.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const deltaMs = Date.now() - then;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ReviewerAnnotationPanel({
  isOpen,
  onClose,
  submissionId,
  targetEntityType,
  targetEntityId,
  audience,
  highlightAnnotationId,
}: ReviewerAnnotationPanelProps) {
  const qc = useQueryClient();
  const isReviewer = audience === "internal";
  const enabled = isOpen && isReviewer && !!submissionId && !!targetEntityId;

  const listQueryKey = getListReviewerAnnotationsQueryKey(submissionId, {
    targetEntityType,
    targetEntityId,
  });

  const { data, isLoading } = useListReviewerAnnotations(
    submissionId,
    { targetEntityType, targetEntityId },
    { query: { enabled, queryKey: listQueryKey } },
  );

  const createMutation = useCreateReviewerAnnotation({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: listQueryKey });
      },
    },
  });
  const promoteMutation = usePromoteReviewerAnnotations({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: listQueryKey });
      },
    },
  });

  const [body, setBody] = useState("");
  const [category, setCategory] = useState<Category>("note");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setBody("");
      setReplyTo(null);
      setReplyBody("");
      setError(null);
      setCategory("note");
    }
  }, [isOpen]);

  const annotations: ReviewerAnnotation[] = useMemo(
    () => data?.annotations ?? [],
    [data],
  );

  // Group into top-level threads with their replies in order.
  // Top-level rows arrive newest-first from the server; replies are
  // rendered oldest-first under their parent so the conversation
  // reads top-down inside each thread.
  const threads = useMemo(() => {
    const tops: ReviewerAnnotation[] = annotations.filter(
      (a) => a.parentAnnotationId == null,
    );
    const repliesByParent = new Map<string, ReviewerAnnotation[]>();
    for (const a of annotations) {
      if (a.parentAnnotationId == null) continue;
      const list = repliesByParent.get(a.parentAnnotationId) ?? [];
      list.push(a);
      repliesByParent.set(a.parentAnnotationId, list);
    }
    for (const list of repliesByParent.values()) {
      list.sort(
        (l, r) => new Date(l.createdAt).getTime() - new Date(r.createdAt).getTime(),
      );
    }
    return tops.map((root) => ({
      root,
      replies: repliesByParent.get(root.id) ?? [],
    }));
  }, [annotations]);

  if (!isOpen || !isReviewer) return null;

  const handleCreate = async (parentAnnotationId: string | null) => {
    setError(null);
    const text = (parentAnnotationId ? replyBody : body).trim();
    if (!text) {
      setError("Annotation body cannot be empty.");
      return;
    }
    if (text.length > createReviewerAnnotationBodyBodyMax) {
      setError("Annotation body too long.");
      return;
    }
    try {
      await createMutation.mutateAsync({
        submissionId,
        data: {
          targetEntityType,
          targetEntityId,
          body: text,
          category: parentAnnotationId ? "note" : category,
          parentAnnotationId,
        },
      });
      if (parentAnnotationId) {
        setReplyBody("");
        setReplyTo(null);
      } else {
        setBody("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save annotation.");
    }
  };

  const handlePromote = async (annotationId: string) => {
    setError(null);
    try {
      await promoteMutation.mutateAsync({
        submissionId,
        data: { annotationIds: [annotationId] },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to promote.");
    }
  };

  return (
    <div
      data-testid="reviewer-annotation-panel"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 60,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "flex-end",
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          height: "100%",
          overflow: "auto",
          borderRadius: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header sc-row-sb">
          <div className="flex flex-col gap-1">
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              Reviewer annotations
            </span>
            <span className="sc-meta opacity-70">
              {targetEntityType} · {targetEntityId}
            </span>
          </div>
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onClose}
            data-testid="reviewer-annotation-panel-close"
          >
            Close
          </button>
        </div>

        <div className="p-4 flex flex-col" style={{ gap: 12, flex: 1 }}>
          {isLoading && (
            <div className="sc-meta opacity-70">Loading annotations…</div>
          )}
          {!isLoading && threads.length === 0 && (
            <div
              className="sc-prose opacity-70"
              data-testid="reviewer-annotation-panel-empty"
            >
              No annotations yet — leave the first scratch note below.
            </div>
          )}

          {threads.map((thread) => (
            <AnnotationThread
              key={thread.root.id}
              thread={thread}
              highlight={highlightAnnotationId === thread.root.id}
              replyOpen={replyTo === thread.root.id}
              replyBody={replyBody}
              setReplyBody={setReplyBody}
              onReplyToggle={() =>
                setReplyTo((prev) => (prev === thread.root.id ? null : thread.root.id))
              }
              onReplySubmit={() => handleCreate(thread.root.id)}
              onPromote={handlePromote}
              promoting={promoteMutation.isPending}
              replying={createMutation.isPending}
            />
          ))}
        </div>

        <div
          className="p-4 flex flex-col gap-2"
          style={{
            borderTop: "1px solid var(--border-default)",
            background: "var(--bg-elevated)",
          }}
        >
          <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
            Add annotation
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className="sc-ui"
              data-testid="reviewer-annotation-category-select"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                padding: "4px 6px",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
            <span
              className="sc-meta"
              data-testid="reviewer-annotation-body-count"
              style={{ color: "var(--text-muted)" }}
            >
              {body.length} / {createReviewerAnnotationBodyBodyMax}
            </span>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Scratch note visible only to reviewers until promoted."
            data-testid="reviewer-annotation-body-input"
            className="sc-ui sc-scroll"
            style={{
              width: "100%",
              background: "var(--bg-input)",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
              padding: "8px 10px",
              borderRadius: 4,
              outline: "none",
              fontSize: 12.5,
              resize: "vertical",
              minHeight: 70,
            }}
          />
          {error && (
            <div
              className="sc-meta"
              data-testid="reviewer-annotation-error"
              style={{ color: "#ef4444" }}
            >
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="sc-btn-primary"
              onClick={() => handleCreate(null)}
              disabled={createMutation.isPending || body.trim().length === 0}
              data-testid="reviewer-annotation-submit"
            >
              {createMutation.isPending ? "Saving…" : "Save annotation"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnnotationThread({
  thread,
  highlight,
  replyOpen,
  replyBody,
  setReplyBody,
  onReplyToggle,
  onReplySubmit,
  onPromote,
  promoting,
  replying,
}: {
  thread: { root: ReviewerAnnotation; replies: ReviewerAnnotation[] };
  highlight: boolean;
  replyOpen: boolean;
  replyBody: string;
  setReplyBody: (v: string) => void;
  onReplyToggle: () => void;
  onReplySubmit: () => void;
  onPromote: (id: string) => void;
  promoting: boolean;
  replying: boolean;
}) {
  return (
    <div
      data-testid={`reviewer-annotation-thread-${thread.root.id}`}
      className="sc-card"
      style={{
        border: highlight ? "1px solid var(--info-text)" : undefined,
        padding: 0,
      }}
    >
      <AnnotationRow
        annotation={thread.root}
        depth={0}
        onReplyToggle={onReplyToggle}
        onPromote={onPromote}
        promoting={promoting}
      />
      {thread.replies.map((reply) => (
        <AnnotationRow
          key={reply.id}
          annotation={reply}
          depth={1}
          onReplyToggle={null}
          onPromote={onPromote}
          promoting={promoting}
        />
      ))}
      {replyOpen && (
        <div
          className="p-3 flex flex-col gap-2"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={2}
            placeholder="Reply to this thread."
            data-testid={`reviewer-annotation-reply-input-${thread.root.id}`}
            className="sc-ui sc-scroll"
            style={{
              width: "100%",
              background: "var(--bg-input)",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
              padding: "6px 8px",
              borderRadius: 4,
              fontSize: 12,
              resize: "vertical",
              minHeight: 50,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              className="sc-btn-ghost"
              onClick={onReplyToggle}
            >
              Cancel
            </button>
            <button
              type="button"
              className="sc-btn-primary"
              onClick={onReplySubmit}
              disabled={replying || replyBody.trim().length === 0}
              data-testid={`reviewer-annotation-reply-submit-${thread.root.id}`}
            >
              {replying ? "Saving…" : "Reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AnnotationRow({
  annotation,
  depth,
  onReplyToggle,
  onPromote,
  promoting,
}: {
  annotation: ReviewerAnnotation;
  depth: number;
  onReplyToggle: (() => void) | null;
  onPromote: (id: string) => void;
  promoting: boolean;
}) {
  const palette =
    CATEGORY_PALETTE[annotation.category as Category] ?? CATEGORY_PALETTE.note;
  const promoted = annotation.promotedAt != null;
  return (
    <div
      data-testid={`reviewer-annotation-row-${annotation.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        marginLeft: depth * 16,
        borderTop: depth > 0 ? "1px solid var(--border-default)" : undefined,
      }}
    >
      <div
        className="sc-row-sb"
        style={{ display: "flex", alignItems: "center", gap: 8 }}
      >
        <span
          style={{
            display: "inline-flex",
            padding: "1px 6px",
            borderRadius: 999,
            background: palette.bg,
            color: palette.fg,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.2,
          }}
        >
          {CATEGORY_LABELS[annotation.category as Category] ?? annotation.category}
        </span>
        <span
          className="sc-meta"
          style={{ color: "var(--text-secondary)", fontSize: 11 }}
          title={new Date(annotation.createdAt).toLocaleString()}
        >
          {annotation.reviewerId} · {relativeTime(annotation.createdAt)}
        </span>
      </div>
      <div
        className="sc-body"
        style={{
          color: "var(--text-primary)",
          fontSize: 12.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {annotation.body}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 2,
        }}
      >
        {promoted ? (
          <span
            data-testid={`reviewer-annotation-row-${annotation.id}-promoted`}
            className="sc-meta"
            style={{
              color: "var(--success-text)",
              fontWeight: 600,
              fontSize: 11,
            }}
          >
            Promoted{" "}
            {annotation.promotedAt
              ? relativeTime(annotation.promotedAt)
              : ""}
          </span>
        ) : (
          <>
            {onReplyToggle && (
              <button
                type="button"
                className="sc-btn-ghost"
                onClick={onReplyToggle}
                style={{ fontSize: 11, padding: "2px 6px" }}
                data-testid={`reviewer-annotation-row-${annotation.id}-reply`}
              >
                Reply
              </button>
            )}
            <button
              type="button"
              className="sc-btn-ghost"
              onClick={() => onPromote(annotation.id)}
              disabled={promoting}
              style={{ fontSize: 11, padding: "2px 6px" }}
              data-testid={`reviewer-annotation-row-${annotation.id}-promote`}
            >
              {promoting ? "Promoting…" : "Promote to architect"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
