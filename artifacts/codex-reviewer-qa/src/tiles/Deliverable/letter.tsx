import { useEffect, useState, type CSSProperties } from "react";
import { useEngagement } from "@hauska/tile-shell";
import { TileStatusBanner } from "@hauska/tile-shell";
import { TileErrorBoundary } from "@hauska/cortex-tiles";
import {
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
} from "@workspace/api-client-react";
import { letterEligibleFindings } from "../../lib/commentLetter";
import {
  fetchEngagementLetter,
  generateEngagementLetter,
} from "../../lib/planReviewBff";
import {
  usePlanReviewEngagementSubmissions,
  usePlanReviewSubmissionFindings,
} from "../../lib/planReviewBffQueries";

function LetterTileInner() {
  const { engagementId } = useEngagement();
  const [draft, setDraft] = useState("");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  const submissionsQuery = usePlanReviewEngagementSubmissions(engagementId ?? "", {
    query: {
      enabled: Boolean(engagementId),
      queryKey: getListEngagementSubmissionsQueryKey(engagementId ?? ""),
    },
  });
  const latestSubmission = submissionsQuery.data?.[0] ?? null;

  const findingsQuery = usePlanReviewSubmissionFindings(latestSubmission?.id ?? "", {
    query: {
      enabled: Boolean(latestSubmission?.id),
      queryKey: getListSubmissionFindingsQueryKey(latestSubmission?.id ?? ""),
    },
  });
  const findings = findingsQuery.data?.findings ?? [];
  const letterEligible = letterEligibleFindings(findings);

  useEffect(() => {
    if (!engagementId) {
      setDraft("");
      setGeneratedAt(null);
      return;
    }
    let cancelled = false;
    setLoadingDraft(true);
    fetchEngagementLetter(engagementId)
      .then((res) => {
        if (cancelled) return;
        setDraft(res.draft ?? "");
        setGeneratedAt(res.generatedAt);
      })
      .catch(() => {
        if (!cancelled) {
          setDraft("");
          setGeneratedAt(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDraft(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  async function handleGenerate() {
    if (!engagementId) return;
    setError(null);
    setGenerating(true);
    try {
      const res = await generateEngagementLetter(engagementId);
      setDraft(res.draft);
      setGeneratedAt(res.generatedAt);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not generate letter.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 2000);
    } catch {
      setError("Copy failed.");
    }
  }

  function handleDownload() {
    if (!draft) return;
    const blob = new Blob([draft], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "comment-letter.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  const textareaStyle: CSSProperties = {
    flex: 1,
    minHeight: 160,
    padding: 10,
    borderRadius: 6,
    border: "1px solid var(--border-subtle)",
    background: "var(--bg-input, var(--bg-elevated))",
    color: "var(--text-primary)",
    fontSize: 12,
    fontFamily: "inherit",
    resize: "vertical",
  };

  return (
    <div
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        overflow: "auto",
        height: "100%",
      }}
    >
      <TileStatusBanner status="live" label="Deliverable Letter" />
      {!engagementId ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Select a case from Intake & Queue to draft a letter.
        </p>
      ) : loadingDraft ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Loading draft…
        </p>
      ) : draft ? (
        <>
          <textarea
            data-testid="letter-draft-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={textareaStyle}
          />
          {generatedAt ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Generated {new Date(generatedAt).toLocaleString()}
            </span>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              data-testid="letter-regenerate"
              disabled={generating || letterEligible.length === 0}
              onClick={() => void handleGenerate()}
              style={buttonStyle(generating)}
            >
              {generating ? "Generating…" : "Regenerate"}
            </button>
            <button
              type="button"
              data-testid="letter-copy"
              onClick={() => void handleCopy()}
              style={buttonStyle(false)}
            >
              {copyOk ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              data-testid="letter-download"
              onClick={handleDownload}
              style={buttonStyle(false)}
            >
              Download .txt
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            {letterEligible.length} finding{letterEligible.length === 1 ? "" : "s"}{" "}
            ready
          </p>
          <button
            type="button"
            data-testid="draft-comment-letter-button"
            disabled={letterEligible.length === 0 || generating}
            onClick={() => void handleGenerate()}
            style={buttonStyle(generating)}
          >
            {generating ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className="letter-spinner" aria-hidden />
                Generating…
              </span>
            ) : (
              "Draft comment letter"
            )}
          </button>
        </>
      )}
      {error ? (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-text)" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * OPTION 3 (per Track C Phase 3 dispatch): this tile stays app-resident because
 * it depends on @workspace/api-client-react query-key helpers, the app-lib
 * commentLetter (letterEligibleFindings) module, and the app-lib react-query
 * hooks. It is still wrapped in the shared TileErrorBoundary from
 * @hauska/cortex-tiles.
 */
export default function LetterTile() {
  return (
    <TileErrorBoundary label="Deliverable Letter">
      <LetterTileInner />
    </TileErrorBoundary>
  );
}

function buttonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: 6,
    border: "none",
    background: "var(--accent, var(--info-text))",
    color: "var(--accent-contrast, #fff)",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
