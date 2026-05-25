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
import { useLocation } from "wouter";
import { DraftBadge, SourceChip } from "../cockpit/QualityChips";
import { createEngagement } from "../engagement-detail/packages/packagesApi";

type IntakeMode = "link" | "file" | "paste" | "email";

type ProjectTypeValue =
  | "new_build"
  | "renovation"
  | "addition"
  | "tenant_improvement"
  | "other"
  | "";

const PROJECT_TYPE_OPTIONS: Array<{ value: ProjectTypeValue; label: string }> =
  [
    { value: "", label: "Not set" },
    { value: "new_build", label: "New build" },
    { value: "renovation", label: "Renovation" },
    { value: "addition", label: "Addition" },
    { value: "tenant_improvement", label: "Tenant improvement" },
    { value: "other", label: "Other" },
  ];

const MODE_TABS: Array<{ id: IntakeMode; label: string; icon: typeof Link2 }> =
  [
    { id: "link", label: "Drop a link", icon: Link2 },
    { id: "file", label: "Upload file", icon: FileUp },
    { id: "paste", label: "Paste text", icon: StickyNote },
    { id: "email", label: "Forward email", icon: Mail },
  ];

const MODE_HINT: Record<IntakeMode, string> = {
  link: "Paste a Revit / Drive / Box / Sharepoint / Figma URL. The agent will follow the link and merge what it finds with your project details.",
  file: "Drop a PDF, DWG, or zipped Revit central file. Files stay client-side until you confirm.",
  paste: "Paste the project brief, client email, or meeting transcript. The agent extracts name, address, and scope.",
  email: "Forward the kickoff email to the workspace inbox, or paste it below — agent parses sender, subject, and attachments.",
};

interface ProjectDetailsForm {
  projectName: string;
  address: string;
  jurisdiction: string;
  projectType: ProjectTypeValue;
  clientName: string;
  clientEmail: string;
  clientNotes: string;
}

const EMPTY_DETAILS: ProjectDetailsForm = {
  projectName: "",
  address: "",
  jurisdiction: "",
  projectType: "",
  clientName: "",
  clientEmail: "",
  clientNotes: "",
};

interface DraftPreview extends ProjectDetailsForm {
  unverifiedFields: ReadonlyArray<
    "address" | "jurisdiction" | "projectType" | "projectName"
  >;
  sources: ReadonlyArray<{ kind: string; label: string }>;
}

const MOCK_EXTRACT: Record<
  IntakeMode,
  Pick<
    DraftPreview,
  | "projectName"
  | "address"
  | "jurisdiction"
  | "projectType"
  | "unverifiedFields"
  | "sources"
  >
> = {
  link: {
    projectName: "Untitled link-imported project",
    address: "1144 N Kayenta Dr, Moab UT 84532",
    jurisdiction: "Grand County, UT",
    projectType: "new_build",
    unverifiedFields: ["projectType"],
    sources: [
      { kind: "URL", label: "linked Drive folder" },
      { kind: "GIS", label: "Grand County parcel lookup" },
    ],
  },
  file: {
    projectName: "Untitled upload project",
    address: "",
    jurisdiction: "",
    projectType: "renovation",
    unverifiedFields: ["address", "jurisdiction"],
    sources: [{ kind: "PDF", label: "uploaded scope p. 1–3" }],
  },
  paste: {
    projectName: "Untitled paste-imported project",
    address: "143 E 100 N, Moab UT 84532",
    jurisdiction: "Grand County, UT",
    projectType: "addition",
    unverifiedFields: [],
    sources: [{ kind: "PASTE", label: "client brief excerpt" }],
  },
  email: {
    projectName: "Untitled email-imported project",
    address: "",
    jurisdiction: "",
    projectType: "new_build",
    unverifiedFields: ["address", "jurisdiction", "projectType"],
    sources: [{ kind: "EMAIL", label: "forwarded kickoff" }],
  },
};

