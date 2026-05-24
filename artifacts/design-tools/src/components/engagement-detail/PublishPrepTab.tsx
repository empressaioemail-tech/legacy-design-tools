import { useState } from "react";
import {
  CheckCircle2,
  Circle,
  Download,
  FileWarning,
  UploadCloud,
} from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import { DraftBadge, SourceChip } from "../cockpit/QualityChips";

/**
 * Publish prep (QA-06) — UI shell only.
 *
 * Three stacked sections:
 *   1. Legacy plan upload — local-only file drop, no upload.
 *   2. Publisher checklist — auto-checked items derived from mock data,
 *      manual items the architect toggles.
 *   3. Export package — disabled until checklist is complete.
 *
 * All "auto" rows show source chips so it's obvious where the
 * pre-fill came from; the export button stays disabled with a
 * clear reason banner.
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

export function PublishPrepTab({ engagementId }: { engagementId: string }) {
  const [legacyFile, setLegacyFile] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ITEMS.map((i) => [i.id, i.initial])),
  );

  const total = ITEMS.length;
  const done = ITEMS.filter((i) => state[i.id]).length;
  const ready = done === total;

  return (
    <div
      className="cockpit-tab"
      data-testid="publish-prep-tab"
      data-engagement-id={engagementId}
    >
      <TabHeader
        overline="Deliverables · group"
        title="Publish prep"
        subtitle="Get the engagement ready for the publishing team. Upload the legacy plan, walk the checklist, then export the packet."
      />

      <section
        className="sc-card flex flex-col"
        data-testid="publish-prep-legacy"
      >
        <div className="sc-card-header">
          <span className="sc-label">LEGACY PLAN UPLOAD</span>
          <span className="sc-meta opacity-70">
            Drop the prior approved set so the publisher can diff your
            revision against it.
          </span>
        </div>
        <div style={{ padding: 16 }}>
          <label
            className="publish-prep-drop"
            data-testid="publish-prep-legacy-drop"
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
            <UploadCloud size={20} />
            <span>
              {legacyFile
                ? legacyFile
                : "Click to upload (PDF / DWG / ZIP)"}
            </span>
            <span className="publish-prep-drop-hint">
              File stays client-side in this UI shell — no upload is
              performed.
            </span>
          </label>
        </div>
      </section>

      <section
        className="sc-card flex flex-col"
        data-testid="publish-prep-checklist"
      >
        <div className="sc-card-header sc-row-sb">
          <div>
            <span className="sc-label">PUBLISHER CHECKLIST</span>
            <div className="sc-meta opacity-70">
              {done} of {total} items complete
            </div>
          </div>
          <div className="publish-prep-progress" aria-hidden="true">
            <div
              className="publish-prep-progress-bar"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
        </div>
        <ul className="publish-prep-list">
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
                    <CheckCircle2 size={16} className="publish-prep-row-on" />
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

      <section
        className="sc-card flex flex-col"
        data-testid="publish-prep-export"
      >
        <div className="sc-card-header sc-row-sb">
          <div>
            <span className="sc-label">EXPORT PACKAGE</span>
            <div className="sc-meta opacity-70">
              Bundles the legacy + revised plans, letters, and briefing into
              one zip for the publisher.
            </div>
          </div>
          <DraftBadge hint="Export bundle format is still draft" />
        </div>
        <div className="publish-prep-export-body">
          {!ready ? (
            <div className="publish-prep-export-warn">
              <FileWarning size={14} />
              <span>
                Export is locked until the checklist is complete ({total - done}{" "}
                item{total - done === 1 ? "" : "s"} remaining).
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
  );
}
