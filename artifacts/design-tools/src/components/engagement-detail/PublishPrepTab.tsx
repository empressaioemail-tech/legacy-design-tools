import { useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Download,
  FileText,
  FileWarning,
  History,
  Image as ImageIcon,
  Package,
  Presentation,
  Rocket,
  Send,
  UploadCloud,
} from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import { DraftBadge, SourceChip } from "../cockpit/QualityChips";
import { demoPublishChecklistState, isDemoSeedEnabled } from "../../demo/seed";
import { PublishLaunchPipelineSection } from "./PublishLaunchPipelineSection";
import type { TabId } from "./urlState";

/**
 * Publish prep (QA-06) — Launchpad-style mission dashboard with
 * Canvas-Studio-style asset and slide preview tiles folded into
 * the deliverable cards.
 *
 * Layout:
 *   Top banner — READY TO SHIP headline, blocker summary, readiness
 *     donut. Counts derived from the publisher checklist below.
 *   Main grid (2x2 mission deck):
 *     1. Render Set        — mock render thumbs (Canvas Studio palette).
 *     2. Client Pitch Deck — mock slide strip + Preview / PDF actions.
 *     3. Publisher Checklist — REAL data, preserves
 *        publish-prep-checklist + publish-prep-item-* testids.
 *     4. Final Bundle      — preserves publish-prep-export +
 *        publish-prep-export-btn (export stays disabled).
 *   Right rail (Mission Control):
 *     - Legacy plan upload  — preserves publish-prep-legacy +
 *       publish-prep-legacy-drop (file stays client-side).
 *     - Open blockers list  — auto-derived from the checklist.
 *     - Render credits gauge.
 *     - Recent activity feed.
 *     - Schedule launch CTA.
 *
 * All colors flow through theme tokens; no #hex / rgba() literals
 * are introduced here.
 */

interface ChecklistItem {
  id: string;
  label: string;
  detail: string;
  source: "auto" | "manual";
  /** Auto items only — source chip describing where the pre-fill came from. */
  sourceChip?: { kind: string; label: string };
  initial: boolean;
}

const ITEMS: ReadonlyArray<ChecklistItem> = [
  {
    id: "metadata",
    label: "Engagement metadata complete",
    detail: "Name, address, jurisdiction, lot area, project type.",
    source: "auto",
    sourceChip: { kind: "META", label: "engagement details" },
    initial: true,
  },
  {
    id: "site-context",
    label: "Site context briefing generated",
    detail: "A–G sections at least once, no failed adapter runs in the last 24h.",
    source: "auto",
    sourceChip: { kind: "BRIEF", label: "latest briefing run" },
    initial: true,
  },
  {
    id: "findings-addressed",
    label: "All blocker findings addressed",
    detail: "No open blocker-severity findings on the latest submission.",
    source: "auto",
    sourceChip: { kind: "RUN", label: "latest plan-review run" },
    initial: false,
  },
  {
    id: "letters-sent",
    label: "Comment-response letter sent",
    detail: "At least one deliverable letter has been rendered + sent.",
    source: "auto",
    sourceChip: { kind: "DOC", label: "deliverable letters" },
    initial: false,
  },
  {
    id: "client-review",
    label: "Client signed off on the deliverable packet",
    detail: "Architect attests that the latest letter has been client-reviewed.",
    source: "manual",
    initial: false,
  },
  {
    id: "publisher-handoff",
    label: "Publisher handoff doc attached",
    detail: "Internal handoff PDF uploaded for the publishing team.",
    source: "manual",
    initial: false,
  },
];

/* Static visual mocks for the Render Set + Pitch Deck preview cards.
   These are intentionally UI-only — the real render / deck pipelines
   live in the Renders and Presentations tabs; this tab only surfaces
   them at-a-glance for the launch dashboard. */
const RENDER_TILES = [
  { id: "r1", status: "done" as const, label: "Hero exterior" },
  { id: "r2", status: "done" as const, label: "Lobby interior" },
  { id: "r3", status: "done" as const, label: "Site aerial" },
  { id: "r4", status: "progress" as const, label: "Street view", pct: 60 },
];
const SLIDE_TILES = [
  { id: "s1", tone: "var(--info)" },
  { id: "s2", tone: "var(--cyan)" },
  { id: "s3", tone: "var(--warning)" },
  { id: "s4", tone: "var(--success)" },
];

