import { useState } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Layers,
  Play,
  Rocket,
  Send,
} from "lucide-react";
import {
  DEMO_PUBLISH_STAGES,
  isDemoSeedEnabled,
  type DemoPublishStage,
} from "../../demo/seed";
import type { TabId } from "./urlState";

const FALLBACK_STAGES: DemoPublishStage[] = [
  {
    id: "visualize",
    label: "Visualize",
    summary: "Render set readiness from the Renders tab",
    status: "pending",
  },
  {
    id: "assemble",
    label: "Assemble",
    summary: "Presentations + letters + callouts into export bundle",
    status: "pending",
  },
  {
    id: "review",
    label: "Review & send",
    summary: "Client review + jurisdiction handoff",
    status: "pending",
  },
  {
    id: "archive",
    label: "Archive",
    summary: "Post-launch archive + audit trail",
    status: "pending",
  },
];

function stageIcon(status: DemoPublishStage["status"]) {
  if (status === "complete") return <CheckCircle2 size={16} />;
  if (status === "blocked") return <AlertCircle size={16} />;
  if (status === "active") return <Play size={16} />;
  return <Rocket size={16} />;
}

/** Stage-gated launch flow — embedded in Mission control (Publish prep tab). */
export function PublishLaunchPipelineSection({
  onNavigate,
}: {
  onNavigate: (tab: TabId) => void;
}) {
  const stages = isDemoSeedEnabled() ? DEMO_PUBLISH_STAGES : FALLBACK_STAGES;
  const [activeId, setActiveId] = useState(stages[0]?.id ?? "visualize");
  const active = stages.find((s) => s.id === activeId) ?? stages[0];

  const scrollToChecklist = () => {
    document
      .getElementById("publish-prep-checklist")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section
      className="cockpit-publish-pipeline-section"
      data-testid="publish-launch-tab"
      aria-label="Launch pipeline"
    >
      <header className="cockpit-publish-pipeline-section-head">
        <h2 className="cockpit-publish-pipeline-section-title">Launch pipeline</h2>
        <p className="cockpit-publish-pipeline-section-sub">
          Stage-gated shipping: visualize assets, assemble the bundle, review &amp;
          send, then archive.
        </p>
      </header>

      <div
        className="cockpit-publish-stage-rail"
        role="tablist"
        aria-label="Launch stages"
      >
        {stages.map((stage, index) => {
          const isActive = stage.id === activeId;
          return (
            <button
              key={stage.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="cockpit-publish-stage-card"
              data-status={stage.status}
              data-active={isActive ? "true" : "false"}
              data-testid={`publish-stage-${stage.id}`}
              onClick={() => setActiveId(stage.id)}
            >
              {isActive && <span className="cockpit-publish-stage-card-glow" />}
              <div className="cockpit-publish-stage-card-head">
                <span className="cockpit-publish-stage-card-icon">
                  {stageIcon(stage.status)}
                </span>
                <span className="cockpit-publish-stage-card-label">
                  {index + 1}. {stage.label.toUpperCase()}
                </span>
              </div>
              <p className="cockpit-publish-stage-card-summary">{stage.summary}</p>
              {index < stages.length - 1 && (
                <ChevronRight
                  className="cockpit-publish-stage-card-chevron"
                  size={18}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {active && (
        <section
          className="cockpit-publish-stage-detail sc-card"
          data-testid="publish-stage-detail"
          data-stage={active.id}
        >
          <div className="cockpit-publish-stage-detail-head">
            <h3 className="cockpit-publish-stage-detail-title">{active.label}</h3>
            <span
              className="cockpit-publish-stage-detail-status"
              data-status={active.status}
            >
              {active.status === "complete"
                ? "Complete"
                : active.status === "active"
                  ? "In progress"
                  : active.status === "blocked"
                    ? "Blocked"
                    : "Pending"}
            </span>
          </div>
          <p className="cockpit-publish-stage-detail-copy">{active.summary}</p>

          <div className="cockpit-publish-stage-detail-actions">
            {active.id === "visualize" && (
              <button
                type="button"
                className="sc-btn-ghost"
                onClick={() => onNavigate("renders")}
              >
                <Play size={14} /> Open render studio
              </button>
            )}
            {active.id === "assemble" && (
              <>
                <button
                  type="button"
                  className="sc-btn-ghost"
                  onClick={() => onNavigate("presentations")}
                >
                  <Layers size={14} /> Edit pitch deck
                </button>
                <button
                  type="button"
                  className="sc-btn-ghost"
                  onClick={() => onNavigate("deliverable-letters")}
                >
                  <Send size={14} /> Comment-response letters
                </button>
              </>
            )}
            {active.id === "review" && (
              <>
                <button
                  type="button"
                  className="sc-btn-ghost"
                  onClick={() => onNavigate("findings")}
                >
                  <AlertCircle size={14} /> Triage findings
                </button>
                <button
                  type="button"
                  className="sc-btn-primary"
                  disabled={active.status === "blocked"}
                  title={
                    active.status === "blocked"
                      ? "Clear blockers in the checklist above first"
                      : "Send bundle to client"
                  }
                >
                  <Send size={14} /> Send to client
                </button>
              </>
            )}
            {active.id === "archive" && (
              <button
                type="button"
                className="sc-btn-ghost"
                disabled
                title="Available after launch"
              >
                <Archive size={14} /> Archive engagement
              </button>
            )}
            <button
              type="button"
              className="sc-btn-ghost"
              onClick={scrollToChecklist}
            >
              Publisher checklist
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
