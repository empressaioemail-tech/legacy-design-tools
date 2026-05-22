/**
 * Codex Reviewer QA — comment-letter view (CDX-9).
 *
 * The reviewer-side deliverable: a drafted Cortex L3 `deliverable-letter`
 * rendered section by section, each section editable inline, plus the L6
 * render-to-DOCX/PDF + download affordance. Both the draft action
 * (`ReviewPage`) and this view consume the existing L3/L6 endpoints via
 * `@workspace/api-client-react` — no comment-letter backend is built
 * here; CDX-9 reuses the DA-side pipeline (see the CDX-9 dispatch).
 *
 * The structure mirrors the L3 `DeliverableLettersTab` conventions
 * (sectioned editor, per-section provenance, completeness gate, render
 * row) in the codex-reviewer-qa inline-style idiom.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetDeliverableLetterQueryKey,
  getListDeliverableLetterRendersQueryKey,
  useGetDeliverableLetter,
  useListDeliverableLetterRenders,
  useRenderDeliverableLetter,
  useUpsertDeliverableLetterSection,
  type DeliverableLetterRenderAtom,
  type LetterSection,
  type LetterSectionKind,
} from "@workspace/api-client-react";

const SECTION_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "per-comment-response",
  "signature",
];

/** Section kinds a letter must carry to be complete / renderable. */
const REQUIRED_KINDS: ReadonlyArray<LetterSectionKind> = [
  "cover",
  "intro",
  "signature",
];

/** Browser-resolvable download path for a render's bytes (L6 C.4.6). */
function renderFileUrl(renderId: string): string {
  return `/api/deliverable-letter-renders/${renderId}/file`;
}

function describeLetterError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This letter no longer exists.";
    if (err.status === 409) {
      return "The letter is missing required sections — add a cover, intro, and signature.";
    }
    if (err.status === 400) return "The request was rejected as invalid.";
    if (err.status >= 500) return "The server hit a snag. Try again.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong — please try again.";
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-input, var(--bg-elevated))",
  color: "var(--text-primary)",
  fontSize: 13,
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

/* -------------------------------------------------------------------------- */
/*                              Section editor                                */
/* -------------------------------------------------------------------------- */

