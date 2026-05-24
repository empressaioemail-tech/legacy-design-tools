/**
 * Supported floor plan upload formats — enabled badges + disabled CAD hints.
 */
const ENABLED = ["PNG", "JPEG", "WebP", "PDF"] as const;
const DISABLED = [
  { label: "DXF", reason: "Export to PNG or PDF first" },
  { label: "DWG", reason: "Export to PNG or PDF first" },
] as const;

export function FloorPlanFormatBadges() {
  return (
    <div className="fpviz-format-badges" data-testid="fpviz-format-badges">
      {ENABLED.map((fmt) => (
        <span key={fmt} className="fpviz-format-badge fpviz-format-badge--enabled">
          {fmt}
        </span>
      ))}
      {DISABLED.map(({ label, reason }) => (
        <span
          key={label}
          className="fpviz-format-badge fpviz-format-badge--disabled"
          title={reason}
          data-testid={`fpviz-format-disabled-${label.toLowerCase()}`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
