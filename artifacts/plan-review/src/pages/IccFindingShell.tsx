import { useState } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "../components/NavGroups";
import { FindingsTab } from "../components/findings/FindingsTab";
import {
  ICC_SHELL_CHROME,
  ICC_SHELL_EDITION_LABEL,
  type IccFindingShellId,
} from "../lib/iccFindingShellUi";

/**
 * ICC PoC — thin shell over FindingsTab. Chrome differs per shell;
 * finding logic stays in generateFindings via `iccShell` on kickoff.
 */
export function IccFindingShellPage({
  shellId,
}: {
  shellId: IccFindingShellId;
}) {
  const navGroups = useNavGroups();
  const chrome = ICC_SHELL_CHROME[shellId];
  const [submissionId, setSubmissionId] = useState("");
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(
    null,
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );

  return (
    <DashboardLayout
      navGroups={navGroups}
      brandLabel="Plan Review"
      brandProductName="ICC PoC"
    >
      <div
        data-testid={`icc-shell-${shellId}`}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "20px 24px",
          maxWidth: 960,
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h1
            className="sc-card-title"
            style={{ fontSize: 20, margin: 0 }}
            data-testid="icc-shell-title"
          >
            {chrome.pageTitle}
          </h1>
          <p
            className="sc-body opacity-70"
            style={{ margin: 0, fontSize: 13 }}
            data-testid="icc-shell-subtitle"
          >
            {chrome.pageSubtitle}
          </p>
          <p
            className="sc-meta"
            style={{ margin: 0, fontSize: 11, opacity: 0.65 }}
          >
            ICC edition: {ICC_SHELL_EDITION_LABEL[shellId]} · corpus:
            icc-model-code · gate retrieval (platform-internal)
          </p>
        </header>

        {!activeSubmissionId ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = submissionId.trim();
              if (trimmed.length > 0) setActiveSubmissionId(trimmed);
            }}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <label className="sc-label" htmlFor="icc-shell-submission-id">
              Submission ID
            </label>
            <input
              id="icc-shell-submission-id"
              className="sc-input"
              data-testid="icc-shell-submission-input"
              value={submissionId}
              onChange={(e) => setSubmissionId(e.target.value)}
              placeholder="uuid of a submission with plan-set context"
              style={{ minWidth: 280, flex: 1 }}
            />
            <button
              type="submit"
              className="sc-btn-primary"
              data-testid="icc-shell-open"
              disabled={submissionId.trim().length === 0}
            >
              Open findings
            </button>
          </form>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="sc-meta" style={{ fontSize: 11 }}>
                Submission {activeSubmissionId}
              </span>
              <button
                type="button"
                className="sc-btn-ghost"
                data-testid="icc-shell-change-submission"
                onClick={() => {
                  setActiveSubmissionId(null);
                  setSelectedFindingId(null);
                }}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                Change
              </button>
            </div>
            <FindingsTab
              submissionId={activeSubmissionId}
              selectedFindingId={selectedFindingId}
              onSelectFinding={setSelectedFindingId}
              audience="internal"
              iccShell={shellId}
            />
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

export function IccMunicipalShellPage() {
  return <IccFindingShellPage shellId="municipal-ipmc" />;
}

export function IccArchitectShellPage() {
  return <IccFindingShellPage shellId="architect-ibc" />;
}
