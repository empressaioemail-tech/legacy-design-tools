/**
 * ReclassifySubmissionDialog — UI-4 / Track 1.
 *
 * Reviewer surface for correcting a submission's classification atom.
 * Launched from the "Reclassify" button on the SubmissionDetailModal
 * action header. Two-step flow:
 *
 *   1. Form — edit the project type, plan-review disciplines, and
 *      applicable code-book labels. Pre-filled from the submission's
 *      current classification when one is supplied (see
 *      `currentClassification`).
 *   2. Confirmation — a read-only summary of the change (before →
 *      after when a prior classification exists) so the reviewer
 *      commits deliberately. Submitting POSTs to
 *      `/api/submissions/:id/reclassify`, which overwrites the live
 *      classification atom (`source: "reviewer"`) and appends a
 *      `submission.reclassified` event to the atom's history chain
 *      for the audit trail.
 *
 * Reviewer-only — the parent (`SubmissionDetailModal`) only mounts
 * this dialog for `audience === "internal"`, and the reclassify
 * route is guarded by the same audience check server-side.
 *
 * `confidence` is sent as `1` — a reviewer-set classification is, by
 * construction, certain (see the `SubmissionClassification` schema
 * doc) — so the form stays focused on the three fields a reviewer
 * actually corrects. `note` is part of the wire contract but the
 * reclassify route does not consume it today, so no note field is
 * surfaced: a free-text box that silently dropped its content would
 * mislead the reviewer.
 *
 * Modal chrome uses the shared shadcn Dialog primitive, matching
 * `DecideModal` (the sibling reviewer surface on the same action
 * header).
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  useReclassifySubmission,
  getListReviewerQueueQueryKey,
  ApiError,
  type PlanReviewDiscipline,
  type SubmissionClassification,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * The 7-value `PlanReviewDiscipline` vocabulary, paired with
 * human-readable labels for the form checkboxes. Order mirrors the
 * `PLAN_REVIEW_DISCIPLINE_VALUES` tuple so the picker reads the same
 * as every other discipline surface.
 */
const DISCIPLINE_OPTIONS: ReadonlyArray<{
  value: PlanReviewDiscipline;
  label: string;
}> = [
  { value: "building", label: "Building" },
  { value: "electrical", label: "Electrical" },
  { value: "mechanical", label: "Mechanical" },
  { value: "plumbing", label: "Plumbing" },
  { value: "residential", label: "Residential" },
  { value: "fire-life-safety", label: "Fire & Life Safety" },
  { value: "accessibility", label: "Accessibility" },
];

export interface ReclassifySubmissionDialogProps {
  submissionId: string;
  /**
   * The submission's current classification atom, used to pre-fill
   * the form. Null when the caller has no classification on hand —
   * the AI auto-classifier has not run, the submission predates the
   * feature, or (as at the SubmissionDetailModal call site today)
   * the classification is simply not loaded into that view. The
   * form starts blank in that case and the reviewer enters the
   * classification from scratch.
   */
  currentClassification?: SubmissionClassification | null;
  open: boolean;
  onClose: () => void;
}

type Step = "form" | "confirm";

