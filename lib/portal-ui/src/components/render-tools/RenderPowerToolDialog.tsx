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

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  testId: string;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="sc-meta">
        {label} ({value})
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </label>
  );
}

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
  const [faceEnhance, setFaceEnhance] = useState(false);
  const [outputFormat, setOutputFormat] = useState<"png" | "jpg" | "jpeg">("png");
  const [maskType, setMaskType] = useState<"manual" | "automatic">("manual");
  const [seed, setSeed] = useState("");
  const [geometry, setGeometry] = useState(1);
  const [creativity, setCreativity] = useState(0.3);
  const [dynamic, setDynamic] = useState(5);
  const [sharpen, setSharpen] = useState(0.5);
  const [strength, setStrength] = useState(0.65);
  const [colorPreservation, setColorPreservation] = useState(0.5);
  const [preserveStructure, setPreserveStructure] = useState(true);
  const [maskBlob, setMaskBlob] = useState<Blob | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);

  if (!isOpen) return null;

  async function loadParentImageFile(): Promise<File> {
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error("Could not load parent render image.");
    const blob = await res.blob();
    const ext = blob.type.includes("png") ? "png" : "jpg";
    return new File([blob], `parent.${ext}`, { type: blob.type || "image/png" });
  }

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("image", await loadParentImageFile());

      if (tool === "enhance" || tool === "inpaint" || tool === "style_transfer") {
        if (!prompt.trim()) {
          setError("Prompt is required.");
          setBusy(false);
          return;
        }
        form.append("prompt", prompt.trim());
      }

      if (tool === "enhance") {
        form.append("geometry", String(geometry));
        form.append("creativity", String(creativity));
        form.append("dynamic", String(dynamic));
        form.append("sharpen", String(sharpen));
        if (seed.trim()) form.append("seed", seed.trim());
      }

      if (tool === "inpaint") {
        if (negativePrompt.trim()) {
          form.append("negative_prompt", negativePrompt.trim());
        }
        form.append("mask_type", maskType);
        if (seed.trim()) form.append("seed", seed.trim());
      }

      if (tool === "upscale") {
        form.append("scale", scale);
        form.append("face_enhance", faceEnhance ? "true" : "false");
      }

      if (tool === "erase") {
        if (!maskBlob) {
          setError("Draw a mask on the region to erase.");
          setBusy(false);
          return;
        }
        form.append("output_format", outputFormat);
      }

      if ((tool === "erase" || tool === "inpaint") && maskBlob) {
        form.append("mask", maskBlob, "mask.png");
      }

      if (tool === "inpaint" && maskType === "manual" && !maskBlob) {
        setError("Draw a mask for manual inpaint.");
        setBusy(false);
        return;
      }

      if (tool === "style_transfer") {
        if (!referenceFile) {
          setError("Reference style image is required.");
          setBusy(false);
          return;
        }
        form.append("reference_image", referenceFile);
        form.append("strength", String(strength));
        form.append("color_preservation", String(colorPreservation));
        form.append("preserve_structure", preserveStructure ? "true" : "false");
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

        {(tool === "erase" || tool === "inpaint") && maskType === "manual" && (
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

        {tool === "enhance" && (
          <>
            <ParamSlider
              label="Geometry"
              value={geometry}
              min={0}
              max={1}
              step={0.05}
              disabled={busy}
              testId="power-tool-geometry"
              onChange={setGeometry}
            />
            <ParamSlider
              label="Creativity"
              value={creativity}
              min={0}
              max={1}
              step={0.05}
              disabled={busy}
              testId="power-tool-creativity"
              onChange={setCreativity}
            />
            <ParamSlider
              label="Dynamic"
              value={dynamic}
              min={0}
              max={10}
              step={0.5}
              disabled={busy}
              testId="power-tool-dynamic"
              onChange={setDynamic}
            />
            <ParamSlider
              label="Sharpen"
              value={sharpen}
              min={0}
              max={1}
              step={0.05}
              disabled={busy}
              testId="power-tool-sharpen"
              onChange={setSharpen}
            />
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sc-meta">Seed (optional)</span>
              <input
                type="number"
                className="sc-ui"
                value={seed}
                disabled={busy}
                placeholder="Random"
                data-testid="power-tool-seed"
                onChange={(e) => setSeed(e.target.value)}
                style={{
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 12.5,
                }}
              />
            </label>
          </>
        )}

        {tool === "inpaint" && (
          <>
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
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sc-meta">Mask type</span>
              <select
                className="sc-ui"
                value={maskType}
                disabled={busy}
                data-testid="power-tool-mask-type"
                onChange={(e) =>
                  setMaskType(e.target.value as "manual" | "automatic")
                }
              >
                <option value="manual">Manual (draw mask)</option>
                <option value="automatic">Automatic</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sc-meta">Seed (optional)</span>
              <input
                type="number"
                className="sc-ui"
                value={seed}
                disabled={busy}
                placeholder="Random"
                data-testid="power-tool-inpaint-seed"
                onChange={(e) => setSeed(e.target.value)}
                style={{
                  background: "var(--bg-input)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 12.5,
                }}
              />
            </label>
          </>
        )}

        {tool === "upscale" && (
          <>
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
            <label className="sc-meta flex items-center gap-2">
              <input
                type="checkbox"
                checked={faceEnhance}
                disabled={busy}
                data-testid="power-tool-face-enhance"
                onChange={(e) => setFaceEnhance(e.target.checked)}
              />
              Face enhance
            </label>
          </>
        )}

        {tool === "erase" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="sc-meta">Output format</span>
            <select
              className="sc-ui"
              value={outputFormat}
              disabled={busy}
              data-testid="power-tool-output-format"
              onChange={(e) =>
                setOutputFormat(e.target.value as "png" | "jpg" | "jpeg")
              }
            >
              <option value="png">PNG</option>
              <option value="jpg">JPG</option>
              <option value="jpeg">JPEG</option>
            </select>
          </label>
        )}

        {tool === "style_transfer" && (
          <>
            <DragDropUpload
              label="Drop reference style image"
              accept="image/png,image/jpeg,image/webp"
              maxBytes={10 * 1024 * 1024}
              file={referenceFile}
              onFileChange={setReferenceFile}
              disabled={busy}
              testId="power-tool-reference-upload"
            />
            <ParamSlider
              label="Strength"
              value={strength}
              min={0}
              max={1}
              step={0.05}
              disabled={busy}
              testId="power-tool-strength"
              onChange={setStrength}
            />
            <ParamSlider
              label="Color preservation"
              value={colorPreservation}
              min={0}
              max={1}
              step={0.05}
              disabled={busy}
              testId="power-tool-color-preservation"
              onChange={setColorPreservation}
            />
            <label className="sc-meta flex items-center gap-2">
              <input
                type="checkbox"
                checked={preserveStructure}
                disabled={busy}
                data-testid="power-tool-preserve-structure"
                onChange={(e) => setPreserveStructure(e.target.checked)}
              />
              Preserve structure
            </label>
          </>
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
