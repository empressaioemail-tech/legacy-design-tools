import { type CSSProperties } from "react";
import type { PresetSpace, WorkspaceComposition } from "../types";

export function SpaceBar({
  presets,
  activePresetId,
  activeTiles,
  layoutId,
  undoLabel,
  savedSpaces,
  onApplyPreset,
  onUndo,
  onOpenPicker,
  onSaveSpace,
  onDeleteSpace,
  onExport,
  exporting,
}: {
  presets: PresetSpace[];
  activePresetId: string;
  activeTiles: string[];
  layoutId: string;
  undoLabel: string | null;
  savedSpaces: Array<{ id: string; label: string }>;
  onApplyPreset: (presetId: string) => void;
  onUndo: () => void;
  onOpenPicker: () => void;
  onSaveSpace: () => void;
  onDeleteSpace: (spaceId: string) => void;
  /**
   * Export the current engagement's deliverable PDF. Supplied by the app
   * (which owns the BFF client) and only present when an engagement is
   * selected — the button renders only when this is defined so the package
   * carries no app-lib dependency.
   */
  onExport?: () => void;
  exporting?: boolean;
}) {
  return (
    <header
      data-testid="space-bar"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "var(--h-space-sm)",
        padding: "10px 16px",
        borderBottom: "1px solid var(--h-border-subtle)",
        background: "var(--h-surface-1)",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, marginRight: 8 }}>
        Cortex Workspace
      </span>
      {presets.map((preset) => {
        const active = preset.id === activePresetId;
        return (
          <button
            key={preset.id}
            type="button"
            data-testid={`preset-${preset.id}`}
            onClick={() => onApplyPreset(preset.id)}
            style={pillStyle(active)}
          >
            {preset.label}
          </button>
        );
      })}
      {savedSpaces.map((space) => {
        const active = space.id === activePresetId;
        return (
          <span
            key={space.id}
            style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
          >
            <button
              type="button"
              data-testid={`preset-${space.id}`}
              onClick={() => onApplyPreset(space.id)}
              style={pillStyle(active)}
            >
              {space.label}
            </button>
            <button
              type="button"
              data-testid={`delete-space-${space.id}`}
              aria-label={`Delete ${space.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSpace(space.id);
              }}
              style={{
                padding: "2px 6px",
                borderRadius: 999,
                border: "1px solid var(--h-border-subtle)",
                background: "transparent",
                color: "var(--h-text-muted)",
                fontSize: 12,
                lineHeight: 1,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </span>
        );
      })}
      <button type="button" onClick={onOpenPicker} style={pillStyle(false)}>
        + Functions
      </button>
      <button type="button" onClick={onSaveSpace} style={pillStyle(false)}>
        Save this space
      </button>
      {onExport ? (
        <button
          type="button"
          data-testid="spacebar-export"
          title="Export deliverable PDF"
          onClick={onExport}
          disabled={exporting}
          style={{
            ...pillStyle(false),
            cursor: exporting ? "not-allowed" : "pointer",
          }}
        >
          {exporting ? "Exporting…" : "↓ Export"}
        </button>
      ) : null}
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: "var(--h-text-muted)" }}>
        {activeTiles.length} tile{activeTiles.length === 1 ? "" : "s"} · layout {layoutId}
      </span>
      {undoLabel ? (
        <button
          type="button"
          data-testid="undo-banner"
          onClick={onUndo}
          style={{
            ...pillStyle(true),
            background: "var(--h-surface-2)",
            color: "var(--h-accent)",
          }}
        >
          ✦ {undoLabel} · Undo
        </button>
      ) : null}
    </header>
  );
}

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: "4px 12px",
    borderRadius: 999,
    border: active
      ? "1px solid var(--h-accent)"
      : "1px solid var(--h-border-subtle)",
    background: active ? "var(--h-surface-2)" : "transparent",
    color: active ? "var(--h-text-primary)" : "var(--h-text-muted)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: active ? "underline" : "none",
    textUnderlineOffset: 3,
  };
}

export type SnapshotState = WorkspaceComposition;

export function snapshotState(
  engagementId: string | undefined,
  tiles: string[],
  layoutId: string,
  why: string,
): SnapshotState {
  return { engagementId, tiles: [...tiles], layoutId, why };
}
