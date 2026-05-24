import { useCallback, useId, useRef, useState } from "react";

export interface DragDropUploadProps {
  accept?: string;
  maxBytes?: number;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  hint?: string;
  testId?: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * doc 40e C.2 — drag-and-drop file picker with click fallback.
 * Used by kickoff source upload, Prompt Generator, and power-tool dialogs.
 */
export function DragDropUpload({
  accept,
  maxBytes,
  disabled = false,
  busy = false,
  label = "Drop an image here",
  hint,
  testId = "drag-drop-upload",
  file,
  onFileChange,
}: DragDropUploadProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const validate = useCallback(
    (candidate: File | null): string | null => {
      if (!candidate) return null;
      if (maxBytes != null && candidate.size > maxBytes) {
        return `File is too large (${formatBytes(candidate.size)}; max ${formatBytes(maxBytes)}).`;
      }
      if (accept) {
        const allowed = accept.split(",").map((s) => s.trim().toLowerCase());
        const name = candidate.name.toLowerCase();
        const type = candidate.type.toLowerCase();
        const ok = allowed.some((a) => {
          if (a.startsWith(".")) return name.endsWith(a);
          if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
          return type === a;
        });
        if (!ok) return "File type is not allowed for this upload.";
      }
      return null;
    },
    [accept, maxBytes],
  );

  const pick = useCallback(
    (candidate: File | null) => {
      const err = validate(candidate);
      setLocalError(err);
      if (err) {
        onFileChange(null);
        return;
      }
      onFileChange(candidate);
    },
    [onFileChange, validate],
  );

  const inactive = disabled || busy;

  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        role="button"
        tabIndex={inactive ? -1 : 0}
        aria-labelledby={inputId}
        data-drag-over={dragOver ? "true" : "false"}
        onKeyDown={(e) => {
          if (inactive) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onClick={() => {
          if (!inactive) inputRef.current?.click();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!inactive) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!inactive) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (inactive) return;
          pick(e.dataTransfer.files?.[0] ?? null);
        }}
        style={{
          border: `1px dashed ${dragOver ? "var(--cyan)" : "var(--border-default)"}`,
          borderRadius: 6,
          padding: 16,
          textAlign: "center",
          cursor: inactive ? "not-allowed" : "pointer",
          background: dragOver ? "rgba(0, 200, 255, 0.06)" : "var(--bg-input)",
          opacity: inactive ? 0.6 : 1,
        }}
      >
        <div id={inputId} className="sc-meta" style={{ color: "var(--text-secondary)" }}>
          {busy ? "Uploading…" : label}
        </div>
        {file ? (
          <div
            className="sc-label"
            style={{ marginTop: 6, color: "var(--text-primary)" }}
            data-testid={`${testId}-filename`}
          >
            {file.name} ({formatBytes(file.size)})
          </div>
        ) : (
          hint && (
            <div className="sc-meta" style={{ marginTop: 4, opacity: 0.7 }}>
              {hint}
            </div>
          )
        )}
      </div>
      <input
        ref={inputRef}
        id={`${inputId}-input`}
        type="file"
        accept={accept}
        disabled={inactive}
        style={{ display: "none" }}
        data-testid={`${testId}-input`}
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />
      {file && !inactive && (
        <button
          type="button"
          className="sc-btn-ghost"
          data-testid={`${testId}-clear`}
          onClick={() => {
            pick(null);
            if (inputRef.current) inputRef.current.value = "";
          }}
          style={{ alignSelf: "flex-start", fontSize: 11 }}
        >
          Clear file
        </button>
      )}
      {localError && (
        <div role="alert" className="sc-meta" style={{ color: "#ef4444" }} data-testid={`${testId}-error`}>
          {localError}
        </div>
      )}
    </div>
  );
}
