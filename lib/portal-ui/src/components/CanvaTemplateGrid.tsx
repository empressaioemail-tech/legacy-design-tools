/**
 * Brand template grid with slot mapping preview (stub).
 *
 * Expected API: GET /api/canva/brand-templates
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type {
  CanvaBrandTemplate,
  CanvaSelectableAsset,
  CanvaTemplateSlot,
} from "../canva/types";

export function CanvaTemplateGrid({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  slotMapping,
  onSlotMappingChange,
  assetsById,
  textFields,
  onTextFieldChange,
}: {
  templates: CanvaBrandTemplate[];
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  slotMapping: Record<string, string>;
  onSlotMappingChange: (slotKey: string, assetId: string) => void;
  assetsById: Map<string, CanvaSelectableAsset>;
  textFields: Record<string, string>;
  onTextFieldChange: (key: string, value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | "all">("all");

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) for (const tg of t.tags) set.add(tg);
    return [...set];
  }, [templates]);

  const filtered = templates.filter((t) => {
    const q = query.trim().toLowerCase();
    const matchesQ =
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.tags.some((tg) => tg.toLowerCase().includes(q));
    const matchesTag = tag === "all" || t.tags.includes(tag);
    return matchesQ && matchesTag;
  });

  const selected = templates.find((t) => t.id === selectedTemplateId) ?? null;

  return (
    <div className="canva-template-grid-wrap" data-testid="canva-template-grid">
      <div className="canva-template-toolbar">
        <label className="canva-template-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            placeholder="Search templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="canva-template-search"
          />
        </label>
        <div className="canva-template-tags">
          <TagChip active={tag === "all"} onClick={() => setTag("all")} label="All" />
          {tags.map((tg) => (
            <TagChip
              key={tg}
              active={tag === tg}
              onClick={() => setTag(tg)}
              label={tg}
            />
          ))}
        </div>
      </div>

      <div className="canva-template-cards">
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`canva-template-card${selectedTemplateId === t.id ? " canva-template-card--selected" : ""}`}
            data-testid={`canva-template-${t.id}`}
            onClick={() => onSelectTemplate(t.id)}
          >
            <img src={t.thumbnailUrl} alt="" className="canva-template-card-thumb" />
            <span className="canva-template-card-name">{t.name}</span>
            <span className="canva-template-card-meta">
              {t.pageCount} pg · {t.tags.join(", ")}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <section className="canva-slot-mapping" data-testid="canva-slot-mapping">
          <h3 className="canva-slot-mapping-title">Field mapping</h3>
          <ul className="canva-slot-list">
            {selected.slots.map((slot) => (
              <SlotRow
                key={slot.key}
                slot={slot}
                assetsById={assetsById}
                slotMapping={slotMapping}
                onSlotMappingChange={onSlotMappingChange}
                textFields={textFields}
                onTextFieldChange={onTextFieldChange}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SlotRow({
  slot,
  assetsById,
  slotMapping,
  onSlotMappingChange,
  textFields,
  onTextFieldChange,
}: {
  slot: CanvaTemplateSlot;
  assetsById: Map<string, CanvaSelectableAsset>;
  slotMapping: Record<string, string>;
  onSlotMappingChange: (slotKey: string, assetId: string) => void;
  textFields: Record<string, string>;
  onTextFieldChange: (key: string, value: string) => void;
}) {
  if (slot.type === "text") {
    return (
      <li className="canva-slot-row" data-testid={`canva-slot-${slot.key}`}>
        <span className="canva-slot-label">{slot.label}</span>
        <input
          type="text"
          className="canva-slot-text-input"
          value={textFields[slot.key] ?? slot.defaultValue ?? ""}
          onChange={(e) => onTextFieldChange(slot.key, e.target.value)}
          data-testid={`canva-slot-text-${slot.key}`}
        />
      </li>
    );
  }

  const options = [...assetsById.values()].filter((a) => {
    if (!a.exportable) return false;
    if (slot.accepts.includes(a.kind as (typeof slot.accepts)[number])) {
      return true;
    }
    return false;
  });

  return (
    <li className="canva-slot-row" data-testid={`canva-slot-${slot.key}`}>
      <span className="canva-slot-label">{slot.label}</span>
      <select
        className="canva-slot-select"
        value={slotMapping[slot.key] ?? ""}
        onChange={(e) => onSlotMappingChange(slot.key, e.target.value)}
        data-testid={`canva-slot-image-${slot.key}`}
      >
        <option value="">Select asset…</option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </li>
  );
}

function TagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`canva-template-tag${active ? " canva-template-tag--active" : ""}`}
      data-active={active ? "true" : "false"}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