export function ReclassifySubmissionDialog({
  submissionId,
  currentClassification = null,
  open,
  onClose,
}: ReclassifySubmissionDialogProps) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("form");
  const [projectType, setProjectType] = useState("");
  const [disciplines, setDisciplines] = useState<PlanReviewDiscipline[]>([]);
  const [codeBooks, setCodeBooks] = useState<string[]>([]);
  const [codeBookDraft, setCodeBookDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Keep the latest classification reachable from the open-effect
  // without listing it as a dependency — pre-fill is a deliberate
  // open-transition snapshot, and re-running it on every prop
  // identity change would clobber the reviewer's in-progress edits.
  const classificationRef = useRef(currentClassification);
  classificationRef.current = currentClassification;

  // Reset + pre-fill whenever the dialog opens so a re-open always
  // reflects the latest classification and never leaks state from a
  // prior submission or an abandoned edit.
  useEffect(() => {
    if (!open) return;
    const current = classificationRef.current;
    setStep("form");
    setProjectType(current?.projectType ?? "");
    setDisciplines(current ? [...current.disciplines] : []);
    setCodeBooks(current ? [...current.applicableCodeBooks] : []);
    setCodeBookDraft("");
    setError(null);
  }, [open]);

  const mutation = useReclassifySubmission({
    mutation: {
      onSuccess: async () => {
        // The classification drives the Inbox triage-strip chips
        // (`GET /reviewer/queue`); invalidate every cached queue
        // variant so the chips reflect the correction without a
        // manual refresh.
        await queryClient.invalidateQueries({
          queryKey: getListReviewerQueueQueryKey(),
        });
        onClose();
      },
      onError: (err: unknown) => {
        setError(formatReclassifyError(err));
      },
    },
  });

  const trimmedProjectType = projectType.trim();
  const projectTypeValid = trimmedProjectType.length > 0;
  const submitting = mutation.isPending;

  const toggleDiscipline = (value: PlanReviewDiscipline) => {
    setDisciplines((prev) =>
      prev.includes(value)
        ? prev.filter((d) => d !== value)
        : [...prev, value],
    );
  };

  const addCodeBook = () => {
    const trimmed = codeBookDraft.trim();
    if (!trimmed) return;
    setCodeBooks((prev) =>
      prev.some((b) => b.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    setCodeBookDraft("");
  };

  const removeCodeBook = (book: string) => {
    setCodeBooks((prev) => prev.filter((b) => b !== book));
  };

  const handleReview = () => {
    if (!projectTypeValid) return;
    setError(null);
    setStep("confirm");
  };

  const handleConfirm = () => {
    setError(null);
    mutation.mutate({
      submissionId,
      data: {
        projectType: trimmedProjectType,
        disciplines,
        applicableCodeBooks: codeBooks,
        // A reviewer-set classification is certain by construction
        // (see the SubmissionClassification schema doc) — send 1.0
        // so the stored atom carries full confidence.
        confidence: 1,
      },
    });
  };

  const requestClose = () => {
    // Block close mid-flight so a reviewer can't lose an in-progress
    // write to a stray backdrop click / Escape.
    if (submitting) return;
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogContent data-testid="reclassify-dialog" className="max-w-lg">
        <DialogHeader>
          <DialogTitle data-testid="reclassify-dialog-title">
            {step === "form" ? "Reclassify submission" : "Confirm reclassification"}
          </DialogTitle>
          <DialogDescription data-testid="reclassify-dialog-subtitle">
            {step === "form"
              ? "Correct the project type, plan-review disciplines, and applicable code books for this submission. The change is recorded on the classification audit trail."
              : "Review the corrected classification below. Confirming overwrites the submission's classification atom and appends a reclassification event to its history."}
          </DialogDescription>
        </DialogHeader>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "8px 0",
          }}
        >
          {step === "form" ? (
            <ReclassifyForm
              projectType={projectType}
              onProjectTypeChange={setProjectType}
              disciplines={disciplines}
              onToggleDiscipline={toggleDiscipline}
              codeBooks={codeBooks}
              codeBookDraft={codeBookDraft}
              onCodeBookDraftChange={setCodeBookDraft}
              onAddCodeBook={addCodeBook}
              onRemoveCodeBook={removeCodeBook}
            />
          ) : (
            <ReclassifySummary
              previous={currentClassification}
              projectType={trimmedProjectType}
              disciplines={disciplines}
              codeBooks={codeBooks}
            />
          )}

          {error && (
            <div
              data-testid="reclassify-dialog-error"
              role="alert"
              style={{ color: "var(--danger-text)", fontSize: 12 }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            {step === "form" ? (
              <>
                <button
                  type="button"
                  data-testid="reclassify-dialog-cancel"
                  className="sc-btn-secondary"
                  onClick={requestClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="reclassify-dialog-review"
                  className="sc-btn-primary"
                  onClick={handleReview}
                  disabled={!projectTypeValid}
                  title={
                    projectTypeValid
                      ? "Review the change before saving"
                      : "Enter a project type to continue"
                  }
                >
                  Review change
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="reclassify-dialog-back"
                  className="sc-btn-secondary"
                  onClick={() => {
                    setError(null);
                    setStep("form");
                  }}
                  disabled={submitting}
                >
                  Back
                </button>
                <button
                  type="button"
                  data-testid="reclassify-dialog-confirm"
                  className="sc-btn-primary"
                  onClick={handleConfirm}
                  disabled={submitting}
                >
                  {submitting ? "Saving…" : "Confirm reclassification"}
                </button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Step 1 — form                                 */
/* -------------------------------------------------------------------------- */

function ReclassifyForm({
  projectType,
  onProjectTypeChange,
  disciplines,
  onToggleDiscipline,
  codeBooks,
  codeBookDraft,
  onCodeBookDraftChange,
  onAddCodeBook,
  onRemoveCodeBook,
}: {
  projectType: string;
  onProjectTypeChange: (value: string) => void;
  disciplines: PlanReviewDiscipline[];
  onToggleDiscipline: (value: PlanReviewDiscipline) => void;
  codeBooks: string[];
  codeBookDraft: string;
  onCodeBookDraftChange: (value: string) => void;
  onAddCodeBook: () => void;
  onRemoveCodeBook: (book: string) => void;
}) {
  return (
    <>
      {/* Project type */}
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sc-label">Project type</span>
        <input
          type="text"
          data-testid="reclassify-dialog-project-type"
          value={projectType}
          onChange={(e) => onProjectTypeChange(e.target.value)}
          maxLength={200}
          placeholder='e.g. "Mixed-use retail"'
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            fontFamily: "inherit",
            fontSize: 13,
            background: "var(--surface-default)",
            color: "var(--text-primary)",
          }}
        />
      </label>

      {/* Disciplines */}
      <fieldset
        data-testid="reclassify-dialog-disciplines"
        style={{
          border: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <legend className="sc-label">Plan-review disciplines</legend>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
          }}
        >
          {DISCIPLINE_OPTIONS.map((opt) => {
            const checked = disciplines.includes(opt.value);
            return (
              <label
                key={opt.value}
                data-testid={`reclassify-dialog-discipline-${opt.value}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: checked
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border-default)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  data-testid={`reclassify-dialog-discipline-${opt.value}-input`}
                  checked={checked}
                  onChange={() => onToggleDiscipline(opt.value)}
                />
                <span className="sc-medium">{opt.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Applicable code books */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="sc-label">Applicable code books</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            data-testid="reclassify-dialog-codebook-input"
            value={codeBookDraft}
            onChange={(e) => onCodeBookDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onAddCodeBook();
              }
            }}
            maxLength={120}
            placeholder='e.g. "IBC 2021"'
            style={{
              flex: 1,
              padding: 8,
              border: "1px solid var(--border-default)",
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 13,
              background: "var(--surface-default)",
              color: "var(--text-primary)",
            }}
          />
          <button
            type="button"
            data-testid="reclassify-dialog-codebook-add"
            className="sc-btn-secondary"
            onClick={onAddCodeBook}
            disabled={codeBookDraft.trim().length === 0}
          >
            Add
          </button>
        </div>
        {codeBooks.length > 0 ? (
          <div
            data-testid="reclassify-dialog-codebook-list"
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}
          >
            {codeBooks.map((book) => (
              <span
                key={book}
                data-testid={`reclassify-dialog-codebook-chip-${book}`}
                className="sc-pill sc-pill-muted"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                {book}
                <button
                  type="button"
                  data-testid={`reclassify-dialog-codebook-remove-${book}`}
                  onClick={() => onRemoveCodeBook(book)}
                  aria-label={`Remove ${book}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                    fontSize: 13,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span
            className="sc-meta"
            style={{ color: "var(--text-muted)", fontSize: 11 }}
          >
            No code books added — display-only labels (e.g. "IBC 2021",
            "NEC 2020").
          </span>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Step 2 — confirmation                             */
/* -------------------------------------------------------------------------- */

function ReclassifySummary({
  previous,
  projectType,
  disciplines,
  codeBooks,
}: {
  previous: SubmissionClassification | null;
  projectType: string;
  disciplines: PlanReviewDiscipline[];
  codeBooks: string[];
}) {
  return (
    <section
      data-testid="reclassify-dialog-summary"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
      }}
    >
      <SummaryRow
        label="Project type"
        testId="reclassify-dialog-summary-project-type"
        next={projectType}
        previous={previous?.projectType ?? null}
      />
      <SummaryRow
        label="Disciplines"
        testId="reclassify-dialog-summary-disciplines"
        next={formatDisciplines(disciplines)}
        previous={
          previous ? formatDisciplines(previous.disciplines) : null
        }
      />
      <SummaryRow
        label="Code books"
        testId="reclassify-dialog-summary-code-books"
        next={formatList(codeBooks)}
        previous={previous ? formatList(previous.applicableCodeBooks) : null}
      />
    </section>
  );
}

function SummaryRow({
  label,
  testId,
  next,
  previous,
}: {
  label: string;
  testId: string;
  next: string;
  previous: string | null;
}) {
  // Only surface the "was" line when a prior classification exists
  // AND the value actually changed — an unchanged field doesn't need
  // before/after noise.
  const changed = previous !== null && previous !== next;
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", flexDirection: "column", gap: 2 }}
    >
      <span
        className="sc-label"
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <span
        className="sc-medium"
        style={{ fontSize: 13, color: "var(--text-primary)" }}
      >
        {next}
      </span>
      {changed && (
        <span
          className="sc-meta"
          data-testid={`${testId}-previous`}
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            textDecoration: "line-through",
          }}
        >
          was {previous}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                helpers                                     */
/* -------------------------------------------------------------------------- */

function formatDisciplines(disciplines: ReadonlyArray<string>): string {
  if (disciplines.length === 0) return "None";
  return disciplines
    .map(
      (d) => DISCIPLINE_OPTIONS.find((o) => o.value === d)?.label ?? d,
    )
    .join(", ");
}

function formatList(items: ReadonlyArray<string>): string {
  return items.length === 0 ? "None" : items.join(", ");
}

function formatReclassifyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return "Reclassifying a submission requires reviewer access.";
    }
    if (err.status === 404) {
      return "This submission no longer exists. Refresh and try again.";
    }
    if (err.status === 400) {
      return (
        extractApiDetail(err) ??
        "The classification was rejected as invalid. Check the fields and try again."
      );
    }
    if (err.status >= 500) {
      return "The server hit a snag saving the classification. Try again in a moment.";
    }
    return extractApiDetail(err) ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to reclassify — please try again.";
}

function extractApiDetail(err: ApiError<unknown>): string | null {
  const data = err.data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["detail", "message", "title", "error"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }
  return null;
}
