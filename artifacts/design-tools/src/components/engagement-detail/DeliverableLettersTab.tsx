import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDeliverableLetters,
  getListDeliverableLettersQueryKey,
  useCreateDeliverableLetter,
  useUpsertDeliverableLetterSection,
  useMergeDeliverableLetterProvenance,
  useSendDeliverableLetter,
  useListDeliverableLetterRenders,
  getListDeliverableLetterRendersQueryKey,
  useRenderDeliverableLetter,
  ApiError,
  type DeliverableLetterAtom,
  type DeliverableLetterRenderAtom,
  type LetterSection,
  type LetterSectionKind,
} from "@workspace/api-client-react";
import { relativeTime } from "../../lib/relativeTime";

/**
 * Cortex L3 (Lane C.4 / C.4.3) — architect-side deliverable-letter
 * surface.
 *
 * The comment-response letter as a classified atom: a sectioned draft
 * editor (cover / intro / per-comment-response / signature), a
 * per-section provenance view back to the L1/L2/finding/adjudication
 * atoms that fed each section, a completeness indicator, and the
 * draft → sent transition. Co-designed with cc-agent-M's
 * `cortex_deliverable_letter_*` MCP tools.
 */

const SECTION_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "per-comment-response",
  "signature",
];

/** Section kinds a letter must carry to be complete / sendable. */
const REQUIRED_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "signature",
];

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

function formatLetterError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "The letter is missing required sections (cover, intro, signature) — add them before sending.";
    }
    if (err.status === 404) return "This letter no longer exists. Refresh.";
    if (err.status === 400) return "The request was rejected as invalid.";
    if (err.status >= 500) return "The server hit a snag. Try again.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong — please try again.";
}

