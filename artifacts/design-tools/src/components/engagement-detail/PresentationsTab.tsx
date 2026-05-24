import { useMemo, useState } from "react";
import {
  CheckSquare,
  Download,
  FileText,
  History,
  Square,
} from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import {
  DraftBadge,
  SourceChip,
} from "../cockpit/QualityChips";

/**
 * Presentations (QA-29) — UI shell only.
 *
 * Section picker on the left → preview pane in the middle → version
 * list on the right. "Generate draft PDF" runs a mock 700ms job and
 * appends a new draft entry to the version list with the standard
 * Draft badge + source chips. No PDF is rendered, no API call is
 * made — this is the empty-state shell the backend will hang off.
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

  const selectedSections = useMemo(
    () => SECTIONS.filter((s) => selected.has(s.id)),
    [selected],
  );

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

      <div className="presentations-layout">
        <aside
          className="presentations-picker"
          aria-label="Presentation sections"
        >
          <div className="cockpit-tab-header-overline">Sections</div>
          <ul className="presentations-section-list">
            {SECTIONS.map((s) => {
              const checked = selected.has(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => toggle(s.id)}
                    className={`presentations-section-item${checked ? " presentations-section-item-active" : ""}`}
                    aria-pressed={checked}
                    data-testid={`presentation-section-${s.id}`}
                  >
                    {checked ? (
                      <CheckSquare size={14} aria-hidden="true" />
                    ) : (
                      <Square size={14} aria-hidden="true" />
                    )}
                    <div className="presentations-section-text">
                      <span className="presentations-section-label">
                        {s.label}
                      </span>
                      <span className="presentations-section-desc">
                        {s.description}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section
          className="presentations-preview"
          aria-label="Presentation preview"
        >
          <div className="presentations-preview-head">
            <div className="cockpit-tab-header-overline">Preview</div>
            <span className="presentations-preview-meta">
              {selectedSections.length}{" "}
              {selectedSections.length === 1 ? "section" : "sections"} selected
            </span>
          </div>
          {selectedSections.length === 0 ? (
            <div className="presentations-preview-empty">
              <FileText size={28} aria-hidden="true" />
              <div className="presentations-preview-empty-title">
                Pick at least one section
              </div>
              <div className="presentations-preview-empty-body">
                Use the list on the left to choose which atoms the agent
                should assemble into the deck.
              </div>
            </div>
          ) : (
            <ol
              className="presentations-slide-list"
              data-testid="presentation-slide-preview"
            >
              {selectedSections.map((s, idx) => (
                <li key={s.id} className="presentations-slide-row">
                  <span className="presentations-slide-num">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <div className="presentations-slide-card">
                    <div className="presentations-slide-card-head">
                      <span className="presentations-slide-card-title">
                        {s.label}
                      </span>
                      <DraftBadge />
                    </div>
                    <p className="presentations-slide-card-body">
                      {s.description}
                    </p>
                    <div className="presentations-slide-card-sources">
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

          <div className="presentations-actions">
            <button
              type="button"
              className="sc-btn-primary"
              onClick={handleGenerate}
              disabled={generating || selectedSections.length === 0}
              data-testid="presentation-generate"
            >
              {generating ? "Generating…" : "Generate draft PDF"}
            </button>
            <button
              type="button"
              className="sc-btn-ghost"
              disabled
              title="Coming soon — needs the share-link backend"
            >
              <Download size={14} /> Share with client (coming soon)
            </button>
          </div>
        </section>

        <aside
          className="presentations-versions"
          aria-label="Version history"
        >
          <div className="presentations-versions-head">
            <History size={14} />
            <span className="cockpit-tab-header-overline">Versions</span>
          </div>
          {versions.length === 0 ? (
            <div className="presentations-versions-empty">
              No drafts yet — generate one to start a version trail.
            </div>
          ) : (
            <ul className="presentations-version-list">
              {versions.map((v) => {
                const active = v.id === activeVersionId;
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      className={`presentations-version-item${active ? " presentations-version-item-active" : ""}`}
                      onClick={() => setActiveVersionId(v.id)}
                      data-testid={`presentation-version-${v.id}`}
                    >
                      <div className="presentations-version-row">
                        <span className="presentations-version-id">
                          {v.id}
                        </span>
                        {v.isDraft ? <DraftBadge /> : null}
                      </div>
                      <div className="presentations-version-label">
                        {v.label}
                      </div>
                      <div className="presentations-version-meta">
                        {v.generatedAt} · {v.sectionCount} sections
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
