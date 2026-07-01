import { useState, type CSSProperties } from "react";
import type { WorkspaceComposition } from "../types";
import { PRESET_SPACES } from "../presets";

export function SpaceBar({
  activeTiles,
  layoutId,
  undoLabel,
  onApplyPreset,
  onUndo,
  onOpenPicker,
  onSaveSpace,
}: {
  activeTiles: string[];
  layoutId: string;
  undoLabel: string | null;
  onApplyPreset: (presetId: string) => void;
  onUndo: () => void;
  onOpenPicker: () => void;
  onSaveSpace: () => void;
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
      {PRESET_SPACES.map((preset) => (
        <button
          key={preset.id}
          type="button"
          data-testid={`preset-${preset.id}`}
          onClick={() => onApplyPreset(preset.id)}
          style={pillStyle(false)}
        >
          {preset.label}
        </button>
      ))}
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
    border: "1px solid var(--border-subtle)",
    background: active ? "var(--info-dim)" : "transparent",
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
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
