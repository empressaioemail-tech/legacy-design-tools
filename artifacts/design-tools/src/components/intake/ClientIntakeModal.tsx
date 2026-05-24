import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  FileUp,
  Link2,
  Mail,
  StickyNote,
  X,
} from "lucide-react";
import { DraftBadge, SourceChip } from "../cockpit/QualityChips";

/**
 * Client intake — QA-27 surface, UI shell only.
 *
 * Four entry lanes (link / file / paste text / forwarded email) collapse
 * into a single "Create draft project" call. The submit handler runs a
 * mock 600ms job and lands the user on a success state that shows the
 * synthesized project preview with the standard quality-bar chips
 * (Draft badge + source chip + Unverified tag where the agent
 * couldn't pull a value) so the screen reads like the real intake will.
 *
 * Backend is intentionally not wired — no API call is made and no
 * engagement is created. The modal is the empty-state shell the chat /
 * agent integration will hang off in the next wave.
 */

type IntakeMode = "link" | "file" | "paste" | "email";

const MODE_TABS: Array<{ id: IntakeMode; label: string; icon: typeof Link2 }> =
  [
    { id: "link", label: "Drop a link", icon: Link2 },
    { id: "file", label: "Upload file", icon: FileUp },
    { id: "paste", label: "Paste text", icon: StickyNote },
    { id: "email", label: "Forward email", icon: Mail },
  ];

const MODE_HINT: Record<IntakeMode, string> = {
  link: "Paste a Revit / Drive / Box / Sharepoint / Figma URL. The agent will follow the link, pull metadata, and stage a draft project.",
  file: "Drop a PDF, DWG, or zipped Revit central file. Files stay client-side until you click Create.",
  paste: "Paste the project brief, a client email body, or a meeting transcript. The agent will extract the project name, address, and scope.",
  email: "Forward the kickoff email to the workspace inbox (shown after create), or paste it below — agent parses sender, subject, and attachments.",
};

interface DraftPreview {
  projectName: string;
  address: string;
  jurisdiction: string;
  projectType: string;
  unverifiedFields: ReadonlyArray<"address" | "jurisdiction" | "projectType">;
  sources: ReadonlyArray<{ kind: string; label: string }>;
}

const MOCK_PREVIEW: Record<IntakeMode, DraftPreview> = {
  link: {
    projectName: "Untitled link-imported project",
    address: "1144 N Kayenta Dr, Moab UT 84532",
    jurisdiction: "Grand County, UT",
    projectType: "New build",
    unverifiedFields: ["projectType"],
    sources: [
      { kind: "URL", label: "linked Drive folder" },
      { kind: "GIS", label: "Grand County parcel lookup" },
    ],
  },
  file: {
    projectName: "Untitled upload project",
    address: "Address not detected",
    jurisdiction: "Jurisdiction not detected",
    projectType: "Renovation",
    unverifiedFields: ["address", "jurisdiction"],
    sources: [{ kind: "PDF", label: "uploaded scope p. 1–3" }],
  },
  paste: {
    projectName: "Untitled paste-imported project",
    address: "143 E 100 N, Moab UT 84532",
    jurisdiction: "Grand County, UT",
    projectType: "Addition",
    unverifiedFields: [],
    sources: [{ kind: "PASTE", label: "client brief excerpt" }],
  },
  email: {
    projectName: "Untitled email-imported project",
    address: "Address not detected",
    jurisdiction: "Jurisdiction not detected",
    projectType: "New build",
    unverifiedFields: ["address", "jurisdiction", "projectType"],
    sources: [{ kind: "EMAIL", label: "forwarded kickoff" }],
  },
};

export interface ClientIntakeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ClientIntakeModal({ isOpen, onClose }: ClientIntakeModalProps) {
  const [mode, setMode] = useState<IntakeMode>("link");
  const [value, setValue] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<DraftPreview | null>(null);

