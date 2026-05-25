/**
 * Source floor plan picker for 2D → 3D visualization.
 */
import { useRef } from "react";
import { Upload } from "lucide-react";
import type { FloorPlanVizSource } from "../floor-plan-viz/types";

const KIND_LABEL: Record<FloorPlanVizSource["kind"], string> = {
  upload: "Upload plan",
  sheet: "From sheets",
  snapshot: "From snapshots",
  "prior-render": "Use prior output",
};

const ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

export function FloorPlanSourcePicker({
  sources,
  selectedId,
  onSelect,
  onUploadFile,
  loading,
  uploading,
}: {
  sources: FloorPlanVizSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUploadFile?: (file: File) => void;
  loading?: boolean;
  uploading?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  if (loading) {
    return (
      <div className="fpviz-source-picker" data-testid="fpviz-source-loading">
        Loading floor plan sources…
      </div>
    );
  }

  const selected = sources.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="fpviz-source-picker" data-testid="fpviz-source-picker">
      <div className="fpviz-source-actions">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="fpviz-source-file-input"
          data-testid="fpviz-upload-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && onUploadFile) onUploadFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="sc-btn-primary sc-btn-sm fpviz-upload-btn"
          data-testid="fpviz-upload-plan"
          disabled={uploading || !onUploadFile}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={14} aria-hidden /> Upload floor plan
        </button>
      </div>

      {sources.length === 0 ? (
        <div className="fpviz-source-empty" data-testid="fpviz-source-empty">
          <p className="fpviz-source-empty-title">No floor plan selected</p>
          <p className="fpviz-source-empty-body">
            Upload a plan or choose one from sheets.
          </p>
        </div>
      ) : (
        <ul className="fpviz-source-list">
          {sources.map((source) => {
            const active = source.id === selectedId;
            const disabled = Boolean(source.disabled);
            return (
              <li key={source.id}>
                <button
                  type="button"
                  className={`fpviz-source-row${active ? " fpviz-source-row--active" : ""}${disabled ? " fpviz-source-row--disabled" : ""}`}
                  data-testid={`fpviz-source-${source.id}`}
                  title={disabled ? source.disabledReason : undefined}
                  disabled={disabled}
                  onClick={() => onSelect(source.id)}
                >
                  <img src={source.thumbnailUrl} alt="" className="fpviz-source-thumb" />
                  <span className="fpviz-source-copy">
                    <span className="fpviz-source-kind">{KIND_LABEL[source.kind]}</span>
                    <span className="fpviz-source-label">{source.label}</span>
                    <span className="fpviz-source-meta">
                      {source.fileFormat.toUpperCase()}
                      {source.dimensionsLabel ? ` · ${source.dimensionsLabel}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected ? (
        <div className="fpviz-source-preview" data-testid="fpviz-source-preview">
          <span className="fpviz-badge fpviz-badge--before">2D plan</span>
          <img src={selected.previewUrl} alt={selected.label} />
          <div className="fpviz-source-preview-meta sc-meta">
            <span>{selected.label}</span>
            {selected.fileSizeLabel ? <span>{selected.fileSizeLabel}</span> : null}
          </div>
        </div>
      ) : (
        <div
          className="fpviz-source-preview fpviz-source-preview--empty"
          data-testid="fpviz-source-preview-empty"
        >
          Select a floor plan to preview
        </div>
      )}
    </div>
  );
}
