import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListEngagementRendersQueryKey,
  getGetRenderCreditsQueryKey,
  type RenderListItem,
  type RenderOutputProjection,
} from "@workspace/api-client-react";
import { MaskCanvas } from "../MaskCanvas";
import { DragDropUpload } from "../DragDropUpload";
import {
  kickoffPowerTool,
  type PowerToolKind,
} from "./powerToolKickoff";

export interface RenderPowerToolDialogProps {
  engagementId: string;
  parentOutput: RenderOutputProjection;
  previewUrl: string;
  tool: PowerToolKind;
  isOpen: boolean;
  onClose: () => void;
  onKickedOff?: (renderId: string) => void;
}

const TOOL_LABEL: Record<PowerToolKind, string> = {
  enhance: "Render Enhancer",
  upscale: "4K Upscaler",
  erase: "AI Eraser",
  inpaint: "Inpaint",
  style_transfer: "Style Transfer",
};

export function RenderPowerToolDialog({
  engagementId,
  parentOutput,
  previewUrl,
  tool,
  isOpen,
  onClose,
  onKickedOff,
}: RenderPowerToolDialogProps) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [scale, setScale] = useState<"2" | "4" | "8">("2");
  const [maskBlob, setMaskBlob] = useState<Blob | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);

  if (!isOpen) return null;

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      if (tool === "enhance" || tool === "inpaint" || tool === "style_transfer") {
        if (!prompt.trim()) {
          setError("Prompt is required.");
          setBusy(false);
          return;
        }
        form.append("prompt", prompt.trim());
      }
      if (tool === "inpaint" && negativePrompt.trim()) {
        form.append("negative_prompt", negativePrompt.trim());
      }
      if (tool === "upscale") {
        form.append("scale", scale);
      }
      if ((tool === "erase" || tool === "inpaint") && maskBlob) {
        form.append("mask", maskBlob, "mask.png");
      }
      if (tool === "style_transfer" && referenceFile) {
        form.append("reference_image", referenceFile);
      }
      const res = await kickoffPowerTool(parentOutput.id, tool, form);
      const optimistic: RenderListItem = {
        id: res.renderId,
        kind: res.kind,
        status: res.state,
        sourceType: res.sourceType,
        parentRenderOutputId: res.parentRenderOutputId,
        errorCode: null,
        requestedBy: "user:current",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      };
      const listKey = getListEngagementRendersQueryKey(engagementId);
      qc.setQueryData<{ items: RenderListItem[] } | undefined>(listKey, (prev) => {
        if (!prev) return { items: [optimistic] };
        if (prev.items.some((r) => r.id === optimistic.id)) return prev;
        return { items: [optimistic, ...prev.items] };
      });
      await qc.invalidateQueries({ queryKey: listKey });
      qc.invalidateQueries({ queryKey: getGetRenderCreditsQueryKey() });
      onKickedOff?.(res.renderId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tool kickoff failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      data-testid={`render-power-tool-dialog-${tool}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="sc-card"
        style={{
          width: "min(560px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="sc-label" style={{ margin: 0, fontWeight: 600 }}>
            {TOOL_LABEL[tool]}
          </h3>
          <button type="button" className="sc-btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {(tool === "erase" || tool === "inpaint") && (
          <MaskCanvas
            imageUrl={previewUrl}
            disabled={busy}
            onMaskChange={setMaskBlob}
            testId={`power-tool-mask-${tool}`}
          />
        )}

        {(tool === "enhance" || tool === "inpaint" || tool === "style_transfer") && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-meta">Prompt</span>
            <textarea
              className="sc-ui"
              rows={3}
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="power-tool-prompt"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 8,
                fontSize: 12.5,
              }}
            />
          </label>
        )}

        {tool === "inpaint" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-meta">Negative prompt (optional)</span>
            <textarea
              className="sc-ui"
              rows={2}
              value={negativePrompt}
              disabled={busy}
              onChange={(e) => setNegativePrompt(e.target.value)}
              data-testid="power-tool-negative-prompt"
              style={{
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 8,
                fontSize: 12.5,
              }}
            />
          </label>
        )}

        {tool === "upscale" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-meta">Scale</span>
            <select
              className="sc-ui"
              value={scale}
              disabled={busy}
              onChange={(e) => setScale(e.target.value as "2" | "4" | "8")}
              data-testid="power-tool-scale"
            >
              <option value="2">2×</option>
              <option value="4">4×</option>
              <option value="8">8×</option>
            </select>
          </label>
        )}

        {tool === "style_transfer" && (
          <DragDropUpload
            label="Drop reference style image"
            accept="image/png,image/jpeg,image/webp"
            maxBytes={10 * 1024 * 1024}
            file={referenceFile}
            onFileChange={setReferenceFile}
            disabled={busy}
            testId="power-tool-reference-upload"
          />
        )}

        {error && (
          <div role="alert" className="sc-meta" style={{ color: "#ef4444" }}>
            {error}
          </div>
        )}

        <div className="flex justify-end" style={{ gap: 8 }}>
          <button type="button" className="sc-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="sc-btn-primary"
            disabled={busy}
            onClick={handleSubmit}
            data-testid="power-tool-submit"
          >
            {busy ? "Starting…" : "Run tool"}
          </button>
        </div>
      </div>
    </div>
  );
}