  useEffect(() => {
    if (!isOpen) {
      // Reset the form on close so re-opening starts fresh.
      setMode("link");
      setValue("");
      setFileName(null);
      setSubmitting(false);
      setDraft(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const canSubmit =
    !submitting &&
    (mode === "file" ? !!fileName : value.trim().length > 0);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    // Mock latency so the loading state is visible. No API call.
    window.setTimeout(() => {
      setSubmitting(false);
      setDraft(MOCK_PREVIEW[mode]);
    }, 600);
  };

  const body = (
    <div
      className="intake-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="intake-title"
      data-testid="client-intake-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="intake-card">
        <header className="intake-header">
          <div className="intake-header-text">
            <span className="cockpit-tab-header-overline">
              Intake · QA-27
            </span>
            <h2 id="intake-title" className="intake-title">
              Create a draft project
            </h2>
            <p className="intake-sub">
              The agent will pull metadata, look up jurisdiction, and stage
              an engagement you can review before it's saved.
            </p>
          </div>
          <button
            type="button"
            className="intake-close"
            aria-label="Close intake"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {draft ? (
          <DraftPreviewView draft={draft} onStartOver={() => setDraft(null)} />
        ) : (
          <>
            <div
              role="tablist"
              aria-label="Intake source"
              className="intake-tabs"
            >
              {MODE_TABS.map((t) => {
                const Icon = t.icon;
                const active = mode === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`intake-tab${active ? " intake-tab-active" : ""}`}
                    data-testid={`intake-tab-${t.id}`}
                    onClick={() => {
                      setMode(t.id);
                      setValue("");
                      setFileName(null);
                    }}
                  >
                    <Icon size={14} />
                    {t.label}
                  </button>
                );
              })}
            </div>

            <p className="intake-mode-hint">{MODE_HINT[mode]}</p>

            <div className="intake-input-area">
              {mode === "link" ? (
                <input
                  type="url"
                  className="intake-input"
                  placeholder="https://drive.google.com/…"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  data-testid="intake-input-link"
                />
              ) : mode === "email" ? (
                <textarea
                  className="intake-input intake-textarea"
                  placeholder="Paste the forwarded email here, or note the inbox address you forwarded it to."
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  rows={6}
                  data-testid="intake-input-email"
                />
              ) : mode === "paste" ? (
                <textarea
                  className="intake-input intake-textarea"
                  placeholder="Paste the brief, transcript, or scope text…"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  rows={8}
                  data-testid="intake-input-paste"
                />
              ) : (
                <label
                  className="intake-file-drop"
                  data-testid="intake-input-file"
                >
                  <input
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setFileName(f ? f.name : null);
                    }}
                    style={{ display: "none" }}
                  />
                  <FileUp size={18} />
                  <span>
                    {fileName ? fileName : "Click to choose a PDF / DWG / ZIP"}
                  </span>
                  <span className="intake-file-hint">
                    Files stay client-side in this UI shell.
                  </span>
                </label>
              )}
            </div>

            <footer className="intake-footer">
              <span className="intake-foot-meta">
                No engagement is saved until you confirm on the next step.
              </span>
              <div className="intake-foot-actions">
                <button
                  type="button"
                  className="sc-btn-ghost"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="sc-btn-primary"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  data-testid="intake-submit"
                >
                  {submitting ? "Drafting…" : "Create draft project"}
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

function DraftPreviewView({
  draft,
  onStartOver,
}: {
  draft: DraftPreview;
  onStartOver: () => void;
}) {
  return (
    <div className="intake-success" data-testid="intake-success">
      <div className="intake-success-head">
        <CheckCircle2 size={18} className="intake-success-icon" />
        <div>
          <div className="intake-success-title">Draft project ready</div>
          <div className="intake-success-sub">
            Review the synthesized fields below. Saving / confirming the
            engagement isn't wired in this preview.
          </div>
        </div>
        <DraftBadge testId="intake-draft-badge" />
      </div>

      <dl className="intake-preview-grid">
        <PreviewField
          label="Project name"
          value={draft.projectName}
          unverified={false}
        />
        <PreviewField
          label="Address"
          value={draft.address}
          unverified={draft.unverifiedFields.includes("address")}
        />
        <PreviewField
          label="Jurisdiction"
          value={draft.jurisdiction}
          unverified={draft.unverifiedFields.includes("jurisdiction")}
        />
        <PreviewField
          label="Project type"
          value={draft.projectType}
          unverified={draft.unverifiedFields.includes("projectType")}
        />
      </dl>

      <div className="intake-source-row">
        <span className="cockpit-tab-header-overline">Sources</span>
        <div className="intake-source-chips">
          {draft.sources.map((s, i) => (
            <SourceChip key={i} kind={s.kind} label={s.label} />
          ))}
        </div>
      </div>

      <footer className="intake-footer">
        <span className="intake-foot-meta">
          Confirm step lands when the intake backend is wired.
        </span>
        <div className="intake-foot-actions">
          <button
            type="button"
            className="sc-btn-ghost"
            onClick={onStartOver}
          >
            Start over
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            disabled
            title="Coming soon — confirm is wired with the intake backend"
            data-testid="intake-confirm-stub"
          >
            Confirm & create engagement
          </button>
        </div>
      </footer>
    </div>
  );
}

function PreviewField({
  label,
  value,
  unverified,
}: {
  label: string;
  value: string;
  unverified: boolean;
}) {
  return (
    <div className="intake-preview-field">
      <dt className="intake-preview-label">{label}</dt>
      <dd className="intake-preview-value">
        <span>{value}</span>
        {unverified ? <UnverifiedInline /> : null}
      </dd>
    </div>
  );
}

function UnverifiedInline() {
  // Local mini-tag so we don't drag the AlertTriangle import all the way
  // up. Re-uses the shared CSS class.
  return (
    <span
      className="quality-unverified-tag"
      role="status"
      aria-label="Agent could not verify this from a primary source"
      title="Agent could not verify this from a primary source"
    >
      Unverified
    </span>
  );
}
