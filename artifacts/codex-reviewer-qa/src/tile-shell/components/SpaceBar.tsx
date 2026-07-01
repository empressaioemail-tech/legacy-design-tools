import { type CSSProperties } from "react";
import type { WorkspaceComposition } from "../types";
import { PRESET_SPACES } from "../presets";

export function SpaceBar({
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
}: {
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
}) {
  return (
    <header
      data-testid="space-bar"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-elevated)",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, marginRight: 8 }}>
        Cortex Workspace
      </span>
      {PRESET_SPACES.map((preset) => {
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
                border: "1px solid var(--border-subtle)",
                background: "transparent",
                color: "var(--text-muted)",
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
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {activeTiles.length} tile{activeTiles.length === 1 ? "" : "s"} · layout {layoutId}
      </span>
      {undoLabel ? (
        <button
          type="button"
          data-testid="undo-banner"
          onClick={onUndo}
          style={{
            ...pillStyle(true),
            background: "var(--info-dim)",
            color: "var(--info-text)",
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
      ? "1px solid var(--accent, var(--info-text))"
      : "1px solid var(--border-subtle)",
    background: active ? "var(--info-dim)" : "transparent",
    color: active ? "var(--text-primary, #e2edf5)" : "var(--text-secondary)",
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