export function PublishPrepTab({
  engagementId,
  onNavigate,
}: {
  engagementId: string;
  onNavigate?: (tab: TabId) => void;
}) {
  const [legacyFile, setLegacyFile] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, boolean>>(() => {
    const demo = isDemoSeedEnabled() ? demoPublishChecklistState() : null;
    if (demo) return demo;
    return Object.fromEntries(ITEMS.map((i) => [i.id, i.initial]));
  });

  const total = ITEMS.length;
  const done = ITEMS.filter((i) => state[i.id]).length;
  const ready = done === total;
  const pendingItems = ITEMS.filter((i) => !state[i.id]);
  const pct = Math.round((done / total) * 100);

  /* Donut geometry — r=40, circumference ≈ 251.2. */
  const dashOffset = 251.2 * (1 - done / total);

  return (
    <div
      className="cockpit-tab cockpit-publish-tab"
      data-testid="publish-prep-tab"
      data-engagement-id={engagementId}
    >
      <TabHeader
        overline="Publish"
        title="Mission control"
        subtitle="Readiness checklist, launch pipeline stages, and export when blockers clear."
        testId="publish-prep-tab-header"
      />

      <section
        className="sc-card cockpit-publish-ship-banner"
        style={{
          padding: 20,
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 24,
          alignItems: "center",
          background: "var(--bg-surface)",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--cyan-text)",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            ENGAGEMENT · READY-TO-SHIP STATUS
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {ready ? (
              <>READY TO SHIP: all {total} checklist items complete</>
            ) : (
              <>
                READY TO SHIP: {done} of {total} ·{" "}
                <span style={{ color: "var(--danger-text)" }}>
                  {pendingItems.length} blocked
                </span>
              </>
            )}
          </h2>
          {!ready && pendingItems.length > 0 ? (
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--text-secondary)",
              }}
            >
              <AlertCircle size={14} style={{ color: "var(--danger-text)" }} />
              <span>
                Blocked by:{" "}
                {pendingItems.slice(0, 3).map((p, i) => (
                  <span key={p.id} style={{ color: "var(--text-primary)" }}>
                    {p.label}
                    {i < Math.min(2, pendingItems.length - 1) ? " · " : ""}
                  </span>
                ))}
                {pendingItems.length > 3 ? (
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}
                    · +{pendingItems.length - 3} more
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
        <div style={{ position: "relative", width: 88, height: 88 }}>
          <svg
            viewBox="0 0 100 100"
            style={{
              width: "100%",
              height: "100%",
              transform: "rotate(-90deg)",
            }}
          >
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke="var(--bg-elevated)"
              strokeWidth="8"
            />
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke={
                ready
                  ? "var(--success)"
                  : pct >= 50
                    ? "var(--cyan)"
                    : "var(--warning)"
              }
              strokeWidth="8"
              strokeDasharray="251.2"
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{ transition: "stroke-dashoffset 240ms ease" }}
            />
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            {pct}%
          </div>
        </div>
      </section>

      <div className="cockpit-publish-mission-layout">
        <div className="cockpit-publish-mission-deck">
          {/* CARD 1 — Render Set preview (Canvas Studio palette) */}
          <DeckCard
            icon={<ImageIcon size={18} />}
            iconTone="cyan"
            title="Marketing render set"
            subtitle="3 of 4 hero renders ready · 1 in-progress (60%)"
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
                marginBottom: 12,
              }}
            >
              {RENDER_TILES.map((r) => (
                <div
                  key={r.id}
                  title={r.label}
                  style={{
                    aspectRatio: "4 / 3",
                    borderRadius: 6,
                    border:
                      r.status === "progress"
                        ? "1px dashed var(--cyan-accent-border)"
                        : "1px solid var(--border-soft)",
                    background:
                      r.status === "done"
                        ? "linear-gradient(135deg, var(--cyan-dim), var(--bg-elevated))"
                        : "var(--bg-base)",
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  {r.status === "done" ? (
                    <CheckCircle2
                      size={11}
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        color: "var(--success-text)",
                      }}
                    />
                  ) : (
                    <>
                      <div
                        style={{
                          position: "absolute",
                          bottom: 4,
                          left: 4,
                          fontSize: 10,
                          color: "var(--cyan-text)",
                          fontFamily: "var(--font-mono, monospace)",
                        }}
                      >
                        {r.pct}%
                      </div>
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          left: 0,
                          height: 2,
                          background: "var(--cyan)",
                          width: `${r.pct ?? 0}%`,
                        }}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
            <CardFooter
              hint="Launch when 4 / 4 hero renders complete"
              actionTone="cyan"
              actionLabel="Open render studio"
              onAction={onNavigate ? () => onNavigate("renders") : undefined}
            />
          </DeckCard>

          {/* CARD 2 — Client Pitch Deck (Canvas Studio slide strip) */}
          <DeckCard
            icon={<Presentation size={18} />}
            iconTone="warning"
            title="Client pitch deck"
            subtitle="14 slides · DRAFT · last edited 2 hr ago"
            badge={<DraftBadge hint="Deck export pipeline still draft" />}
          >
            <div
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 12,
                overflow: "hidden",
              }}
            >
              {SLIDE_TILES.map((s) => (
                <div
                  key={s.id}
                  style={{
                    width: 56,
                    height: 72,
                    borderRadius: 4,
                    border: "1px solid var(--border-soft)",
                    background: "var(--bg-base)",
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ height: 4, background: s.tone }} />
                  <div
                    style={{
                      flex: 1,
                      padding: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                    }}
                  >
                    <div
                      style={{
                        height: 4,
                        width: "70%",
                        background: "var(--bg-elevated)",
                        borderRadius: 2,
                      }}
                    />
                    <div
                      style={{
                        height: 4,
                        width: "50%",
                        background: "var(--bg-elevated)",
                        borderRadius: 2,
                      }}
                    />
                    <div
                      style={{
                        marginTop: "auto",
                        height: 18,
                        background: "var(--bg-elevated)",
                        borderRadius: 2,
                      }}
                    />
                  </div>
                </div>
              ))}
              <div
                style={{
                  width: 56,
                  height: 72,
                  borderRadius: 4,
                  border: "1px dashed var(--border-soft)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                +10
              </div>
            </div>
            <div
              style={{
                marginTop: "auto",
                paddingTop: 12,
                borderTop: "1px solid var(--border-soft)",
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="sc-btn-ghost"
                disabled
                title="Preview wired in the Presentations tab"
              >
                Preview
              </button>
              <button
                type="button"
                className="sc-btn-ghost"
                disabled
                title="PDF export coming soon"
              >
                <FileText size={12} /> Generate PDF
              </button>
              <button
                type="button"
                className="sc-btn-ghost"
                disabled
                title="Send-to-client coming soon"
                style={{ marginLeft: "auto" }}
              >
                <Send size={12} /> Send v4
              </button>
            </div>
          </DeckCard>

          {/* CARD 3 — Publisher Checklist (REAL data, preserves testids) */}
          <section
            id="publish-prep-checklist"
            className="sc-card"
            data-testid="publish-prep-checklist"
            style={{
              padding: 0,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid var(--border-soft)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  padding: 6,
                  borderRadius: 6,
                  background: "var(--success-dim)",
                  color: "var(--success-text)",
                  display: "flex",
                  flexShrink: 0,
                }}
              >
                <CheckCircle2 size={18} />
              </div>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                <div
                  style={{
                    color: "var(--text-primary)",
                    fontWeight: 500,
                    fontSize: 13,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  Publisher checklist
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {done} of {total} items complete
                </div>
              </div>
              <div
                className="publish-prep-progress"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              >
                <div
                  className="publish-prep-progress-bar"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
            <ul
              className="publish-prep-list"
              style={{ flex: 1, overflowY: "auto", maxHeight: 320 }}
            >
              {ITEMS.map((it) => {
                const checked = state[it.id];
                const isAuto = it.source === "auto";
                return (
                  <li key={it.id} className="publish-prep-row">
                    <button
                      type="button"
                      className="publish-prep-row-toggle"
                      onClick={() =>
                        setState((s) => ({ ...s, [it.id]: !s[it.id] }))
                      }
                      aria-pressed={checked}
                      data-testid={`publish-prep-item-${it.id}`}
                    >
                      {checked ? (
                        <CheckCircle2
                          size={16}
                          className="publish-prep-row-on"
                        />
                      ) : (
                        <Circle size={16} className="publish-prep-row-off" />
                      )}
                    </button>
                    <div className="publish-prep-row-text">
                      <div className="publish-prep-row-head">
                        <span className="publish-prep-row-label">
                          {it.label}
                        </span>
                        {isAuto ? (
                          <span
                            className="publish-prep-auto-tag"
                            title="Pre-filled from engagement data"
                          >
                            Auto
                          </span>
                        ) : null}
                        {isAuto && it.sourceChip ? (
                          <SourceChip
                            kind={it.sourceChip.kind}
                            label={it.sourceChip.label}
                          />
                        ) : null}
                      </div>
                      <div className="publish-prep-row-detail">{it.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* CARD 4 — Final Bundle export */}
          <section
            className="sc-card"
            data-testid="publish-prep-export"
            style={{
              padding: 0,
              display: "flex",
              flexDirection: "column",
              border: ready
                ? "1px solid var(--cyan-accent-border)"
                : "1px solid var(--border-soft)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {ready ? (
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  background:
                    "linear-gradient(180deg, var(--cyan-dim), transparent 60%)",
                  pointerEvents: "none",
                }}
              />
            ) : null}
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid var(--border-soft)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                position: "relative",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  padding: 6,
                  borderRadius: 6,
                  background: ready ? "var(--cyan)" : "var(--bg-elevated)",
                  color: ready
                    ? "var(--text-inverse)"
                    : "var(--text-secondary)",
                  display: "flex",
                  flexShrink: 0,
                }}
              >
                <Rocket size={18} />
              </div>
              <div style={{ flex: "1 1 0", minWidth: 0 }}>
                <div
                  style={{
                    color: "var(--text-primary)",
                    fontWeight: 500,
                    fontSize: 13,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  Final project bundle
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: ready
                      ? "var(--cyan-text)"
                      : "var(--text-secondary)",
                    marginTop: 2,
                  }}
                >
                  Readiness {pct}%
                </div>
              </div>
              <span style={{ flexShrink: 0 }}>
                <DraftBadge hint="Export bundle format is still draft" />
              </span>
            </div>
            <div
              className="publish-prep-export-body"
              style={{ position: "relative" }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "6px 16px",
                  fontSize: 12,
                  marginBottom: 12,
                }}
              >
                {ITEMS.map((it) => {
                  const ok = state[it.id];
                  return (
                    <div
                      key={it.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        color: ok
                          ? "var(--text-secondary)"
                          : "var(--danger-text)",
                      }}
                    >
                      {ok ? (
                        <Check size={12} style={{ color: "var(--success-text)" }} />
                      ) : (
                        <Circle size={10} style={{ fill: "currentColor" }} />
                      )}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              {!ready ? (
                <div className="publish-prep-export-warn">
                  <FileWarning size={14} />
                  <span>
                    Export is locked until the checklist is complete (
                    {total - done} item{total - done === 1 ? "" : "s"} remaining).
                  </span>
                </div>
              ) : null}
              <button
                type="button"
                className="sc-btn-primary publish-prep-export-btn"
                disabled
                title="Coming soon — export bundle backend is not wired"
                data-testid="publish-prep-export-btn"
              >
                <Download size={14} /> Export package (coming soon)
              </button>
            </div>
          </section>
        </div>

        <aside
          className="sc-card cockpit-publish-mission-rail"
          data-testid="publish-prep-mission-control"
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--border-soft)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--text-secondary)",
            }}
          >
            MISSION CONTROL
          </div>

          {/* Legacy plan upload — preserves publish-prep-legacy testid */}
          <div
            data-testid="publish-prep-legacy"
            style={{
              padding: 14,
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                marginBottom: 8,
              }}
            >
              LEGACY PLAN
            </div>
            <label
              className="publish-prep-drop"
              data-testid="publish-prep-legacy-drop"
              style={{ padding: 12 }}
            >
              <input
                type="file"
                accept=".pdf,.dwg,.zip"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setLegacyFile(f ? f.name : null);
                }}
                style={{ display: "none" }}
              />
              <UploadCloud size={18} />
              <span style={{ fontSize: 12 }}>
                {legacyFile ? legacyFile : "Upload prior set (PDF / DWG / ZIP)"}
              </span>
              <span
                className="publish-prep-drop-hint"
                style={{ fontSize: 10 }}
              >
                Stays client-side in this UI shell.
              </span>
            </label>
          </div>

          {/* Open blockers — auto-derived from incomplete checklist items */}
          <div
            style={{
              padding: 14,
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.08em",
                color: pendingItems.length
                  ? "var(--danger-text)"
                  : "var(--success-text)",
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {pendingItems.length ? (
                <>
                  <AlertCircle size={12} /> OPEN BLOCKERS (
                  {pendingItems.length})
                </>
              ) : (
                <>
                  <CheckCircle2 size={12} /> NO OPEN BLOCKERS
                </>
              )}
            </div>
            {pendingItems.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Every checklist item is signed off. Ready to schedule launch.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pendingItems.slice(0, 4).map((p) => (
                  <div
                    key={p.id}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: "var(--danger-dim)",
                      border: "1px solid var(--border-soft)",
                      fontSize: 12,
                      color: "var(--text-primary)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.label}
                    </span>
                    <ChevronRight
                      size={14}
                      style={{ color: "var(--text-muted)", flexShrink: 0 }}
                    />
                  </div>
                ))}
                {pendingItems.length > 4 ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      paddingLeft: 4,
                    }}
                  >
                    +{pendingItems.length - 4} more in checklist
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Render credits gauge */}
          <div
            style={{
              padding: 14,
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "var(--text-secondary)",
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <span>Render credits</span>
              <span
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--cyan-text)",
                }}
              >
                1,240 / 2,000
              </span>
            </div>
            <div
              style={{
                width: "100%",
                height: 6,
                background: "var(--bg-elevated)",
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "62%",
                  height: "100%",
                  background: "var(--cyan)",
                }}
              />
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                color: "var(--text-muted)",
              }}
            >
              Static estimate · live usage lives in the Renders tab.
            </div>
          </div>

          {/* Recent activity feed */}
          <div style={{ padding: 14, flex: 1, minHeight: 0 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-secondary)",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <History size={12} /> RECENT ACTIVITY
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <ActivityRow
                tone="var(--warning-text)"
                title="Maria edited deck v3"
                when="2 hr ago"
              />
              <ActivityRow
                tone="var(--success-text)"
                title="Render 'Hero exterior' completed"
                when="18 hr ago"
              />
              <ActivityRow
                tone="var(--text-muted)"
                title="Legacy plan uploaded"
                when="1 d ago"
              />
            </div>
          </div>

          {/* Schedule launch CTA */}
          <div
            style={{
              padding: 14,
              borderTop: "1px solid var(--border-soft)",
            }}
          >
            <button
              type="button"
              className="sc-btn-ghost"
              disabled={!ready}
              title={
                ready
                  ? "Schedule the publishing window"
                  : "Available once the checklist is complete"
              }
              style={{
                width: "100%",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Clock size={14} /> Schedule launch
            </button>
          </div>
        </aside>
      </div>

      {onNavigate && (
        <PublishLaunchPipelineSection onNavigate={onNavigate} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── */
/*  Helpers                                                       */
/* ─────────────────────────────────────────────────────────────── */

function DeckCard({
  icon,
  iconTone,
  title,
  subtitle,
  badge,
  children,
}: {
  icon: React.ReactNode;
  iconTone: "cyan" | "warning" | "success" | "neutral";
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const toneBg =
    iconTone === "cyan"
      ? "var(--cyan-dim)"
      : iconTone === "warning"
        ? "var(--warning-dim)"
        : iconTone === "success"
          ? "var(--success-dim)"
          : "var(--bg-elevated)";
  const toneFg =
    iconTone === "cyan"
      ? "var(--cyan-text)"
      : iconTone === "warning"
        ? "var(--warning-text)"
        : iconTone === "success"
          ? "var(--success-text)"
          : "var(--text-secondary)";
  return (
    <section
      className="sc-card"
      style={{
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
          minWidth: 0,
        }}
      >
        <div
          style={{
            padding: 6,
            borderRadius: 6,
            background: toneBg,
            color: toneFg,
            display: "flex",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: "var(--text-primary)",
              fontWeight: 500,
              fontSize: 13,
              display: "flex",
              gap: 6,
              alignItems: "center",
              minWidth: 0,
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: "1 1 0",
                minWidth: 0,
              }}
              title={title}
            >
              {title}
            </span>
            {badge ? (
              <span style={{ flexShrink: 0 }}>{badge}</span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={subtitle}
          >
            {subtitle}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {children}
      </div>
    </section>
  );
}

function CardFooter({
  hint,
  actionLabel,
  actionTone,
  onAction,
}: {
  hint: string;
  actionLabel: string;
  actionTone: "cyan" | "neutral";
  onAction?: () => void;
}) {
  return (
    <div
      style={{
        marginTop: "auto",
        paddingTop: 12,
        borderTop: "1px solid var(--border-soft)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{hint}</span>
      <button
        type="button"
        className="sc-btn-ghost"
        disabled={!onAction}
        onClick={onAction}
        title={onAction ? actionLabel : "Coming soon"}
        style={{
          color: actionTone === "cyan" ? "var(--cyan-text)" : "var(--text-secondary)",
          background: "none",
          border: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 12,
          fontWeight: 500,
          cursor: "not-allowed",
          opacity: 0.6,
        }}
      >
        {actionLabel} <ChevronRight size={12} />
      </button>
    </div>
  );
}

function ActivityRow({
  tone,
  title,
  when,
}: {
  tone: string;
  title: string;
  when: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 999,
          background: "var(--bg-elevated)",
          border: `1px solid ${tone}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        <div
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: tone,
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            marginTop: 1,
          }}
        >
          {when}
        </div>
      </div>
    </div>
  );
}

/* Unused but kept in the import surface so future iterations can
   adopt the Package icon for the jurisdiction-submission card
   without re-adding the import. */
void Package;
