import { useCallback, useMemo, useRef, useState } from "react";
import {
  Camera,
  CheckSquare,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Heart,
  History,
  Image as ImageIcon,
  MessageSquare,
  PanelRightOpen,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import { DraftBadge, SourceChip } from "../cockpit/QualityChips";
import {
  canEnterPresentationStep,
  isPresentationStepComplete,
  PRESENTATION_FLOW_STEPS,
  SECTION_SOURCE_TAB,
  type PresentationFlowStepId,
} from "./presentationFlow";
import {
  countTemplatePages,
  DEFAULT_PRESENTATION_PAGE_IDS,
  PRESENTATION_PAGE_CATEGORIES,
  PRESENTATION_PAGE_TYPES,
  PRESENTATION_TEMPLATE_META,
} from "./presentationTemplate";
import type { TabId } from "./urlState";

/**
 * Presentations (QA-29) — client deck UI shell.
 *
 * Packages a design concept for client review in a Canva-style slide
 * deck: moodboards, room overviews, floor plans, materials / FF&E, and
 * next-steps pages on a neutral branded template (~30 pages when fully
 * populated). Exports a PDF today; Canva handoff is planned.
 *
 * No backend wiring — page toggles and export run local mock state only.
 */

interface VersionEntry {
  id: string;
  label: string;
  generatedAt: string;
  pageCount: number;
  isDraft: boolean;
}

const SEED_VERSIONS: ReadonlyArray<VersionEntry> = [
  {
    id: "v-002",
    label: "Pre-call walkthrough",
    generatedAt: "yesterday · 4:12 PM",
    pageCount: 24,
    isDraft: true,
  },
  {
    id: "v-001",
    label: "First share with client",
    generatedAt: "3 days ago",
    pageCount: 18,
    isDraft: false,
  },
];

type ViewMode = "deck" | "moodboards" | "plans";

const VIEW_MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: "deck", label: "Full deck" },
  { id: "moodboards", label: "Moodboards" },
  { id: "plans", label: "Plans" },
];

