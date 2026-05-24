/**
 * Visualization settings + primary CTA for floor plan mode.
 */
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  FLOOR_PLAN_PRESET_META,
  type FloorPlanVizPreset,
} from "../floor-plan-viz/types";

const DEFAULT_PROMPT =
  "Furnished interior floor plan, photoreal top-down 3D visualization, natural lighting";

export function FloorPlanVizControls({
  preset = "standard-3d",
  prompt,
  onPromptChange,
  onGenerate,
  generating,
  canGenerate,
  creditsEstimate = "~3 credits",
}: {
  preset?: FloorPlanVizPreset;
  prompt: string;
  onPromptChange: (next: string) => void;
  onGenerate: () => void;
  generating?: boolean;
  canGenerate: boolean;
  creditsEstimate?: string;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const meta = FLOOR_PLAN_PRESET_META[preset];

  return (
    <section className="fpviz-controls" data-testid="fpviz-controls">
      <article className="fpviz-preset-card" data-testid="fpviz-preset-standard">
        <h3 className="fpviz-preset-label">{meta.label}</h3>
        <p className="fpviz-preset-desc sc-meta">{meta.description}</p>
      </article>

      <button
        type="button"
        className="fpviz-advanced-toggle sc-btn-ghost sc-btn-sm"
        data-testid="fpviz-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        Advanced
        {advancedOpen ? (
          <ChevronUp size={14} aria-hidden />
        ) : (
          <ChevronDown size={14} aria-hidden />
        )}
      </button>

      {advancedOpen ? (
        <section className="fpviz-advanced" data-testid="fpviz-advanced-panel">
          <label className="fpviz-field-label" htmlFor="fpviz-prompt">
            Prompt
          </label>
          <textarea
            id="fpviz-prompt"
            className="fpviz-prompt-input"
            data-testid="fpviz-prompt-input"
            value={prompt}
            maxLength={2000}
            rows={4}
            onChange={(e) => onPromptChange(e.target.value)}
          />
          <footer className="fpviz-prompt-footer sc-meta">
            <span data-testid="fpviz-prompt-count">{prompt.length}/2000</span>
            <button
              type="button"
              className="sc-btn-ghost sc-btn-sm"
              data-testid="fpviz-generate-prompt"
              onClick={() => onPromptChange(DEFAULT_PROMPT)}
            >
              <Sparkles size={12} aria-hidden /> Reset prompt
            </button>
          </footer>

          <label className="fpviz-field-label" htmlFor="fpviz-seed">
            Seed
          </label>
          <input
            id="fpviz-seed"
            className="fpviz-seed-input"
            data-testid="fpviz-seed-input"
            placeholder="Random"
            disabled
            title="Optional seed — backend hook"
          />

          <p className="fpviz-field-label">Reference images (0–4)</p>
          <ul className="fpviz-ref-slots" data-testid="fpviz-ref-slots">
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>
                <button
                  type="button"
                  className="fpviz-ref-slot"
                  data-testid={`fpviz-ref-slot-${i}`}
                  disabled
                  title="Guide style with reference photos — coming soon"
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="fpviz-cta-row">
        <button
          type="button"
          className="sc-btn-primary"
          data-testid="fpviz-visualize-cta"
          disabled={!canGenerate || generating}
          onClick={onGenerate}
        >
          {generating ? "Generating…" : "Visualize floor plan"}
        </button>
        <span className="fpviz-credits sc-meta" data-testid="fpviz-credits-estimate">
          {creditsEstimate}
        </span>
      </footer>
      <p className="fpviz-powered sc-meta">Powered by AI rendering</p>
    </section>
  );
}
