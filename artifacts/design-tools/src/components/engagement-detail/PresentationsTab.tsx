import { useMemo, useState } from "react";
import {
  Camera,
  CheckSquare,
  ChevronRight,
  Download,
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

/**
 * Presentations (QA-29) — UI shell only.
 *
 * Graduates the client-portal Showroom canvas mockup into the
 * production Presentations tab. Layout: top view-mode tab strip
 * (Tour / Sheets / Renderings) → hero preview pane with floating
 * controls (faux project illustration + view pills + "Generate
 * draft PDF" CTA) → horizontal "Sections" rail of selectable
 * section cards → vertical slide preview list → right-side
 * collapsible Versions / Conversation drawer with toggle pill.
 *
 * No backend wiring: section toggle still updates local state,
 * "Generate draft PDF" still runs a 700ms mock job that appends a
 * draft to the version list. Tokens-only — every color flows
 * through smartcity-themes.css tokens.
 */

interface SectionDef {
  id: string;
  label: string;
  description: string;
  /** Source chips the agent will pull from when assembling this section. */
  sources: ReadonlyArray<{ kind: string; label: string }>;
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  {
    id: "cover",
    label: "Cover page",
    description:
      "Project name, jurisdiction, presenter, and the engagement-level KPI strip.",
    sources: [{ kind: "META", label: "engagement details" }],
  },
  {
    id: "site-context",
    label: "Site context summary",
    description:
      "Top-level briefing narrative + the federal / state / local source rows.",
    sources: [
      { kind: "BRIEF", label: "Site Context briefing" },
      { kind: "GIS", label: "parcel overlay" },
    ],
  },
  {
    id: "findings",
    label: "Findings recap",
    description:
      "Most-recent submission findings, grouped by severity, with element refs.",
    sources: [{ kind: "RUN", label: "latest plan-review run" }],
  },
  {
    id: "letters",
    label: "Comment-response letters",
    description:
      "Rendered deliverable letters that have been sent or are ready to send.",
    sources: [{ kind: "DOC", label: "deliverable letters" }],
  },
  {
    id: "renders",
    label: "Renders & 3D snapshots",
    description:
      "Picked sheet thumbnails and BIM viewer captures (renders tab selection).",
    sources: [{ kind: "BIM", label: "model snapshots" }],
  },
  {
    id: "appendix",
    label: "Product spec appendix",
    description: "ICC-ES-evaluated product references and supporting docs.",
    sources: [{ kind: "ICC", label: "product specs" }],
  },
];

interface VersionEntry {
  id: string;
  label: string;
  generatedAt: string;
  sectionCount: number;
  isDraft: boolean;
}

const SEED_VERSIONS: ReadonlyArray<VersionEntry> = [
  {
    id: "v-002",
    label: "Pre-call walkthrough",
    generatedAt: "yesterday · 4:12 PM",
    sectionCount: 4,
    isDraft: true,
  },
  {
    id: "v-001",
    label: "First share with client",
    generatedAt: "3 days ago",
    sectionCount: 3,
    isDraft: false,
  },
];

type ViewMode = "tour" | "sheets" | "renderings";

const VIEW_MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: "tour", label: "Tour" },
  { id: "sheets", label: "Sheets" },
  { id: "renderings", label: "Renderings" },
];

