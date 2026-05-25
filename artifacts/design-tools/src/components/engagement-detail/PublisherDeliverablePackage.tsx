import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useGetSnapshotSheets,
  getGetSnapshotSheetsQueryKey,
  useListEngagementRenders,
  getListEngagementRendersQueryKey,
  type RenderListItem,
  type SheetSummary,
} from "@workspace/api-client-react";
import {
  Download,
  FileSpreadsheet,
  Film,
  ImageIcon,
  Layers,
  Package,
} from "lucide-react";
import type { TabId } from "./urlState";
import type { PublisherPackageManifestItem, PublisherPackageSelection } from "./publisherIntake/packageTypes";
import { emptyPublisherPackageSelection } from "./publisherIntake/packageTypes";
import type { PublisherIntakeForm } from "./publisherIntake/types";
import type { PackageSelection } from "./packages/types";
import { exportDeliverablePackage } from "./publisherIntake/exportDeliverablePackage";

const PACKAGE_STORAGE_PREFIX = "publisher-package-v1:";

function packageStorageKey(engagementId: string): string {
  return `${PACKAGE_STORAGE_PREFIX}${engagementId}`;
}

function loadPackageSelection(
  engagementId: string,
): PublisherPackageSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(packageStorageKey(engagementId));
    if (!raw) return null;
    return JSON.parse(raw) as PublisherPackageSelection;
  } catch {
    return null;
  }
}

function persistPackageSelection(
  engagementId: string,
  selection: PublisherPackageSelection,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    packageStorageKey(engagementId),
    JSON.stringify(selection),
  );
}

function renderLabel(item: RenderListItem): string {
  const kind =
    item.kind === "video"
      ? "Video"
      : item.kind === "elevation-set"
        ? "Elevation set"
        : "Still render";
  const date = new Date(item.createdAt).toLocaleDateString("en-US");
  return `${kind} · ${date}`;
}

function sheetLabel(sheet: SheetSummary): string {
  return `${sheet.sheetNumber} — ${sheet.sheetName}`;
}

function selectionFromPackage(
  pkgSelection: PackageSelection | null | undefined,
): PublisherPackageSelection | null {
  if (!pkgSelection) return null;
  return {
    includeIntake: pkgSelection.includeIntake ?? true,
    renderIds: pkgSelection.renderIds ?? [],
    videoIds: pkgSelection.videoIds ?? [],
    sheetIds: pkgSelection.sheetIds ?? [],
  };
}