function mergeDraft(
  mode: IntakeMode,
  manual: ProjectDetailsForm,
): DraftPreview {
  const extracted = MOCK_EXTRACT[mode];
  const pick = (key: keyof ProjectDetailsForm) => {
    const manualVal = manual[key];
    if (typeof manualVal === "string" && manualVal.trim()) {
      return manualVal.trim();
    }
    const extractedVal = extracted[key as keyof typeof extracted];
    return typeof extractedVal === "string" ? extractedVal : "";
  };

  const projectName = pick("projectName");
  const address = pick("address");
  const jurisdiction = pick("jurisdiction");
  const projectType = (manual.projectType ||
    extracted.projectType ||
    "") as ProjectTypeValue;

  const unverified: Array<
    "address" | "jurisdiction" | "projectType" | "projectName"
  > = [];
  if (!manual.projectName.trim()) {
    if (extracted.unverifiedFields.includes("projectName" as never)) {
      unverified.push("projectName");
    }
  }
  for (const field of extracted.unverifiedFields) {
    if (field === "projectName") continue;
    const manualFilled =
      field === "address"
        ? manual.address.trim()
        : field === "jurisdiction"
          ? manual.jurisdiction.trim()
          : manual.projectType;
    if (!manualFilled) unverified.push(field);
  }

  return {
    projectName,
    address,
    jurisdiction,
    projectType,
    clientName: manual.clientName.trim(),
    clientEmail: manual.clientEmail.trim(),
    clientNotes: manual.clientNotes.trim(),
    unverifiedFields: unverified,
    sources: extracted.sources,
  };
}

function projectTypeLabel(value: ProjectTypeValue): string {
  return PROJECT_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export interface ClientIntakeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (engagementId: string) => void;
}

export function ClientIntakeModal({
  isOpen,
  onClose,
  onCreated,
}: ClientIntakeModalProps) {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<IntakeMode>("link");
  const [details, setDetails] = useState<ProjectDetailsForm>(EMPTY_DETAILS);
  const [value, setValue] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<DraftPreview | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setMode("link");
      setDetails(EMPTY_DETAILS);
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

  const hasSource =
    mode === "file" ? !!fileName : value.trim().length > 0;
  const hasBasics =
    details.projectName.trim().length > 0 ||
    details.address.trim().length > 0;
  const canSubmit = !submitting && (hasSource || hasBasics);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const apiBase = `${import.meta.env.BASE_URL}api`;
    const rawContent =
      mode === "file"
        ? fileName
          ? `Uploaded file: ${fileName}`
          : ""
        : value;
    const sourceUrl = mode === "link" ? value.trim() : "";

    void fetch(`${apiBase}/intake/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, rawContent, sourceUrl }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Parse failed (${res.status})`);
        return (await res.json()) as {
          projectName?: string;
          address?: string;
          jurisdiction?: string;
          projectType?: string;
          clientName?: string;
          clientEmail?: string;
          clientNotes?: string;
          unverifiedFields?: string[];
          sources?: Array<{ kind: string; label: string }>;
        };
      })
      .then((parsed) => {
        const merged = mergeDraft(mode, {
          projectName: details.projectName || parsed.projectName || "",
          address: details.address || parsed.address || "",
          jurisdiction: details.jurisdiction || parsed.jurisdiction || "",
          projectType: (details.projectType ||
            (parsed.projectType as ProjectTypeValue) ||
            "") as ProjectTypeValue,
          clientName: details.clientName || parsed.clientName || "",
          clientEmail: details.clientEmail || parsed.clientEmail || "",
          clientNotes: details.clientNotes || parsed.clientNotes || "",
        });
        setDraft({
          ...merged,
          unverifiedFields: (parsed.unverifiedFields ?? merged.unverifiedFields) as DraftPreview["unverifiedFields"],
          sources: parsed.sources ?? merged.sources,
        });
      })
      .catch(() => {
        setDraft(mergeDraft(mode, details));
      })
      .finally(() => setSubmitting(false));
  };

  const updateDetails = (patch: Partial<ProjectDetailsForm>) => {
    setDetails((prev) => ({ ...prev, ...patch }));
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
      <div className="intake-card intake-card--wide">
        <header className="intake-header">
          <div className="intake-header-text">
            <span className="cockpit-tab-header-overline">Intake · QA-27</span>
            <h2 id="intake-title" className="intake-title">
              Create a draft project
            </h2>
            <p className="intake-sub">
              Enter what you know about the client and site, add source material,
              then review the merged draft before saving.
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
          <DraftPreviewView
            draft={draft}
            mode={mode}
            sourceExcerpt={mode === "file" ? fileName : value.trim()}
            onDraftChange={setDraft}
            onStartOver={() => setDraft(null)}
            onConfirm={async (finalDraft) => {
              const created = await createEngagement({
                name: finalDraft.projectName,
                address: finalDraft.address || null,
                jurisdiction: finalDraft.jurisdiction || null,
                projectType: finalDraft.projectType || null,
                intakeSource: mode,
                applicantFirm: finalDraft.clientName || null,
                clientEmail: finalDraft.clientEmail || null,
                clientNotes: finalDraft.clientNotes || null,
                sourceExcerpt:
                  mode === "file"
                    ? fileName
                    : value.trim().slice(0, 8000) || null,
              });
              onCreated?.(created.id);
              onClose();
              navigate(
                `/engagements/${created.id}?view=site&segment=property-intel`,
              );
            }}
          />
        ) : (
          <>
            <ProjectDetailsSection
              details={details}
              onChange={updateDetails}
            />

            <div className="intake-source-section">
              <span className="cockpit-tab-header-overline">
                Source material
              </span>
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
                    rows={5}
                    data-testid="intake-input-email"
                  />
                ) : mode === "paste" ? (
                  <textarea
                    className="intake-input intake-textarea"
                    placeholder="Paste the brief, transcript, or scope text…"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    rows={5}
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
                      Optional if you already filled project details above.
                    </span>
                  </label>
                )}
              </div>
            </div>

            <footer className="intake-footer">
              <span className="intake-foot-meta">
                Add project details, source material, or both — nothing is saved
                until you confirm on the next step.
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