function LetterStatusBadge({ status }: { status: DeliverableLetterAtom["status"] }) {
  const sent = status === "sent";
  return (
    <span
      data-testid={`deliverable-letter-status-${status}`}
      style={{
        display: "inline-flex",
        padding: "2px 8px",
        borderRadius: 999,
        background: sent ? "var(--success-dim)" : "var(--info-dim)",
        color: sent ? "var(--success-text)" : "var(--info-text)",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.2,
      }}
    >
      {sent ? "Sent" : "Draft"}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Create-letter dialog                              */
/* -------------------------------------------------------------------------- */

function CreateLetterDialog({
  engagementId,
  isOpen,
  onClose,
  onCreated,
}: {
  engagementId: string;
  isOpen: boolean;
  onClose: () => void;
  onCreated: (letterId: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle("");
      setError(null);
    }
  }, [isOpen]);

  const mutation = useCreateDeliverableLetter({
    mutation: {
      onSuccess: async (data) => {
        await qc.invalidateQueries({
          queryKey: getListDeliverableLettersQueryKey(engagementId),
        });
        onCreated(data.deliverableLetter.entityId);
        onClose();
      },
      onError: (err: unknown) => setError(formatLetterError(err)),
    },
  });

  if (!isOpen) return null;
  const submitting = mutation.isPending;
  const canSubmit = title.trim().length > 0 && !submitting;

  // Portal to <body>. This dialog is `position: fixed`, but the tab
  // mounts it inside the `deliverable-letters-tab` `.sc-card`, and
  // `.sc-card:hover` applies a `transform` — a transformed ancestor
  // becomes the containing block for fixed descendants, so without the
  // portal the modal would jump to cover only the card box and get
  // clipped by the card's `overflow: hidden` (QA-11 / WSB.4).
  return createPortal(
    <div
      onClick={() => !submitting && onClose()}
      data-testid="create-deliverable-letter-dialog"
      role="dialog"
      aria-modal="true"
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
        style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column" }}
      >
        <div className="sc-card-header">
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
            New deliverable letter
          </span>
        </div>
        <div className="p-4 flex flex-col" style={{ gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
              Letter title (required)
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              data-testid="create-deliverable-letter-title"
              placeholder='e.g. "Response to plan-review comments — Round 2"'
              style={inputStyle}
            />
          </label>
          {error && (
            <div
              data-testid="create-deliverable-letter-error"
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
            disabled={!canSubmit}
            data-testid="create-deliverable-letter-submit"
            onClick={() => {
              setError(null);
              mutation.mutate({
                engagementId,
                data: { title: title.trim() },
              });
            }}
          >
            {submitting ? "Creating…" : "Create letter"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */
/*                            Section card                                    */
/* -------------------------------------------------------------------------- */

function SectionCard({
  engagementId,
  letterId,
  section,
  index,
  readOnly,
}: {
  engagementId: string;
  letterId: string;
  section: LetterSection;
  index: number;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<LetterSectionKind>(section.kind);
  const [heading, setHeading] = useState(section.heading);
  const [content, setContent] = useState(section.content);
  const [error, setError] = useState<string | null>(null);
  const [provType, setProvType] = useState<keyof LetterSection["provenance"]>(
    "findingIds",
  );
  const [provId, setProvId] = useState("");

  // Re-sync local edit state when the underlying section changes
  // (e.g. a provenance merge refetched the letter).
  useEffect(() => {
    setKind(section.kind);
    setHeading(section.heading);
    setContent(section.content);
  }, [section.kind, section.heading, section.content]);

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: getListDeliverableLettersQueryKey(engagementId),
    });

  const saveSection = useUpsertDeliverableLetterSection({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await invalidate();
      },
      onError: (err: unknown) => setError(formatLetterError(err)),
    },
  });

  const addProvenance = useMergeDeliverableLetterProvenance({
    mutation: {
      onSuccess: async () => {
        setError(null);
        setProvId("");
        await invalidate();
      },
      onError: (err: unknown) => setError(formatLetterError(err)),
    },
  });

  const busy = saveSection.isPending || addProvenance.isPending;
  const prov = section.provenance;
  const provEntries: Array<[string, ReadonlyArray<string>]> = [
    ["Response tasks", prov.responseTaskIds],
    ["Sheet extractions", prov.sheetContentExtractionIds],
    ["Findings", prov.findingIds],
    ["Adjudications", prov.adjudicationStateIds],
  ];

  return (
    <div
      data-testid={`deliverable-letter-section-${index}`}
      style={{
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="sc-label" style={{ color: "var(--text-muted)" }}>
          SECTION {index + 1}
        </span>
        <select
          value={kind}
          disabled={readOnly || busy}
          data-testid={`deliverable-letter-section-${index}-kind`}
          onChange={(e) => setKind(e.target.value as LetterSectionKind)}
          style={{ ...inputStyle, width: "auto" }}
        >
          {SECTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <input
        type="text"
        value={heading}
        disabled={readOnly || busy}
        placeholder="Section heading"
        data-testid={`deliverable-letter-section-${index}-heading`}
        onChange={(e) => setHeading(e.target.value)}
        style={inputStyle}
      />
      <textarea
        value={content}
        disabled={readOnly || busy}
        rows={4}
        placeholder="Section content"
        data-testid={`deliverable-letter-section-${index}-content`}
        onChange={(e) => setContent(e.target.value)}
        className="sc-scroll"
        style={{ ...inputStyle, resize: "vertical", minHeight: 72 }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sc-label" style={{ color: "var(--text-secondary)" }}>
          PROVENANCE
        </span>
        {provEntries.map(([label, ids]) => (
          <div
            key={label}
            className="sc-meta"
            style={{ fontSize: 11, color: "var(--text-secondary)" }}
          >
            {label}: {ids.length === 0 ? "—" : ids.join(", ")}
          </div>
        ))}
      </div>

      {!readOnly && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select
              value={provType}
              disabled={busy}
              data-testid={`deliverable-letter-section-${index}-prov-type`}
              onChange={(e) =>
                setProvType(
                  e.target.value as keyof LetterSection["provenance"],
                )
              }
              style={{ ...inputStyle, width: "auto" }}
            >
              <option value="responseTaskIds">Response task</option>
              <option value="sheetContentExtractionIds">Sheet extraction</option>
              <option value="findingIds">Finding</option>
              <option value="adjudicationStateIds">Adjudication</option>
            </select>
            <input
              type="text"
              value={provId}
              disabled={busy}
              placeholder="atom entityId"
              data-testid={`deliverable-letter-section-${index}-prov-id`}
              onChange={(e) => setProvId(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 120 }}
            />
            <button
              type="button"
              className="sc-btn-ghost sc-btn-sm"
              disabled={busy || provId.trim().length === 0}
              data-testid={`deliverable-letter-section-${index}-prov-add`}
              onClick={() =>
                addProvenance.mutate({
                  letterId,
                  sectionIndex: index,
                  data: { [provType]: [provId.trim()] },
                })
              }
            >
              Add provenance
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="sc-btn-primary sc-btn-sm"
              disabled={busy}
              data-testid={`deliverable-letter-section-${index}-save`}
              onClick={() =>
                saveSection.mutate({
                  letterId,
                  data: { sectionIndex: index, kind, heading, content },
                })
              }
            >
              Save section
            </button>
          </div>
        </>
      )}

      {error && (
        <div
          data-testid={`deliverable-letter-section-${index}-error`}
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
/*                       Render section (L6 — C.4.6)                           */
/* -------------------------------------------------------------------------- */

/** Browser-resolvable download path for a render's bytes. */
function renderFileUrl(renderId: string): string {
  return `/api/deliverable-letter-renders/${renderId}/file`;
}

function RenderSection({
  letterId,
  complete,
}: {
  letterId: string;
  complete: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data } = useListDeliverableLetterRenders(letterId, {
    query: {
      enabled: !!letterId,
      queryKey: getListDeliverableLetterRendersQueryKey(letterId),
    },
  });
  const renders: DeliverableLetterRenderAtom[] = data?.renders ?? [];

  const render = useRenderDeliverableLetter({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await qc.invalidateQueries({
          queryKey: getListDeliverableLetterRendersQueryKey(letterId),
        });
      },
      onError: (err: unknown) => setError(formatLetterError(err)),
    },
  });

  const busy = render.isPending;

  return (
    <div
      data-testid="deliverable-letter-renders"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderTop: "1px solid var(--border-default)",
        paddingTop: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="sc-label" style={{ color: "var(--text-secondary)", flex: 1 }}>
          RENDERS
        </span>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={busy || !complete}
          data-testid="deliverable-letter-render-docx"
          onClick={() => {
            setError(null);
            render.mutate({ letterId, data: { format: "docx" } });
          }}
        >
          Render DOCX
        </button>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={busy || !complete}
          data-testid="deliverable-letter-render-pdf"
          onClick={() => {
            setError(null);
            render.mutate({ letterId, data: { format: "pdf" } });
          }}
        >
          Render PDF
        </button>
      </div>

      {!complete && (
        <div className="sc-meta" style={{ color: "var(--text-muted)", fontSize: 11 }}>
          Add the required sections to enable rendering.
        </div>
      )}

      {renders.length === 0 ? (
        <div
          className="sc-meta"
          data-testid="deliverable-letter-renders-empty"
          style={{ color: "var(--text-muted)", fontSize: 11 }}
        >
          No renders yet.
        </div>
      ) : (
        renders.map((r) => (
          <div
            key={r.entityId}
            data-testid={`deliverable-letter-render-row-${r.entityId}`}
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                fontSize: 11,
              }}
            >
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "var(--info-dim)",
                  color: "var(--info-text)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                }}
              >
                {r.format}
              </span>
              <span style={{ color: "var(--text-secondary)", flex: 1 }}>
                Rendered {relativeTime(r.renderedAt)}
              </span>
              {r.format === "pdf" && (
                <button
                  type="button"
                  className="sc-btn-ghost sc-btn-sm"
                  data-testid={`deliverable-letter-render-${r.entityId}-preview`}
                  onClick={() =>
                    setPreviewId((id) => (id === r.entityId ? null : r.entityId))
                  }
                >
                  {previewId === r.entityId ? "Hide preview" : "Preview"}
                </button>
              )}
              <a
                href={renderFileUrl(r.entityId)}
                download
                className="sc-btn-ghost sc-btn-sm"
                data-testid={`deliverable-letter-render-${r.entityId}-download`}
              >
                Download
              </a>
            </div>
            {previewId === r.entityId && r.format === "pdf" && (
              <iframe
                title={`render-preview-${r.entityId}`}
                data-testid={`deliverable-letter-render-${r.entityId}-preview-frame`}
                src={renderFileUrl(r.entityId)}
                style={{
                  width: "100%",
                  height: 360,
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                }}
              />
            )}
          </div>
        ))
      )}

      {error && (
        <div
          data-testid="deliverable-letter-renders-error"
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
/*                            Letter detail                                   */
/* -------------------------------------------------------------------------- */

function LetterDetail({
  engagementId,
  letter,
}: {
  engagementId: string;
  letter: DeliverableLetterAtom;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const readOnly = letter.status === "sent";

  const presentKinds = new Set(letter.sections.map((s) => s.kind));
  const missing = REQUIRED_KINDS.filter((k) => !presentKinds.has(k));
  const complete = missing.length === 0;

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: getListDeliverableLettersQueryKey(engagementId),
    });

  const addSection = useUpsertDeliverableLetterSection({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await invalidate();
      },
      onError: (err: unknown) => setError(formatLetterError(err)),
    },
  });

  const send = useSendDeliverableLetter({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await invalidate();
      },
      onError: (err: unknown) => setError(formatLetterError(err)),
    },
  });

  const busy = addSection.isPending || send.isPending;

  return (
    <div
      data-testid="deliverable-letter-detail"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="sc-medium"
          style={{ fontSize: 15, color: "var(--text-primary)", flex: 1 }}
        >
          {letter.title}
        </span>
        <LetterStatusBadge status={letter.status} />
      </div>

      <div
        data-testid="deliverable-letter-completeness"
        className="sc-meta"
        style={{
          padding: "6px 10px",
          borderRadius: 4,
          background: complete ? "var(--success-dim)" : "var(--warning-dim)",
          color: complete ? "var(--success-text)" : "var(--warning-text)",
          fontSize: 12,
        }}
      >
        {complete
          ? "Complete — cover, intro, and signature sections are all present."
          : `Incomplete — missing required section${
              missing.length === 1 ? "" : "s"
            }: ${missing.join(", ")}.`}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {letter.sections.length === 0 && (
          <div className="sc-meta" style={{ color: "var(--text-muted)" }}>
            No sections yet. Add a cover, intro, and signature to make the
            letter sendable.
          </div>
        )}
        {letter.sections.map((section, i) => (
          <SectionCard
            key={i}
            engagementId={engagementId}
            letterId={letter.entityId}
            section={section}
            index={i}
            readOnly={readOnly}
          />
        ))}
      </div>

      {!readOnly && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="sc-btn-ghost"
            disabled={busy}
            data-testid="deliverable-letter-add-section"
            onClick={() =>
              addSection.mutate({
                letterId: letter.entityId,
                data: {
                  sectionIndex: letter.sections.length,
                  kind: "per-comment-response",
                  heading: "",
                  content: "",
                },
              })
            }
          >
            Add section
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            disabled={busy || !complete}
            data-testid="deliverable-letter-send"
            title={
              complete ? undefined : "Add the missing required sections first"
            }
            onClick={() => send.mutate({ letterId: letter.entityId })}
          >
            {send.isPending ? "Sending…" : "Send letter"}
          </button>
        </div>
      )}

      {/* Cortex L6 (C.4.6) — render the letter to DOCX / PDF. */}
      <RenderSection letterId={letter.entityId} complete={complete} />

      {error && (
        <div
          data-testid="deliverable-letter-detail-error"
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

export function DeliverableLettersTab({
  engagementId,
}: {
  engagementId: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = useListDeliverableLetters(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListDeliverableLettersQueryKey(engagementId),
    },
  });

  const letters = useMemo(() => data?.deliverableLetters ?? [], [data]);
  const selected =
    letters.find((l) => l.entityId === selectedId) ?? letters[0] ?? null;

  return (
    <div
      className="sc-card flex flex-col"
      data-testid="deliverable-letters-tab"
    >
      <div className="sc-card-header sc-row-sb">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="sc-label">DELIVERABLE LETTERS</span>
          <span className="sc-meta" style={{ opacity: 0.7 }}>
            {letters.length} {letters.length === 1 ? "letter" : "letters"}
          </span>
        </div>
        <button
          type="button"
          className="sc-btn-primary"
          data-testid="deliverable-letters-new"
          onClick={() => setCreateOpen(true)}
        >
          New letter
        </button>
      </div>

      {isLoading ? (
        <div className="p-6 text-center" data-testid="deliverable-letters-loading">
          <div className="sc-body opacity-60">Loading deliverable letters…</div>
        </div>
      ) : letters.length === 0 ? (
        <div className="p-6 text-center" data-testid="deliverable-letters-empty">
          <div className="sc-prose opacity-70" style={{ maxWidth: 460 }}>
            No deliverable letters yet. Create one to draft the
            comment-response letter section by section.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 0, minHeight: 320 }}>
          <div
            style={{
              width: 220,
              flexShrink: 0,
              borderRight: "1px solid var(--border-default)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {letters.map((l) => {
              const active = l.entityId === selected?.entityId;
              return (
                <button
                  key={l.entityId}
                  type="button"
                  data-testid={`deliverable-letter-row-${l.entityId}`}
                  onClick={() => setSelectedId(l.entityId)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    border: "none",
                    borderBottom: "1px solid var(--border-default)",
                    background: active
                      ? "var(--bg-highlight)"
                      : "transparent",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <span
                    className="sc-medium"
                    style={{ fontSize: 12.5, color: "var(--text-primary)" }}
                  >
                    {l.title}
                  </span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <LetterStatusBadge status={l.status} />
                    <span
                      className="sc-meta"
                      style={{ fontSize: 10, color: "var(--text-muted)" }}
                    >
                      {relativeTime(l.createdAt)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1, padding: 16, minWidth: 0 }}>
            {selected && (
              <LetterDetail engagementId={engagementId} letter={selected} />
            )}
          </div>
        </div>
      )}

      <CreateLetterDialog
        engagementId={engagementId}
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}