export function PublisherDeliverablePackage({
  engagementId,
  snapshotId,
  engagementName,
  form,
  completionPct,
  autoFilledCount,
  onNavigate,
  hideIntakeLane = false,
  packageSelection,
  onSelectionPersist,
}: {
  engagementId: string;
  snapshotId: string | null;
  engagementName: string;
  form: PublisherIntakeForm;
  completionPct: number;
  autoFilledCount: number;
  onNavigate?: (tab: TabId) => void;
  hideIntakeLane?: boolean;
  packageSelection?: PackageSelection | null;
  onSelectionPersist?: (selection: PublisherPackageSelection) => Promise<void>;
}) {
  const rendersQuery = useListEngagementRenders(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListEngagementRendersQueryKey(engagementId),
    },
  });

  const sheetsQuery = useGetSnapshotSheets(snapshotId ?? "", {
    query: {
      enabled: !!snapshotId,
      queryKey: getGetSnapshotSheetsQueryKey(snapshotId ?? ""),
    },
  });

  const renderItems = rendersQuery.data?.items ?? [];
  const readyStills = useMemo(
    () =>
      renderItems.filter(
        (r) => r.status === "ready" && r.kind !== "video",
      ),
    [renderItems],
  );
  const readyVideos = useMemo(
    () => renderItems.filter((r) => r.status === "ready" && r.kind === "video"),
    [renderItems],
  );
  const sheets = sheetsQuery.data ?? [];

  const [selection, setSelection] = useState<PublisherPackageSelection>(
    emptyPublisherPackageSelection,
  );
  const [packageInitialized, setPackageInitialized] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    setPackageInitialized(false);
    const fromApi = selectionFromPackage(packageSelection);
    if (fromApi) {
      setSelection(fromApi);
      setPackageInitialized(true);
      return;
    }
    const persisted = loadPackageSelection(engagementId);
    if (persisted) {
      setSelection(persisted);
      setPackageInitialized(true);
    } else {
      setSelection(emptyPublisherPackageSelection());
    }
  }, [engagementId, packageSelection]);

  useEffect(() => {
    if (packageInitialized) return;
    const fromApi = selectionFromPackage(packageSelection);
    if (fromApi) return;
    const persisted = loadPackageSelection(engagementId);
    if (persisted) return;
    if (rendersQuery.isLoading) return;
    if (snapshotId && sheetsQuery.isLoading) return;
    setSelection({
      includeIntake: true,
      renderIds: readyStills.map((r) => r.id),
      videoIds: readyVideos.map((r) => r.id),
      sheetIds: sheets.map((s) => s.id),
    });
    setPackageInitialized(true);
  }, [
    engagementId,
    packageInitialized,
    packageSelection,
    readyStills,
    readyVideos,
    sheets,
    rendersQuery.isLoading,
    sheetsQuery.isLoading,
    snapshotId,
  ]);

  useEffect(() => {
    if (!packageInitialized) return;
    if (onSelectionPersist) {
      const timer = window.setTimeout(() => {
        void onSelectionPersist(selection);
      }, 600);
      return () => window.clearTimeout(timer);
    }
    persistPackageSelection(engagementId, selection);
    return undefined;
  }, [engagementId, selection, packageInitialized, onSelectionPersist]);

  const toggleId = useCallback(
    (key: "renderIds" | "videoIds" | "sheetIds", id: string) => {
      setSelection((prev) => {
        const list = prev[key];
        const next = list.includes(id)
          ? list.filter((x) => x !== id)
          : [...list, id];
        return { ...prev, [key]: next };
      });
    },
    [],
  );

  const selectAllInLane = useCallback(
    (key: "renderIds" | "videoIds" | "sheetIds", ids: string[]) => {
      setSelection((prev) => ({ ...prev, [key]: ids }));
    },
    [],
  );

  const manifestItems = useMemo((): PublisherPackageManifestItem[] => {
    const items: PublisherPackageManifestItem[] = [];
    for (const id of selection.renderIds) {
      const r = renderItems.find((x) => x.id === id);
      if (r) {
        items.push({
          type: "rendering",
          id: r.id,
          label: renderLabel(r),
          status: r.status,
          kind: r.kind,
        });
      }
    }
    for (const id of selection.videoIds) {
      const r = renderItems.find((x) => x.id === id);
      if (r) {
        items.push({
          type: "video",
          id: r.id,
          label: renderLabel(r),
          status: r.status,
          kind: r.kind,
        });
      }
    }
    for (const id of selection.sheetIds) {
      const s = sheets.find((x) => x.id === id);
      if (s) {
        items.push({
          type: "plan",
          id: s.id,
          label: sheetLabel(s),
        });
      }
    }
    return items;
  }, [renderItems, selection, sheets]);

  const selectedCount =
    manifestItems.length + (selection.includeIntake ? 1 : 0);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    setExportStatus("Preparing package…");
    try {
      await exportDeliverablePackage(
        form,
        engagementName,
        selection,
        manifestItems,
        sheets,
        setExportStatus,
      );
      setExportStatus("Download started.");
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Export failed — try again.",
      );
      setExportStatus(null);
    } finally {
      setExporting(false);
    }
  }, [form, engagementName, manifestItems, selection, sheets]);

  return (
    <section
      className="sc-card publisher-package"
      data-testid="publisher-deliverable-package"
    >
      <header className="publisher-package-head">
        <div className="publisher-package-head-main">
          <div className="publisher-package-head-icon" aria-hidden>
            <Package size={18} />
          </div>
          <div>
            <div className="publisher-package-kicker">
              DELIVERABLE PACKAGE
            </div>
            <h2 className="publisher-package-title">
              {selectedCount} item{selectedCount === 1 ? "" : "s"} selected
            </h2>
            <p className="publisher-package-sub sc-meta">
              Intake sheet {completionPct}% complete · {autoFilledCount}{" "}
              auto-filled fields · pick renderings, videos, and plan sheets for
              publisher handoff.
            </p>
          </div>
        </div>
        <div className="publisher-package-head-actions">
          <button
            type="button"
            className="sc-btn-primary"
            data-testid="publisher-package-export"
            disabled={selectedCount === 0 || exporting}
            onClick={() => void handleExport()}
          >
            <Download size={14} />{" "}
            {exporting ? "Building ZIP…" : "Export package"}
          </button>
        </div>
      </header>
      {exportStatus ? (
        <p
          className="publisher-package-export-status sc-meta"
          data-testid="publisher-package-export-status"
        >
          {exportStatus}
        </p>
      ) : null}
      {exportError ? (
        <p
          className="publisher-package-export-error"
          data-testid="publisher-package-export-error"
        >
          {exportError}
        </p>
      ) : null}

      <div className="publisher-package-lanes">
        {!hideIntakeLane ? (
        <PackageLane
          testId="publisher-package-intake"
          icon={<FileSpreadsheet size={16} />}
          title="Intake sheet"
          summary="Exhibit C · New Plan Information Sheet"
          selected={selection.includeIntake}
          onToggleSelected={() =>
            setSelection((s) => ({ ...s, includeIntake: !s.includeIntake }))
          }
          countLabel={selection.includeIntake ? "Included" : "Excluded"}
          included={selection.includeIntake}
        >
          <p className="publisher-package-lane-detail sc-meta">
            Auto-filled publisher intake form — exported as CSV with the
            package manifest when included.
          </p>
        </PackageLane>
        ) : null}

        <PackageLane
          testId="publisher-package-renderings"
          icon={<ImageIcon size={16} />}
          title="Renderings"
          summary={
            rendersQuery.isLoading
              ? "Loading…"
              : `${readyStills.length} ready · ${selection.renderIds.length} selected`
          }
          onSelectAll={
            readyStills.length
              ? () =>
                  selectAllInLane(
                    "renderIds",
                    readyStills.map((r) => r.id),
                  )
              : undefined
          }
          onOpen={onNavigate ? () => onNavigate("renders") : undefined}
          openLabel="Open Rendering"
        >
          {readyStills.length === 0 ? (
            <p className="publisher-package-empty sc-meta">
              No ready stills yet — queue renders in Studio.
            </p>
          ) : (
            readyStills.map((r) => (
              <PackageAssetRow
                key={r.id}
                id={r.id}
                label={renderLabel(r)}
                checked={selection.renderIds.includes(r.id)}
                onToggle={() => toggleId("renderIds", r.id)}
              />
            ))
          )}
        </PackageLane>

        <PackageLane
          testId="publisher-package-videos"
          icon={<Film size={16} />}
          title="Videos"
          summary={
            rendersQuery.isLoading
              ? "Loading…"
              : `${readyVideos.length} ready · ${selection.videoIds.length} selected`
          }
          onSelectAll={
            readyVideos.length
              ? () =>
                  selectAllInLane(
                    "videoIds",
                    readyVideos.map((r) => r.id),
                  )
              : undefined
          }
          onOpen={onNavigate ? () => onNavigate("renders") : undefined}
          openLabel="Open Rendering"
        >
          {readyVideos.length === 0 ? (
            <p className="publisher-package-empty sc-meta">
              No ready videos yet — kick off a video render in Studio.
            </p>
          ) : (
            readyVideos.map((r) => (
              <PackageAssetRow
                key={r.id}
                id={r.id}
                label={renderLabel(r)}
                checked={selection.videoIds.includes(r.id)}
                onToggle={() => toggleId("videoIds", r.id)}
              />
            ))
          )}
        </PackageLane>

        <PackageLane
          testId="publisher-package-plans"
          icon={<Layers size={16} />}
          title="Plans"
          summary={
            !snapshotId
              ? "No snapshot — push sheets from Revit"
              : sheetsQuery.isLoading
                ? "Loading…"
                : `${sheets.length} sheets · ${selection.sheetIds.length} selected`
          }
          onSelectAll={
            sheets.length
              ? () => selectAllInLane("sheetIds", sheets.map((s) => s.id))
              : undefined
          }
          onOpen={onNavigate ? () => onNavigate("sheets") : undefined}
          openLabel="Open Sheets"
        >
          {!snapshotId ? (
            <p className="publisher-package-empty sc-meta">
              Select or receive a snapshot to attach plan sheets.
            </p>
          ) : sheets.length === 0 ? (
            <p className="publisher-package-empty sc-meta">
              No sheets indexed on this snapshot yet.
            </p>
          ) : (
            sheets.map((s) => (
              <PackageAssetRow
                key={s.id}
                id={s.id}
                label={sheetLabel(s)}
                checked={selection.sheetIds.includes(s.id)}
                onToggle={() => toggleId("sheetIds", s.id)}
              />
            ))
          )}
        </PackageLane>
      </div>
    </section>
  );
}

