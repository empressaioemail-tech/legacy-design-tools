import type { EngagementSubmissionSummary } from "@workspace/api-client-react";
import { formatSubmissionPickerLabel } from "./findingGenerationUi";

/**
 * Shared submission picker for Review surfaces (Findings, cross-links).
 */
export function SubmissionSelector({
  submissions,
  value,
  onChange,
  testId = "submission-selector",
  disabled,
  label = "Submission",
}: {
  submissions: EngagementSubmissionSummary[];
  value: string | null;
  onChange: (submissionId: string | null) => void;
  testId?: string;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label
      className="submission-selector-label sc-label"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 9,
        opacity: 0.6,
      }}
    >
      {label.toUpperCase()}
      <select
        data-testid={testId}
        className="sc-select submission-selector"
        value={value ?? ""}
        disabled={disabled || submissions.length === 0}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ flex: 1, fontSize: 12 }}
      >
        {submissions.length === 0 ? (
          <option value="">No submissions</option>
        ) : (
          submissions.map((s) => (
            <option key={s.id} value={s.id}>
              {formatSubmissionPickerLabel(s)}
            </option>
          ))
        )}
      </select>
    </label>
  );
}
