import type { CSSProperties } from "react";

/**
 * Workspace mode toolbar: edit/view fuse toggle, grid/list layout toggle, a
 * floating-pane count indicator, and the Module Map entry point. Sits below the
 * SpaceBar so the mode controls are discoverable without crowding the presets.
 */
export function ShellToolbar({
  editing,
  onToggleEditing,
  layoutMode,
  onLayoutModeChange,
  floatCount,
  onOpenModuleMap,
}: {
  editing: boolean;
  onToggleEditing: () => void;
  layoutMode: "grid" | "list";
  onLayoutModeChange: (mode: "grid" | "list") => void;
  floatCount: number;
  onOpenModuleMap: () => void;
}) {
  return (
    <div
      data-testid="shell-toolbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--h-space-sm)",
        padding: "6px 16px",
        borderBottom: "1px solid var(--h-border-subtle)",
        background: "var(--h-surface-0)",
      }}
    >
      <Segmented
        label="Mode"
        value={editing ? "edit" : "view"}
        options={[
          { id: "view", label: "View" },
          { id: "edit", label: "Edit" },
        ]}
        onChange={(v) => {
          if ((v === "edit") !== editing) onToggleEditing();
        }}
        testid="mode-toggle"
      />
      <Segmented
        label="Layout"
        value={layoutMode}
        options={[
          { id: "grid", label: "Grid" },
          { id: "list", label: "List" },
        ]}
        onChange={(v) => onLayoutModeChange(v as "grid" | "list")}
        testid="layout-toggle"
      />
      {floatCount > 0 ? (
        <span
          data-testid="float-count"
          style={{ fontSize: 11, color: "var(--h-text-muted)" }}
        >
          {floatCount} floating
        </span>
      ) : null}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        data-testid="open-module-map"
        onClick={onOpenModuleMap}
        style={{
          border: "1px solid var(--h-border-subtle)",
          background: "var(--h-surface-2)",
          color: "var(--h-text-primary)",
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 600,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        ▤ Module Map
      </button>
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
  testid,
}: {
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
  testid: string;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "var(--h-text-muted)" }}>{label}</span>
      <span
        data-testid={testid}
        style={{
          display: "inline-flex",
          border: "1px solid var(--h-border-subtle)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {options.map((o) => {
          const active = o.id === value;
          const style: CSSProperties = {
            border: "none",
            padding: "4px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            background: active ? "var(--h-accent)" : "transparent",
            color: active ? "#fff" : "var(--h-text-muted)",
          };
          return (
            <button
              key={o.id}
              type="button"
              data-testid={`${testid}-${o.id}`}
              onClick={() => onChange(o.id)}
              style={style}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}