function PackageLane({
  testId,
  icon,
  title,
  summary,
  selected,
  onToggleSelected,
  countLabel,
  onSelectAll,
  onOpen,
  openLabel,
  included,
  children,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  summary: string;
  selected?: boolean;
  onToggleSelected?: () => void;
  countLabel?: string;
  onSelectAll?: () => void;
  onOpen?: () => void;
  openLabel?: string;
  included?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <article
      className="publisher-package-lane sc-card"
      data-testid={testId}
      data-included={included === undefined ? undefined : included ? "true" : "false"}
    >
      <header className="publisher-package-lane-head">
        <label className="publisher-package-lane-title">
          {onToggleSelected ? (
            <input
              type="checkbox"
              checked={!!selected}
              onChange={onToggleSelected}
              data-testid={`${testId}-toggle`}
            />
          ) : null}
          <span className="publisher-package-lane-icon" aria-hidden>
            {icon}
          </span>
          <span>
            <span className="publisher-package-lane-name">{title}</span>
            <span className="publisher-package-lane-summary sc-meta">
              {countLabel ?? summary}
            </span>
          </span>
        </label>
        <div className="publisher-package-lane-actions">
          {onSelectAll ? (
            <button
              type="button"
              className="sc-btn-ghost sc-btn-sm"
              onClick={onSelectAll}
            >
              Select all
            </button>
          ) : null}
          {onOpen ? (
            <button
              type="button"
              className="sc-btn-ghost sc-btn-sm"
              onClick={onOpen}
            >
              {openLabel}
            </button>
          ) : null}
        </div>
      </header>
      <div
        className={`publisher-package-lane-body${
          children ? "" : " publisher-package-lane-body--empty"
        }`}
      >
        {children ?? (
          <p className="publisher-package-empty sc-meta">{summary}</p>
        )}
      </div>
    </article>
  );
}

function PackageAssetRow({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="publisher-package-asset">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        data-testid={`publisher-package-asset-${id}`}
      />
      <span>{label}</span>
    </label>
  );
}

