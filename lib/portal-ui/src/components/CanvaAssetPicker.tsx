/**
 * Multi-select engagement assets for Canva push (stub data).
 *
 * Expected API: GET /api/engagements/:id/canva/assets
 */
import { Image as ImageIcon } from "lucide-react";
import type { CanvaSelectableAsset } from "../canva/types";

const GROUP_LABELS: Record<string, string> = {
  render: "Renders",
  floorplan: "Floor plans",
  sheet: "Sheet exports",
  "site-context": "Site context",
  metadata: "Engagement metadata",
};

export function CanvaAssetPicker({
  assets,
  selectedIds,
  heroAssetId,
  onToggle,
  onHeroChange,
  loading,
}: {
  assets: CanvaSelectableAsset[];
  selectedIds: ReadonlySet<string>;
  heroAssetId: string | null;
  onToggle: (id: string) => void;
  onHeroChange: (id: string) => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="canva-asset-picker" data-testid="canva-asset-picker-loading">
        Loading exportable assets…
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="canva-asset-picker canva-asset-picker--empty" data-testid="canva-asset-picker-empty">
        <ImageIcon size={28} aria-hidden />
        <p className="canva-asset-picker-empty-title">No exportable assets yet</p>
        <p className="canva-asset-picker-empty-body">
          Generate a render or upload a floor plan export (PNG or PDF) first.
        </p>
      </div>
    );
  }

  const groups = groupAssets(assets);

  return (
    <div className="canva-asset-picker" data-testid="canva-asset-picker">
      {groups.map(([kind, rows]) => (
        <section key={kind} className="canva-asset-group" data-testid={`canva-asset-group-${kind}`}>
          <h3 className="canva-asset-group-title">{GROUP_LABELS[kind] ?? kind}</h3>
          <ul className="canva-asset-list">
            {rows.map((asset) => {
              const checked = selectedIds.has(asset.id);
              const disabled = !asset.exportable;
              return (
                <li key={asset.id}>
                  <label
                    className={`canva-asset-row${disabled ? " canva-asset-row--disabled" : ""}${checked ? " canva-asset-row--selected" : ""}`}
                    data-testid={`canva-asset-row-${asset.id}`}
                    title={disabled ? asset.disabledReason : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => onToggle(asset.id)}
                      data-testid={`canva-asset-check-${asset.id}`}
                    />
                    <span className="canva-asset-thumb" aria-hidden>
                      {asset.thumbnailUrl ? (
                        <img src={asset.thumbnailUrl} alt="" />
                      ) : (
                        <ImageIcon size={18} />
                      )}
                    </span>
                    <span className="canva-asset-copy">
                      <span className="canva-asset-label">{asset.label}</span>
                      <span className="canva-asset-meta">{asset.fileType}</span>
                    </span>
                    {asset.exportable && checked && (
                      <span className="canva-asset-hero">
                        <input
                          type="radio"
                          name="canva-hero"
                          checked={heroAssetId === asset.id}
                          onChange={() => onHeroChange(asset.id)}
                          data-testid={`canva-asset-hero-${asset.id}`}
                          aria-label={`Primary hero: ${asset.label}`}
                        />
                        Hero
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupAssets(
  assets: CanvaSelectableAsset[],
): Array<[string, CanvaSelectableAsset[]]> {
  const map = new Map<string, CanvaSelectableAsset[]>();
  for (const a of assets) {
    const list = map.get(a.kind) ?? [];
    list.push(a);
    map.set(a.kind, list);
  }
  return [...map.entries()];
}