export function PresentationsTab({
  engagementId,
  onNavigate,
}: {
  engagementId: string;
  onNavigate?: (tab: TabId) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(DEFAULT_PRESENTATION_PAGE_IDS),
  );
  const [generating, setGenerating] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>(() => [
    ...SEED_VERSIONS,
  ]);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(
    SEED_VERSIONS[0]?.id ?? null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("deck");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [flowStep, setFlowStep] = useState<PresentationFlowStepId>("assemble");

  const sectionsRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const slidesRef = useRef<HTMLElement>(null);

  const selectedPages = useMemo(
    () => PRESENTATION_PAGE_TYPES.filter((p) => selected.has(p.id)),
    [selected],
  );

  const estimatedPageCount = useMemo(
    () => countTemplatePages(selected),
    [selected],
  );

  const draftCount = versions.filter((v) => v.isDraft).length;
  const flowCtx = useMemo(
    () => ({
      selectedCount: selectedPages.length,
      versionCount: versions.length,
      generating,
      hasDraft: draftCount > 0,
    }),
    [selectedPages.length, versions.length, generating, draftCount],
  );

  const goToFlowStep = useCallback((step: PresentationFlowStepId) => {
    if (!canEnterPresentationStep(step, flowCtx)) return;
    setFlowStep(step);
    if (step === "assemble") {
      sectionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (step === "preview" || step === "generate") {
      heroRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (step === "review") {
      setDrawerOpen(true);
      slidesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [flowCtx]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size > 0 && flowStep === "assemble") {
        setFlowStep("preview");
      }
      return next;
    });

  const handleGenerate = () => {
    if (generating || selectedPages.length === 0) return;
    setFlowStep("generate");
    setGenerating(true);
    window.setTimeout(() => {
      setVersions((prev) => {
        const nextNum = prev.length + 1;
        const entry: VersionEntry = {
          id: `v-${String(nextNum).padStart(3, "0")}`,
          label: `Draft v${nextNum}`,
          generatedAt: "just now",
          pageCount: estimatedPageCount,
          isDraft: true,
        };
        setActiveVersionId(entry.id);
        return [entry, ...prev];
      });
      setGenerating(false);
      setFlowStep("review");
      setDrawerOpen(true);
    }, 700);
  };

  return (
    <div
      className="cockpit-tab"
      data-testid="presentations-tab"
      data-engagement-id={engagementId}
    >
      <TabHeader
        overline="Studio · client deliverable"
        title="Client presentation"
        subtitle={PRESENTATION_TEMPLATE_META.subtitle}
      />

      <aside
        className="presentation-template-scope sc-card"
        data-testid="presentation-template-scope"
        aria-labelledby="presentation-template-scope-title"
      >
        <h2 id="presentation-template-scope-title" className="presentation-template-scope-title">
          {PRESENTATION_TEMPLATE_META.title}
        </h2>
        <p className="presentation-template-scope-lead">
          Downloadable slide deck for client review — like an interior-design
          Canva template, not plan-check documentation. Neutral layout, lifestyle
          imagery slots, moodboard grids, plan panels, and materials boards you
          brand per studio.
        </p>
        <ul className="presentation-template-scope-meta">
          <li>
            <strong>Template size:</strong> {PRESENTATION_TEMPLATE_META.pageTarget}{" "}
            when all page types are included (duplicate and reorder per project).
          </li>
          <li>
            <strong>Outputs:</strong>{" "}
            {PRESENTATION_TEMPLATE_META.outputs.join(" · ")}
          </li>
          <li>
            <strong>Visual system:</strong> {PRESENTATION_TEMPLATE_META.aesthetic}
          </li>
        </ul>
      </aside>

      <nav
        className="presentation-flow"
        aria-label="Presentation workflow"
        data-testid="presentation-flow"
      >
        {PRESENTATION_FLOW_STEPS.map((step, index) => {
          const active = flowStep === step.id;
          const complete = isPresentationStepComplete(step.id, flowCtx);
          const enabled = canEnterPresentationStep(step.id, flowCtx);
          return (
            <button
              key={step.id}
              type="button"
              className="presentation-flow-step"
              data-testid={step.testId}
              data-active={active ? "true" : "false"}
              data-complete={complete ? "true" : "false"}
              disabled={!enabled}
              title={step.summary}
              onClick={() => goToFlowStep(step.id)}
            >
              <span className="presentation-flow-step-index">{index + 1}</span>
              <span className="presentation-flow-step-text">
                <span className="presentation-flow-step-label">{step.label}</span>
                <span className="presentation-flow-step-summary">{step.summary}</span>
              </span>
              {index < PRESENTATION_FLOW_STEPS.length - 1 && (
                <ChevronRight
                  className="presentation-flow-step-chevron"
                  size={16}
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </nav>

      <div
        className="sc-card presentation-workspace"
        style={{
          padding: 0,
          display: "flex",
          overflow: "hidden",
          minHeight: 560,
        }}
      >
        {/* MAIN PANE */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Top view-mode tab strip */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border-soft)",
              background: "var(--bg-surface)",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                gap: 4,
                padding: 3,
                borderRadius: 999,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-default)",
              }}
            >
              {VIEW_MODES.map((m) => {
                const active = viewMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setViewMode(m.id)}
                    data-testid={`presentation-view-${m.id}`}
                    style={{
                      padding: "4px 14px",
                      borderRadius: 999,
                      border: "none",
                      cursor: "pointer",
                      background: active ? "var(--bg-base)" : "transparent",
                      color: active
                        ? "var(--cyan-text)"
                        : "var(--text-secondary)",
                      fontSize: 12,
                      fontWeight: active ? 600 : 500,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {m.label}
                    {m.id === "deck" && draftCount > 0 && (
                      <span
                        style={{
                          padding: "1px 6px",
                          borderRadius: 999,
                          background: "var(--cyan)",
                          color: "var(--text-inverse)",
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: 0.2,
                        }}
                      >
                        {draftCount} new
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
            >
              <span>
                {selectedPages.length} page{" "}
                {selectedPages.length === 1 ? "type" : "types"} · ~
                {estimatedPageCount} slides · {versions.length} version
                {versions.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* HERO preview pane */}
          <div
            ref={heroRef}
            style={{
              position: "relative",
              flex: "0 0 auto",
              height: 280,
              borderBottom: "1px solid var(--border-soft)",
              overflow: "hidden",
              background: "var(--bg-base)",
            }}
            data-testid="presentation-hero"
            data-flow-step={flowStep === "preview" || flowStep === "generate" ? flowStep : undefined}
          >
            {/* faux project preview */}
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 1280 280"
              preserveAspectRatio="xMidYMid slice"
              aria-hidden="true"
              style={{ display: "block" }}
            >
              <defs>
                <linearGradient id="presSky" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--bg-elevated)" />
                  <stop offset="100%" stopColor="var(--bg-highlight)" />
                </linearGradient>
              </defs>
              <rect width="1280" height="280" fill="url(#presSky)" />
              {/* Floor */}
              <path
                d="M0,210 Q300,200 600,215 T1280,205 L1280,280 L0,280 Z"
                fill="var(--bg-active)"
                opacity="0.55"
              />
              {/* Building silhouette */}
              <g transform="translate(440, 70)">
                <rect
                  x="0"
                  y="40"
                  width="400"
                  height="170"
                  fill="var(--bg-chrome)"
                />
                <rect
                  x="40"
                  y="0"
                  width="320"
                  height="40"
                  fill="var(--bg-chrome)"
                  opacity="0.85"
                />
                <rect
                  x="-20"
                  y="120"
                  width="80"
                  height="90"
                  fill="var(--bg-chrome)"
                  opacity="0.9"
                />
                {/* Glow windows */}
                <rect
                  x="20"
                  y="140"
                  width="360"
                  height="60"
                  fill="var(--cyan)"
                  opacity="0.10"
                />
                {[60, 130, 200, 270].map((x) => (
                  <rect
                    key={x}
                    x={x}
                    y="55"
                    width="30"
                    height="70"
                    fill="var(--cyan-bright)"
                    opacity="0.18"
                  />
                ))}
              </g>
              {/* Trees */}
              <circle
                cx="280"
                cy="210"
                r="36"
                fill="var(--bg-chrome)"
                opacity="0.7"
              />
              <circle
                cx="1000"
                cy="200"
                r="44"
                fill="var(--bg-chrome)"
                opacity="0.7"
              />
            </svg>

            {/* Top-left mode label */}
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 14,
                padding: "5px 10px",
                borderRadius: 4,
                background: "var(--bg-base)",
                border: "1px solid var(--border-soft)",
                color: "var(--text-primary)",
                fontSize: 11,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {viewMode === "deck" ? (
                <Camera size={12} color="var(--cyan-text)" />
              ) : viewMode === "plans" ? (
                <FileText size={12} color="var(--cyan-text)" />
              ) : (
                <ImageIcon size={12} color="var(--cyan-text)" />
              )}
              <span style={{ color: "var(--text-secondary)" }}>
                {viewMode === "deck"
                  ? "Deck · Cover → concept → rooms"
                  : viewMode === "plans"
                    ? "Plans · Annotated floor plan spread"
                    : "Moodboards · 2×2 inspiration grid"}
              </span>
            </div>

            {/* Top-right Render-with-AI ghost button */}
            <button
              type="button"
              disabled
              title="AI render generation will arrive with the render-credit backend."
              style={{
                position: "absolute",
                top: 12,
                right: 14,
                padding: "6px 12px",
                borderRadius: 999,
                background: "var(--bg-base)",
                border: "1px solid var(--border-soft)",
                color: "var(--text-secondary)",
                fontSize: 11,
                cursor: "not-allowed",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                opacity: 0.85,
              }}
            >
              <Sparkles size={12} color="var(--cyan-text)" />
              Render this view with AI
              <span
                style={{
                  marginLeft: 4,
                  fontSize: 9.5,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                Soon
              </span>
            </button>

            {/* Bottom-left view pills */}
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 14,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  gap: 3,
                  padding: 3,
                  borderRadius: 999,
                  background: "var(--bg-base)",
                  border: "1px solid var(--border-soft)",
                }}
              >
                {["Exterior", "Lobby", "Aerial", "3D Walk"].map((label, i) => (
                  <span
                    key={label}
                    style={{
                      padding: "3px 10px",
                      borderRadius: 999,
                      fontSize: 11,
                      color:
                        i === 0
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                      background:
                        i === 0 ? "var(--bg-elevated)" : "transparent",
                      fontWeight: i === 0 ? 600 : 400,
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <button
                type="button"
                disabled
                title="Reset view (preview-only)"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: "var(--bg-base)",
                  border: "1px solid var(--border-soft)",
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "not-allowed",
                }}
              >
                <RotateCcw size={12} />
              </button>
            </div>

            {/* Bottom-right Generate CTA */}
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || selectedPages.length === 0}
              data-testid="presentation-generate"
              style={{
                position: "absolute",
                bottom: 12,
                right: 14,
                padding: "8px 16px",
                borderRadius: 999,
                background:
                  generating || selectedPages.length === 0
                    ? "var(--bg-elevated)"
                    : "var(--cyan)",
                border: "1px solid var(--cyan-accent-border)",
                color:
                  generating || selectedPages.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-inverse)",
                fontSize: 12,
                fontWeight: 700,
                cursor:
                  generating || selectedPages.length === 0
                    ? "not-allowed"
                    : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                boxShadow:
                  generating || selectedPages.length === 0
                    ? "none"
                    : "0 4px 14px var(--cyan-glow)",
              }}
            >
              <Download size={13} />
              {generating ? "Exporting…" : "Export client deck (PDF)"}
            </button>
          </div>

          {/* Scrolling body: Sections rail + slide preview list */}
          <div
            className="sc-scroll"
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            {/* Page-type rail (horizontal scroll) */}
            <section ref={sectionsRef} data-flow-step="assemble">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                  color: "var(--text-primary)",
                  fontSize: 12.5,
                  fontWeight: 700,
                }}
              >
                <FileText size={13} color="var(--cyan-text)" />
                Page types
                <span
                  style={{
                    fontWeight: 400,
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    marginLeft: 4,
                  }}
                >
                  {selectedPages.length} of {PRESENTATION_PAGE_TYPES.length}{" "}
                  selected · ~{estimatedPageCount} slides
                </span>
              </div>
              <div
                className="sc-scroll"
                style={{
                  display: "flex",
                  gap: 10,
                  overflowX: "auto",
                  paddingBottom: 6,
                }}
              >
                {PRESENTATION_PAGE_TYPES.map((s) => {
                  const checked = selected.has(s.id);
                  const categoryLabel = PRESENTATION_PAGE_CATEGORIES.find(
                    (c) => c.id === s.category,
                  )?.label;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s.id)}
                      aria-pressed={checked}
                      data-testid={`presentation-section-${s.id}`}
                      style={{
                        flex: "0 0 200px",
                        height: 152,
                        textAlign: "left",
                        padding: 10,
                        borderRadius: 8,
                        background: checked
                          ? "var(--cyan-accent-bg)"
                          : "var(--bg-elevated)",
                        border: `1px solid ${
                          checked
                            ? "var(--cyan-accent-border)"
                            : "var(--border-default)"
                        }`,
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        color: "var(--text-primary)",
                        position: "relative",
                      }}
                    >
                      {/* Faux drawing thumb */}
                      <div
                        style={{
                          flex: 1,
                          borderRadius: 4,
                          background: "var(--bg-base)",
                          border: "1px solid var(--border-default)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                        }}
                      >
                        <svg
                          width="80%"
                          height="80%"
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                          style={{
                            opacity: 0.35,
                            color: "var(--text-secondary)",
                          }}
                        >
                          <rect
                            x="10"
                            y="10"
                            width="80"
                            height="80"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                          <line
                            x1="10"
                            y1="30"
                            x2="90"
                            y2="30"
                            stroke="currentColor"
                            strokeWidth="1"
                          />
                          <line
                            x1="50"
                            y1="30"
                            x2="50"
                            y2="90"
                            stroke="currentColor"
                            strokeWidth="1"
                          />
                          <circle
                            cx="30"
                            cy="60"
                            r="10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1"
                          />
                        </svg>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {checked ? (
                          <CheckSquare
                            size={13}
                            color="var(--cyan-text)"
                            aria-hidden="true"
                          />
                        ) : (
                          <Square
                            size={13}
                            color="var(--text-muted)"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: checked
                              ? "var(--cyan-text)"
                              : "var(--text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                        >
                          {s.label}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--text-muted)",
                        }}
                      >
                        {categoryLabel} · {s.templatePages} pg
                        {s.templatePages === 1 ? "" : "s"}
                      </span>
                      {checked && (
                        <span
                          aria-hidden="true"
                          style={{
                            position: "absolute",
                            top: -6,
                            right: -6,
                            background: "var(--cyan)",
                            color: "var(--text-inverse)",
                            fontSize: 9,
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: 999,
                            border: "1px solid var(--bg-elevated)",
                          }}
                        >
                          IN DECK
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Slide preview list */}
            <section ref={slidesRef} data-flow-step="review">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                  color: "var(--text-primary)",
                  fontSize: 12.5,
                  fontWeight: 700,
                }}
              >
                <ImageIcon size={13} color="var(--cyan-text)" />
                Slide preview
                <span
                  style={{
                    fontWeight: 400,
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    marginLeft: 4,
                  }}
                >
                  Order matches PDF export · duplicate pages in Canva later
                </span>
              </div>

              {selectedPages.length === 0 ? (
                <div
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    borderRadius: 8,
                    background: "var(--bg-base)",
                    border: "1px dashed var(--border-soft)",
                    color: "var(--text-secondary)",
                  }}
                >
                  <FileText
                    size={24}
                    color="var(--text-muted)"
                    aria-hidden="true"
                  />
                  <div
                    style={{
                      marginTop: 8,
                      color: "var(--text-primary)",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    Pick at least one page type
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11.5 }}>
                    Tap a card in the rail above to add spreads to the client deck.
                  </div>
                </div>
              ) : (
                <ol
                  data-testid="presentation-slide-preview"
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {selectedPages.map((s, idx) => (
                    <li
                      key={s.id}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "stretch",
                      }}
                    >
                      <span
                        style={{
                          width: 28,
                          flexShrink: 0,
                          textAlign: "right",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, monospace",
                          color: "var(--text-muted)",
                          fontSize: 11,
                          paddingTop: 12,
                        }}
                      >
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      <div
                        style={{
                          flex: 1,
                          padding: 10,
                          borderRadius: 6,
                          background: "var(--bg-base)",
                          border: "1px solid var(--border-default)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 600,
                              color: "var(--text-primary)",
                              fontSize: 12.5,
                            }}
                          >
                            {s.label}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              color: "var(--text-muted)",
                              fontWeight: 500,
                            }}
                          >
                            {s.templatePages} template pg
                            {s.templatePages === 1 ? "" : "s"}
                          </span>
                          <DraftBadge />
                        </div>
                        <p
                          style={{
                            margin: 0,
                            color: "var(--text-muted)",
                            fontSize: 10.5,
                            fontStyle: "italic",
                          }}
                        >
                          {s.layoutHint}
                        </p>
                        <p
                          style={{
                            margin: 0,
                            color: "var(--text-secondary)",
                            fontSize: 11.5,
                            lineHeight: 1.45,
                          }}
                        >
                          {s.description}
                        </p>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          {s.sources.map((src, i) => (
                            <SourceChip
                              key={i}
                              kind={src.kind}
                              label={src.label}
                            />
                          ))}
                          {onNavigate && SECTION_SOURCE_TAB[s.id] && (
                            <button
                              type="button"
                              className="presentation-section-source-link"
                              data-testid={`presentation-section-source-${s.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onNavigate(SECTION_SOURCE_TAB[s.id]!);
                              }}
                            >
                              <ExternalLink size={11} aria-hidden />
                              Edit source
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* Footer action row */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 4,
              }}
            >
              <button
                type="button"
                className="sc-btn-ghost"
                disabled
                title="Canva handoff — opens an editable duplicate of the deck template"
                data-testid="presentation-export-canva"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <ExternalLink size={13} /> Open in Canva (coming soon)
              </button>
              <button
                type="button"
                className="sc-btn-ghost"
                disabled
                title="Coming soon — needs the share-link backend"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Download size={13} /> Share link with client (coming soon)
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT DRAWER (Versions / Conversation) */}
        <aside
          aria-label="Version history"
          style={{
            flexShrink: 0,
            width: drawerOpen ? 300 : 48,
            background: "var(--bg-surface)",
            borderLeft: "1px solid var(--border-soft)",
            display: "flex",
            flexDirection: "column",
            transition: "width 200ms ease",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Collapse toggle tab */}
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={drawerOpen ? "Collapse versions" : "Expand versions"}
            data-testid="presentation-drawer-toggle"
            style={{
              position: "absolute",
              top: 12,
              left: 0,
              transform: "translateX(-50%)",
              width: 24,
              height: 28,
              borderRadius: 4,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-soft)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2,
            }}
          >
            {drawerOpen ? (
              <ChevronRight size={13} />
            ) : (
              <PanelRightOpen size={13} />
            )}
          </button>

          {drawerOpen ? (
            <>
              <div
                style={{
                  padding: "14px 16px",
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: "var(--text-primary)",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  <History size={14} color="var(--cyan-text)" />
                  Versions
                </div>
                <div
                  style={{
                    marginTop: 4,
                    color: "var(--text-secondary)",
                    fontSize: 11,
                  }}
                >
                  {versions.length === 0
                    ? "No drafts yet"
                    : `${versions.length} draft${versions.length === 1 ? "" : "s"} on file`}
                </div>
              </div>

              <div
                className="sc-scroll"
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {versions.length === 0 ? (
                  <div
                    style={{
                      padding: 14,
                      textAlign: "center",
                      color: "var(--text-secondary)",
                      fontSize: 11.5,
                    }}
                  >
                    No drafts yet — generate one to start a version trail.
                  </div>
                ) : (
                  versions.map((v) => {
                    const active = v.id === activeVersionId;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setActiveVersionId(v.id)}
                        data-testid={`presentation-version-${v.id}`}
                        style={{
                          textAlign: "left",
                          padding: "10px 12px",
                          borderRadius: 6,
                          background: active
                            ? "var(--cyan-accent-bg)"
                            : "var(--bg-elevated)",
                          border: `1px solid ${
                            active
                              ? "var(--cyan-accent-border)"
                              : "var(--border-default)"
                          }`,
                          cursor: "pointer",
                          color: "var(--text-primary)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, monospace",
                              fontSize: 11,
                              color: active
                                ? "var(--cyan-text)"
                                : "var(--text-secondary)",
                            }}
                          >
                            {v.id}
                          </span>
                          {v.isDraft ? (
                            <DraftBadge />
                          ) : (
                            <span
                              style={{
                                fontSize: 9.5,
                                fontWeight: 700,
                                letterSpacing: 0.4,
                                padding: "2px 6px",
                                borderRadius: 3,
                                background: "var(--success-dim)",
                                color: "var(--success-text)",
                                textTransform: "uppercase",
                              }}
                            >
                              Sent
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: active
                              ? "var(--cyan-text)"
                              : "var(--text-primary)",
                          }}
                        >
                          {v.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {v.generatedAt} · {v.pageCount} slide
                          {v.pageCount === 1 ? "" : "s"}
                          {active ? (
                            <>
                              {" "}
                              <Heart
                                size={10}
                                color="var(--cyan-text)"
                                style={{ verticalAlign: "middle" }}
                              />
                            </>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "52px 0 18px",
                gap: 14,
                color: "var(--text-secondary)",
              }}
            >
              <div style={{ position: "relative" }}>
                <MessageSquare size={16} />
                {draftCount > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -4,
                      right: -6,
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: "var(--cyan)",
                      border: "1px solid var(--bg-surface)",
                    }}
                    aria-hidden="true"
                  />
                )}
              </div>
              <div
                style={{
                  width: 16,
                  height: 1,
                  background: "var(--border-soft)",
                }}
                aria-hidden="true"
              />
              {versions.slice(0, 4).map((v, i) => (
                <div
                  key={v.id}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-default)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    color:
                      v.id === activeVersionId
                        ? "var(--cyan-text)"
                        : "var(--text-secondary)",
                  }}
                >
                  {i + 1}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