export function PresentationsTab({
  engagementId,
}: {
  engagementId: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(["cover", "site-context", "findings"]),
  );
  const [generating, setGenerating] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>(() => [
    ...SEED_VERSIONS,
  ]);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(
    SEED_VERSIONS[0]?.id ?? null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("tour");
  const [drawerOpen, setDrawerOpen] = useState(true);

  const selectedSections = useMemo(
    () => SECTIONS.filter((s) => selected.has(s.id)),
    [selected],
  );

  const draftCount = versions.filter((v) => v.isDraft).length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleGenerate = () => {
    if (generating || selectedSections.length === 0) return;
    setGenerating(true);
    window.setTimeout(() => {
      const nextNum = versions.length + 1;
      const entry: VersionEntry = {
        id: `v-${String(nextNum).padStart(3, "0")}`,
        label: `Draft v${nextNum}`,
        generatedAt: "just now",
        sectionCount: selectedSections.length,
        isDraft: true,
      };
      setVersions([entry, ...versions]);
      setActiveVersionId(entry.id);
      setGenerating(false);
    }, 700);
  };

  return (
    <div
      className="cockpit-tab"
      data-testid="presentations-tab"
      data-engagement-id={engagementId}
    >
      <TabHeader
        overline="Deliverables · group"
        title="Presentations"
        subtitle="Assemble a client- or jurisdiction-ready slide deck from the atoms in this engagement. Drafts are agent-generated — review before sending."
      />

      <div
        className="sc-card"
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
                    {m.id === "tour" && draftCount > 0 && (
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
                {selectedSections.length}{" "}
                {selectedSections.length === 1 ? "section" : "sections"} ·{" "}
                {versions.length} version{versions.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* HERO preview pane */}
          <div
            style={{
              position: "relative",
              flex: "0 0 auto",
              height: 280,
              borderBottom: "1px solid var(--border-soft)",
              overflow: "hidden",
              background: "var(--bg-base)",
            }}
            data-testid="presentation-hero"
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
              {viewMode === "tour" ? (
                <Camera size={12} color="var(--cyan-text)" />
              ) : viewMode === "sheets" ? (
                <FileText size={12} color="var(--cyan-text)" />
              ) : (
                <ImageIcon size={12} color="var(--cyan-text)" />
              )}
              <span style={{ color: "var(--text-secondary)" }}>
                {viewMode === "tour"
                  ? "Tour · Exterior approach"
                  : viewMode === "sheets"
                    ? "Sheets · A1.1 Site plan"
                    : "Renderings · Hero exterior"}
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
              disabled={generating || selectedSections.length === 0}
              data-testid="presentation-generate"
              style={{
                position: "absolute",
                bottom: 12,
                right: 14,
                padding: "8px 16px",
                borderRadius: 999,
                background:
                  generating || selectedSections.length === 0
                    ? "var(--bg-elevated)"
                    : "var(--cyan)",
                border: "1px solid var(--cyan-accent-border)",
                color:
                  generating || selectedSections.length === 0
                    ? "var(--text-muted)"
                    : "var(--text-inverse)",
                fontSize: 12,
                fontWeight: 700,
                cursor:
                  generating || selectedSections.length === 0
                    ? "not-allowed"
                    : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                boxShadow:
                  generating || selectedSections.length === 0
                    ? "none"
                    : "0 4px 14px var(--cyan-glow)",
              }}
            >
              <Camera size={13} />
              {generating ? "Generating…" : "Generate draft PDF"}
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
            {/* Sections rail (horizontal scroll) */}
            <section>
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
                Sections
                <span
                  style={{
                    fontWeight: 400,
                    color: "var(--text-secondary)",
                    fontSize: 11,
                    marginLeft: 4,
                  }}
                >
                  {selectedSections.length} of {SECTIONS.length} selected
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
                {SECTIONS.map((s) => {
                  const checked = selected.has(s.id);
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
            <section>
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
                  Order matches deck output
                </span>
              </div>

              {selectedSections.length === 0 ? (
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
                    Pick at least one section
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11.5 }}>
                    Tap a card in the rail above to add it to the deck.
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
                  {selectedSections.map((s, idx) => (
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
                          <DraftBadge />
                        </div>
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
                          }}
                        >
                          {s.sources.map((src, i) => (
                            <SourceChip
                              key={i}
                              kind={src.kind}
                              label={src.label}
                            />
                          ))}
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
                title="Coming soon — needs the share-link backend"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Download size={13} /> Share with client (coming soon)
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
                          {v.generatedAt} · {v.sectionCount} section
                          {v.sectionCount === 1 ? "" : "s"}
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
