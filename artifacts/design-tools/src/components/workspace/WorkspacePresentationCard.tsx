import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import {
  COVER_TEMPLATE_OPTIONS,
  PDF_WATERMARK_OPTIONS,
  type CoverTemplateId,
  type PdfWatermarkId,
  type WorkspacePreferencesWire,
} from "../../lib/workspacePreferences";
import { patchWorkspaceSettings } from "../../lib/workspaceSettingsApi";
import { useInvalidateWorkspaceSettings } from "../../lib/useWorkspaceSettings";

const COVER_PREVIEW_ACCENT: Record<CoverTemplateId, string> = {
  "cockpit-cyan": "#00b4d8",
  "minimal-dark": "#0d0d0d",
  "minimal-light": "#0284c7",
};

export function WorkspacePresentationCard({
  preferences,
}: {
  preferences: WorkspacePreferencesWire | undefined;
}) {
  const invalidate = useInvalidateWorkspaceSettings();
  const [coverTemplate, setCoverTemplate] =
    useState<CoverTemplateId>("cockpit-cyan");
  const [pdfWatermark, setPdfWatermark] = useState<PdfWatermarkId>("standard");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!preferences) return;
    setCoverTemplate(preferences.presentation.coverTemplate);
    setPdfWatermark(preferences.presentation.pdfWatermark);
  }, [preferences]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await patchWorkspaceSettings({
        preferences: {
          presentation: { coverTemplate, pdfWatermark },
        },
      });
      await invalidate();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const previewAccent = COVER_PREVIEW_ACCENT[coverTemplate];

  return (
    <article
      className="workspace-card"
      data-testid="workspace-presentation-card"
    >
      <header className="workspace-card-head">
        <span className="workspace-card-icon">
          <ImageIcon size={14} />
        </span>
        <h2 className="workspace-card-title">Presentation defaults</h2>
      </header>
      <p className="sc-meta mb-1">Cover template (stakeholder PDF)</p>
      <div className="flex flex-wrap gap-1 mb-2">
        {COVER_TEMPLATE_OPTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            data-testid={`workspace-cover-${id}`}
            onClick={() => setCoverTemplate(id)}
            className="workspace-chip"
            data-active={coverTemplate === id ? "true" : "false"}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="rounded border border-[var(--border-subtle)] p-3 mb-3"
        data-testid="workspace-cover-preview"
        style={{ background: "var(--bg-elevated)" }}
      >
        <p
          className="text-lg font-semibold m-0"
          style={{ color: previewAccent }}
        >
          Stakeholder Briefing
        </p>
        <p className="sc-meta m-0 mt-1 opacity-60">Cover title accent preview</p>
      </div>
      <p className="sc-meta mb-1">PDF footer watermark</p>
      <select
        className="sc-input mb-2"
        value={pdfWatermark}
        onChange={(e) => setPdfWatermark(e.target.value as PdfWatermarkId)}
        data-testid="workspace-pdf-watermark"
      >
        {PDF_WATERMARK_OPTIONS.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="sc-btn-primary sc-btn-sm workspace-card-cta"
        disabled={saving}
        onClick={() => void handleSave()}
        data-testid="workspace-presentation-save"
      >
        {saving ? "Saving…" : "Save presentation"}
      </button>
      {saved && (
        <span className="sc-meta" style={{ color: "var(--success-text)" }}>
          Saved.
        </span>
      )}
      {error && (
        <span className="sc-meta" style={{ color: "var(--danger-text)" }}>
          {error}
        </span>
      )}
    </article>
  );
}