function SectionEditor({
  letterId,
  section,
  index,
  readOnly,
}: {
  letterId: string;
  section: LetterSection;
  index: number;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<LetterSectionKind>(section.kind);
  const [heading, setHeading] = useState(section.heading);
  const [content, setContent] = useState(section.content);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local edit state when the underlying letter refetches.
  useEffect(() => {
    setKind(section.kind);
    setHeading(section.heading);
    setContent(section.content);
  }, [section.kind, section.heading, section.content]);

  const save = useUpsertDeliverableLetterSection({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await queryClient.invalidateQueries({
          queryKey: getGetDeliverableLetterQueryKey(letterId),
        });
      },
      onError: (err: unknown) => setError(describeLetterError(err)),
    },
  });

  const dirty =
    kind !== section.kind ||
    heading !== section.heading ||
    content !== section.content;

  // Per-section provenance — the atoms that fed this section. The Codex
  // adjudication is finding-intrinsic, so `findingIds` carries the
  // adjudicated finding atom(s); `adjudicationStateIds` has no Codex
  // referent (divergence flagged in the CDX-9 _inbox report).
  const prov = section.provenance;
  const provEntries: Array<[string, ReadonlyArray<string>]> = [
    ["Findings", prov.findingIds],
    ["Response tasks", prov.responseTaskIds],
    ["Sheet extractions", prov.sheetContentExtractionIds],
    ["Adjudications", prov.adjudicationStateIds],
  ];
  const hasProvenance = provEntries.some(([, ids]) => ids.length > 0);

  return (
    <article
      data-testid={`letter-section-${index}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 14,
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
        background: "var(--surface-2, var(--bg-elevated))",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={labelStyle}>Section {index + 1}</span>
        <select
          value={kind}
          disabled={readOnly || save.isPending}
          data-testid={`letter-section-${index}-kind`}
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
        disabled={readOnly || save.isPending}
        placeholder="Section heading"
        data-testid={`letter-section-${index}-heading`}
        onChange={(e) => setHeading(e.target.value)}
        style={inputStyle}
      />
      <textarea
        value={content}
        disabled={readOnly || save.isPending}
        rows={6}
        placeholder="Section content"
        data-testid={`letter-section-${index}-content`}
        onChange={(e) => setContent(e.target.value)}
        style={{ ...inputStyle, resize: "vertical", minHeight: 96 }}
      />

      <div
        data-testid={`letter-section-${index}-provenance`}
        style={{ display: "flex", flexDirection: "column", gap: 2 }}
      >
        <span style={labelStyle}>Sources</span>
        {hasProvenance ? (
          provEntries
            .filter(([, ids]) => ids.length > 0)
            .map(([label, ids]) => (
              <span
                key={label}
                style={{ fontSize: 11, color: "var(--text-secondary)" }}
              >
                {label}: {ids.join(", ")}
              </span>
            ))
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            No source atoms recorded for this section.
          </span>
        )}
      </div>

      {!readOnly ? (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            data-testid={`letter-section-${index}-save`}
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate({
                letterId,
                data: { sectionIndex: index, kind, heading, content },
              })
            }
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: "1px solid var(--border-subtle)",
              background: "var(--accent, var(--info-text))",
              color: "var(--accent-contrast, #fff)",
              fontSize: 12,
              fontWeight: 600,
              cursor: !dirty || save.isPending ? "not-allowed" : "pointer",
              opacity: !dirty || save.isPending ? 0.5 : 1,
            }}
          >
            {save.isPending ? "Saving…" : "Save section"}
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          data-testid={`letter-section-${index}-error`}
          style={{
            fontSize: 12,
            padding: "6px 8px",
            borderRadius: 4,
            background: "var(--danger-dim)",
            color: "var(--danger-text)",
          }}
        >
          {error}
        </div>
      ) : null}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Render panel (L6 — C.4.6)                          */
/* -------------------------------------------------------------------------- */

function RenderPanel({
  letterId,
  complete,
}: {
  letterId: string;
  complete: boolean;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const rendersQuery = useListDeliverableLetterRenders(letterId, {
    query: {
      enabled: letterId !== "",
      queryKey: getListDeliverableLetterRendersQueryKey(letterId),
    },
  });
  const renders: DeliverableLetterRenderAtom[] =
    rendersQuery.data?.renders ?? [];

  const render = useRenderDeliverableLetter({
    mutation: {
      onSuccess: async () => {
        setError(null);
        await queryClient.invalidateQueries({
          queryKey: getListDeliverableLetterRendersQueryKey(letterId),
        });
      },
      onError: (err: unknown) => setError(describeLetterError(err)),
    },
  });

  const busy = render.isPending;

  return (
    <section
      data-testid="letter-renders"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: 16,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ ...labelStyle, flex: 1 }}>Renders</span>
        <button
          type="button"
          data-testid="letter-render-docx"
          disabled={busy || !complete}
          onClick={() => {
            setError(null);
            render.mutate({ letterId, data: { format: "docx" } });
          }}
          style={renderButtonStyle(busy || !complete)}
        >
          Render DOCX
        </button>
        <button
          type="button"
          data-testid="letter-render-pdf"
          disabled={busy || !complete}
          onClick={() => {
            setError(null);
            render.mutate({ letterId, data: { format: "pdf" } });
          }}
          style={renderButtonStyle(busy || !complete)}
        >
          Render PDF
        </button>
      </div>

      {!complete ? (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Add the required sections (cover, intro, signature) to enable
          rendering.
        </span>
      ) : null}

      {renders.length === 0 ? (
        <span
          data-testid="letter-renders-empty"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          No renders yet.
        </span>
      ) : (
        renders.map((r) => (
          <div
            key={r.entityId}
            data-testid={`letter-render-row-${r.entityId}`}
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <div
              style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
            >
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "var(--info-dim)",
                  color: "var(--info-text)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  fontSize: 10,
                }}
              >
                {r.format}
              </span>
              <span style={{ color: "var(--text-secondary)", flex: 1 }}>
                Rendered {new Date(r.renderedAt).toLocaleString()}
              </span>
              {r.format === "pdf" ? (
                <button
                  type="button"
                  data-testid={`letter-render-${r.entityId}-preview`}
                  onClick={() =>
                    setPreviewId((id) => (id === r.entityId ? null : r.entityId))
                  }
                  style={renderButtonStyle(false)}
                >
                  {previewId === r.entityId ? "Hide preview" : "Preview"}
                </button>
              ) : null}
              <a
                href={renderFileUrl(r.entityId)}
                download
                data-testid={`letter-render-${r.entityId}-download`}
                style={{
                  ...renderButtonStyle(false),
                  textDecoration: "none",
                  display: "inline-block",
                }}
              >
                Download
              </a>
            </div>
            {previewId === r.entityId && r.format === "pdf" ? (
              <iframe
                title={`render-preview-${r.entityId}`}
                data-testid={`letter-render-${r.entityId}-preview-frame`}
                src={renderFileUrl(r.entityId)}
                style={{
                  width: "100%",
                  height: 360,
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 4,
                }}
              />
            ) : null}
          </div>
        ))
      )}

      {error ? (
        <div
          role="alert"
          data-testid="letter-renders-error"
          style={{
            fontSize: 12,
            padding: "6px 8px",
            borderRadius: 4,
            background: "var(--danger-dim)",
            color: "var(--danger-text)",
          }}
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}

function renderButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid var(--border-subtle)",
    background: "transparent",
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Page                                      */
/* -------------------------------------------------------------------------- */

export default function CommentLetterPage({ letterId }: { letterId: string }) {
  const letterQuery = useGetDeliverableLetter(letterId, {
    query: {
      enabled: letterId !== "",
      queryKey: getGetDeliverableLetterQueryKey(letterId),
    },
  });
  const letter = letterQuery.data?.deliverableLetter ?? null;

  const presentKinds = new Set((letter?.sections ?? []).map((s) => s.kind));
  const missing = REQUIRED_KINDS.filter((k) => !presentKinds.has(k));
  const complete = letter !== null && missing.length === 0;
  const readOnly = letter?.status === "sent";

  return (
    <main
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <Link
        href="/"
        data-testid="letter-back-link"
        style={{ fontSize: 12, color: "var(--text-secondary)" }}
      >
        ← Back to review
      </Link>

      {letterQuery.isLoading ? (
        <Placeholder text="Loading the comment letter…" />
      ) : letterQuery.isError || letter === null ? (
        <Placeholder
          text="This comment letter could not be loaded. It may not exist."
          tone="danger"
        />
      ) : (
        <>
          <header
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <h1
              data-testid="letter-title"
              style={{ fontSize: 22, margin: 0, flex: 1 }}
            >
              {letter.title}
            </h1>
            <span
              data-testid="letter-status"
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                padding: "3px 10px",
                borderRadius: 999,
                background:
                  letter.status === "sent"
                    ? "var(--success-dim, var(--info-dim))"
                    : "var(--info-dim)",
                color:
                  letter.status === "sent"
                    ? "var(--success-text, var(--info-text))"
                    : "var(--info-text)",
              }}
            >
              {letter.status}
            </span>
          </header>

          <div
            data-testid="letter-completeness"
            role="status"
            style={{
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 6,
              background: complete ? "var(--info-dim)" : "var(--warning-dim)",
              color: complete ? "var(--info-text)" : "var(--warning-text)",
            }}
          >
            {complete
              ? "Complete — cover, intro, and signature sections are all present."
              : `Incomplete — missing required section${
                  missing.length === 1 ? "" : "s"
                }: ${missing.join(", ")}.`}
          </div>

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {letter.sections.map((section, i) => (
              <SectionEditor
                key={i}
                letterId={letter.entityId}
                section={section}
                index={i}
                readOnly={readOnly}
              />
            ))}
          </section>

          <RenderPanel letterId={letter.entityId} complete={complete} />
        </>
      )}
    </main>
  );
}

function Placeholder({
  text,
  tone = "muted",
}: {
  text: string;
  tone?: "muted" | "danger";
}) {
  return (
    <div
      data-testid="letter-placeholder"
      style={{
        fontSize: 13,
        color: tone === "danger" ? "var(--danger-text)" : "var(--text-muted)",
        padding: 16,
        border: "1px dashed var(--border-subtle)",
        borderRadius: 8,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}
