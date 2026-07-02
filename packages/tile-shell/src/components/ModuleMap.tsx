import { useMemo, type CSSProperties } from "react";
import type { TileDef, TileCategory } from "../types";

/**
 * The user persona a module serves. Inferred from category + capability so the
 * mapping is explicit and data-driven from the tile registry — never hand-kept.
 */
export type TilePersona = "reviewer" | "investor" | "architect" | "operator";

const PERSONA_LABELS: Record<TilePersona, string> = {
  reviewer: "Reviewer",
  investor: "Investor",
  architect: "Architect",
  operator: "Operator",
};

/**
 * Persona inference — pure function of the tile's registry fields. Kept in the
 * package so the Module Map and any server-side persona view agree.
 *
 * Rules (first match wins, then category fallback):
 *  - produces.findings / produces.letter / requires.completedFindings → reviewer
 *    (plan-review compliance work).
 *  - Deliverable category → reviewer (letters/exports are the reviewer output).
 *  - Property Intel / Market category → investor (brief, hazard, comps).
 *  - Design Accelerator category, or produces.annotations → architect
 *    (sheets, callouts, BIM/IFC, markup).
 *  - Site Analysis category → architect (topography/drainage feed design).
 *  - Compliance intake/queue (no findings produced) → operator (workflow ops).
 *  - Anything else → operator.
 */
export function personaForTile(t: {
  category: TileCategory;
  requires?: TileDef["requires"];
  produces?: TileDef["produces"];
}): TilePersona {
  const p = t.produces ?? {};
  const r = t.requires ?? {};
  if (p.findings || p.letter || r.completedFindings) return "reviewer";
  if (t.category === "Deliverable") return "reviewer";
  if (t.category === "Property Intel" || t.category === "Market") return "investor";
  if (p.annotations) return "architect";
  if (t.category === "Design Accelerator" || t.category === "Site Analysis")
    return "architect";
  if (t.category === "Compliance") return "operator";
  return "operator";
}

const STATUS_COLORS: Record<string, string> = {
  live: "var(--h-success)",
  degraded: "var(--h-warning)",
  partial: "var(--h-warning)",
  planned: "var(--h-text-muted)",
};

const PERSONA_COLORS: Record<TilePersona, string> = {
  reviewer: "var(--h-accent)",
  investor: "var(--h-success)",
  architect: "var(--h-confidence-asserted)",
  operator: "var(--h-text-link)",
};

/**
 * Module Map surface — lists every tile with what it does, its category,
 * status, requires/produces, mcpTools, and the persona it serves. Reads the
 * live capability registry passed in (the same array served by
 * GET /api/plan-review/admin/tile-registry) so it cannot drift.
 */
export function ModuleMap({
  tiles,
  onClose,
  onAddTile,
}: {
  tiles: TileDef[];
  onClose: () => void;
  onAddTile?: (id: string) => void;
}) {
  const byPersona = useMemo(() => {
    const groups: Record<TilePersona, TileDef[]> = {
      reviewer: [],
      investor: [],
      architect: [],
      operator: [],
    };
    for (const t of tiles) groups[personaForTile(t)].push(t);
    return groups;
  }, [tiles]);

  const order: TilePersona[] = ["reviewer", "investor", "architect", "operator"];

  return (
    <div
      data-testid="module-map"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "var(--h-surface-0)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--h-space-md)",
          padding: "14px 20px",
          borderBottom: "1px solid var(--h-border-subtle)",
          background: "var(--h-surface-1)",
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 800 }}>Module Map</span>
        <span style={{ fontSize: 12, color: "var(--h-text-muted)" }}>
          Every module: what it does, its status, and who uses it. Read from the
          live capability registry.
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--h-text-muted)" }}>
          {tiles.length} modules
        </span>
        <button
          type="button"
          data-testid="module-map-close"
          onClick={onClose}
          style={{
            border: "1px solid var(--h-border-subtle)",
            background: "var(--h-surface-2)",
            color: "var(--h-text-primary)",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            padding: "6px 14px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </header>

      <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
        {order.map((persona) => {
          const group = byPersona[persona];
          if (group.length === 0) return null;
          return (
            <section key={persona} style={{ marginBottom: 28 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: PERSONA_COLORS[persona],
                  }}
                />
                <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
                  {PERSONA_LABELS[persona]}
                </h2>
                <span style={{ fontSize: 12, color: "var(--h-text-muted)" }}>
                  {group.length} module{group.length === 1 ? "" : "s"}
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                  gap: 12,
                }}
              >
                {group.map((t) => (
                  <ModuleCard
                    key={t.id}
                    tile={t}
                    onAdd={onAddTile ? () => onAddTile(t.id) : undefined}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ModuleCard({
  tile,
  onAdd,
}: {
  tile: TileDef;
  onAdd?: () => void;
}) {
  const requires = Object.entries(tile.requires ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  const produces = Object.entries(tile.produces ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  const persona = personaForTile(tile);

  return (
    <div
      data-testid={`module-card-${tile.id}`}
      style={{
        border: "1px solid var(--h-border-subtle)",
        borderRadius: 10,
        background: "var(--h-surface-1)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{tile.label}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: STATUS_COLORS[tile.status] ?? "var(--h-text-muted)",
          }}
        >
          {tile.status}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Chip label={tile.category} />
        <Chip label={PERSONA_LABELS[persona]} tone={PERSONA_COLORS[persona]} />
        {tile.engine ? <Chip label={tile.engine} /> : null}
      </div>
      {tile.degradedReason ? (
        <div style={{ fontSize: 11, color: "var(--h-warning)" }}>
          {tile.degradedReason}
        </div>
      ) : null}
      <Row label="Requires" values={requires.length ? requires : ["—"]} />
      <Row label="Produces" values={produces.length ? produces : ["—"]} />
      <Row
        label="MCP tools"
        values={tile.mcpTools && tile.mcpTools.length ? tile.mcpTools : ["—"]}
        mono
      />
      {onAdd ? (
        <button
          type="button"
          data-testid={`module-add-${tile.id}`}
          onClick={onAdd}
          style={{
            alignSelf: "flex-start",
            marginTop: 4,
            border: "1px solid var(--h-border-subtle)",
            background: "transparent",
            color: "var(--h-text-link)",
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 600,
            padding: "3px 10px",
            cursor: "pointer",
          }}
        >
          + Add to workspace
        </button>
      ) : null}
    </div>
  );
}

function Row({
  label,
  values,
  mono = false,
}: {
  label: string;
  values: string[];
  mono?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span
        style={{
          fontSize: 10,
          color: "var(--h-text-muted)",
          width: 68,
          flexShrink: 0,
          textTransform: "uppercase",
          letterSpacing: 0.3,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--h-text-primary)",
          fontFamily: mono ? "var(--h-font-mono)" : undefined,
          wordBreak: "break-word",
        }}
      >
        {values.join(", ")}
      </span>
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone?: string }) {
  const style: CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 999,
    border: `1px solid ${tone ?? "var(--h-border-subtle)"}`,
    color: tone ?? "var(--h-text-muted)",
    background: "transparent",
  };
  return <span style={style}>{label}</span>;
}