function ProjectDetailsSection({
  details,
  onChange,
}: {
  details: ProjectDetailsForm;
  onChange: (patch: Partial<ProjectDetailsForm>) => void;
}) {
  return (
    <section className="intake-details-section" aria-label="Project details">
      <span className="cockpit-tab-header-overline">Project details</span>
      <div className="intake-details-grid">
        <label className="intake-field intake-field--full">
          <span className="intake-field-label">Project name</span>
          <input
            type="text"
            className="intake-input"
            placeholder="e.g. Moab guest house addition"
            value={details.projectName}
            onChange={(e) => onChange({ projectName: e.target.value })}
            data-testid="intake-field-project-name"
          />
        </label>
        <label className="intake-field">
          <span className="intake-field-label">Address</span>
          <input
            type="text"
            className="intake-input"
            placeholder="Street, city, state"
            value={details.address}
            onChange={(e) => onChange({ address: e.target.value })}
            data-testid="intake-field-address"
          />
        </label>
        <label className="intake-field">
          <span className="intake-field-label">Jurisdiction</span>
          <input
            type="text"
            className="intake-input"
            placeholder="County or city"
            value={details.jurisdiction}
            onChange={(e) => onChange({ jurisdiction: e.target.value })}
            data-testid="intake-field-jurisdiction"
          />
        </label>
        <label className="intake-field">
          <span className="intake-field-label">Project type</span>
          <select
            className="intake-input intake-select"
            value={details.projectType}
            onChange={(e) =>
              onChange({
                projectType: e.target.value as ProjectTypeValue,
              })
            }
            data-testid="intake-field-project-type"
          >
            {PROJECT_TYPE_OPTIONS.map((o) => (
              <option key={o.value || "unset"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="intake-field">
          <span className="intake-field-label">Client / firm</span>
          <input
            type="text"
            className="intake-input"
            placeholder="Client or company name"
            value={details.clientName}
            onChange={(e) => onChange({ clientName: e.target.value })}
            data-testid="intake-field-client-name"
          />
        </label>
        <label className="intake-field">
          <span className="intake-field-label">Client email</span>
          <input
            type="email"
            className="intake-input"
            placeholder="contact@example.com"
            value={details.clientEmail}
            onChange={(e) => onChange({ clientEmail: e.target.value })}
            data-testid="intake-field-client-email"
          />
        </label>
        <label className="intake-field intake-field--full">
          <span className="intake-field-label">Client notes</span>
          <textarea
            className="intake-input intake-textarea"
            placeholder="Scope, budget hints, timeline, preferences — anything the client told you."
            value={details.clientNotes}
            onChange={(e) => onChange({ clientNotes: e.target.value })}
            rows={3}
            data-testid="intake-field-client-notes"
          />
        </label>
      </div>
    </section>
  );
}

function DraftPreviewView({
  draft,
  mode,
  sourceExcerpt,
  onDraftChange,
  onStartOver,
  onConfirm,
}: {
  draft: DraftPreview;
  mode: IntakeMode;
  sourceExcerpt: string | null;
  onDraftChange: (next: DraftPreview) => void;
  onStartOver: () => void;
  onConfirm: (finalDraft: DraftPreview) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const patch = (p: Partial<DraftPreview>) => onDraftChange({ ...draft, ...p });

  return (
    <div className="intake-success" data-testid="intake-success">
      <div className="intake-success-head">
        <CheckCircle2 size={18} className="intake-success-icon" />
        <div>
          <div className="intake-success-title">Draft project ready</div>
          <div className="intake-success-sub">
            Edit any field, then create the engagement.
          </div>
          </div>
        <DraftBadge testId="intake-draft-badge" />
      </div>

      <div className="intake-details-grid intake-details-grid--review">
        <EditableField
          label="Project name"
          value={draft.projectName}
          onChange={(v) => patch({ projectName: v })}
          unverified={draft.unverifiedFields.includes("projectName")}
          testId="intake-review-project-name"
        />
        <EditableField
          label="Address"
          value={draft.address}
          onChange={(v) => patch({ address: v })}
          unverified={draft.unverifiedFields.includes("address")}
          testId="intake-review-address"
        />
        <EditableField
          label="Jurisdiction"
          value={draft.jurisdiction}
          onChange={(v) => patch({ jurisdiction: v })}
          unverified={draft.unverifiedFields.includes("jurisdiction")}
          testId="intake-review-jurisdiction"
        />
        <label className="intake-field">
          <span className="intake-field-label">Project type</span>
          <select
            className="intake-input intake-select"
            value={draft.projectType}
            onChange={(e) =>
              patch({ projectType: e.target.value as ProjectTypeValue })
            }
            data-testid="intake-review-project-type"
          >
            {PROJECT_TYPE_OPTIONS.filter((o) => o.value).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {draft.unverifiedFields.includes("projectType") ? (
            <UnverifiedInline />
          ) : null}
        </label>
        <EditableField
          label="Client / firm"
          value={draft.clientName}
          onChange={(v) => patch({ clientName: v })}
          testId="intake-review-client-name"
        />
        <EditableField
          label="Client email"
          value={draft.clientEmail}
          onChange={(v) => patch({ clientEmail: v })}
          testId="intake-review-client-email"
        />
        <label className="intake-field intake-field--full">
          <span className="intake-field-label">Client notes</span>
          <textarea
            className="intake-input intake-textarea"
            value={draft.clientNotes}
            onChange={(e) => patch({ clientNotes: e.target.value })}
            rows={4}
            data-testid="intake-review-client-notes"
          />
        </label>
      </div>

      <div className="intake-source-row">
        <span className="cockpit-tab-header-overline">Sources</span>
        <div className="intake-source-chips">
          {draft.sources.map((s, i) => (
            <SourceChip key={i} kind={s.kind} label={s.label} />
          ))}
        </div>
      </div>

      {sourceExcerpt ? (
        <div className="intake-source-excerpt sc-card">
          <span className="sc-label">Source excerpt</span>
          <p className="intake-source-excerpt-body">{sourceExcerpt}</p>
        </div>
      ) : null}

      <footer className="intake-footer">
        {confirmError ? (
          <span className="intake-foot-meta intake-foot-error">{confirmError}</span>
        ) : (
          <span className="intake-foot-meta">
            {projectTypeLabel(draft.projectType)} · Source: {mode}
          </span>
        )}
        <div className="intake-foot-actions">
          <button type="button" className="sc-btn-ghost" onClick={onStartOver}>
            Start over
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            disabled={confirming || !draft.projectName.trim()}
            data-testid="intake-confirm"
            onClick={() => {
              setConfirming(true);
              setConfirmError(null);
              void onConfirm(draft).catch((err) => {
                setConfirmError(
                  err instanceof Error ? err.message : "Create failed.",
                );
                setConfirming(false);
              });
            }}
          >
            {confirming ? "Creating…" : "Confirm & create engagement"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function EditableField({
  label,
  value,
  onChange,
  unverified = false,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unverified?: boolean;
  testId?: string;
}) {
  return (
    <label className="intake-field">
      <span className="intake-field-label">{label}</span>
      <div className="intake-field-input-row">
        <input
          type="text"
          className="intake-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
        {unverified ? <UnverifiedInline /> : null}
      </div>
    </label>
  );
}

function UnverifiedInline() {
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
