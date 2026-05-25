/**
 * Client Materials — Placid PDF export (primary) + optional Canva autofill (flagged off for GA).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EngagementDetail as EngagementDetailType } from "@workspace/api-client-react";
import { listEngagementPackages } from "@workspace/api-client-react";
import {
  CanvaAssetPicker,
  CanvaConnectionBanner,
  CanvaPushProgress,
  CanvaTemplateGrid,
  CollateralExportProgress,
  connectCanvaAccount,
  disconnectCanvaAccount,
} from "@workspace/portal-ui";
import {
  canvaAutofillEnabled,
  collateralIntegrationService,
} from "../../lib/collateralService";
import { canvaIntegrationService } from "../../lib/canvaService";
import type {
  CanvaConnectionStatus,
  CanvaPushJob,
  CanvaSelectableAsset,
  CollateralExportJob,
  CollateralExportRecord,
  CollateralSelectableAsset,
  CollateralTemplatePack,
} from "@workspace/portal-ui";
import { ExternalLink, FileText, History, Upload } from "lucide-react";
import { TabHeader } from "../cockpit/TabChrome";
import type { TabId } from "./urlState";
import { parseCanvaAssetTokens, readCanvaAssetPreselectFromUrl } from "./clientMaterialsUrl";

export function ClientMaterialsTab({
  engagement,
  onNavigate,
  canvaConnected: canvaConnectedProp = true,
}: {
  engagement: EngagementDetailType;
  onNavigate?: (tab: TabId) => void;
  canvaConnected?: boolean;
}) {
  const engagementId = engagement.id;
  const collateral = collateralIntegrationService;
  const canva = canvaIntegrationService;

  const [packs, setPacks] = useState<CollateralTemplatePack[]>([]);
  const [assets, setAssets] = useState<CollateralSelectableAsset[]>([]);
  const [exportHistory, setExportHistory] = useState<CollateralExportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [heroAssetId, setHeroAssetId] = useState<string | null>(null);
  const [packId, setPackId] = useState<string | null>("client-presentation");
  const [slotMapping, setSlotMapping] = useState<Record<string, string>>({});
  const [textFields, setTextFields] = useState<Record<string, string>>(() => ({
    project_name: engagement.name,
    address: engagement.address ?? engagement.site?.address ?? "",
    headline: engagement.name,
    talking_points: "",
  }));
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<CollateralExportJob | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const [connection, setConnection] = useState<CanvaConnectionStatus>({
    state: "disconnected",
  });
  const [canvaTemplates, setCanvaTemplates] = useState<
    Awaited<ReturnType<typeof canva.listBrandTemplates>>
  >([]);
  const [canvaTemplateId, setCanvaTemplateId] = useState<string | null>(null);
  const [canvaSlotMapping, setCanvaSlotMapping] = useState<Record<string, string>>({});
  const [canvaTextFields, setCanvaTextFields] = useState(textFields);
  const [canvaActiveJob, setCanvaActiveJob] = useState<CanvaPushJob | null>(null);
  const [canvaPushOpen, setCanvaPushOpen] = useState(false);
  const [, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const selectedPack = packs.find((p) => p.id === packId) ?? null;
  const sheetIds = useMemo(
    () => [...selectedIds].filter((id) => id.startsWith("sheet:")),
    [selectedIds],
  );
  const pageCount = 1 + Math.min(sheetIds.length, 12) + 1;
  const estimatedCredits = pageCount * (selectedPack?.creditsPerPage ?? 2);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listEngagementPackages(engagementId);
        const presentation = rows.find(
          (r) => r.template === "client-presentation" && r.formSnapshot,
        );
        const form = presentation?.formSnapshot;
        if (!form || cancelled) return;
        setTextFields((prev) => ({
          ...prev,
          headline: form.clientHeadline?.trim() || prev.headline,
          talking_points:
            form.clientTalkingPoints?.trim() || prev.talking_points,
        }));
      } catch {
        /* packages optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [assetList, packList, historyList] = await Promise.all([
          collateral.listEngagementAssets(engagementId),
          collateral.listTemplatePacks(),
          collateral.listEngagementExports(engagementId),
        ]);
        if (cancelled) return;
        setAssets(assetList);
        setPacks(packList);
        setExportHistory(historyList);
        if (!packId && packList[0]) setPackId(packList[0].id);

        const preselect = parseCanvaAssetTokens(readCanvaAssetPreselectFromUrl());
        if (preselect.length > 0) {
          const valid = preselect.filter((id) =>
            assetList.some(
              (a: CollateralSelectableAsset) => a.id === id && a.exportable,
            ),
          );
          if (valid.length > 0) {
            setSelectedIds(new Set(valid));
            setHeroAssetId(valid[0] ?? null);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load client materials",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engagementId, collateral, packId]);

  useEffect(() => {
    if (!canvaAutofillEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await canva.getConnectionStatus();
        if (!canvaConnectedProp && status.state === "connected") {
          setConnection({ state: "disconnected" });
        } else {
          setConnection(status);
        }
        const templateList = await canva.listBrandTemplates();
        if (!cancelled) {
          setCanvaTemplates(templateList);
        }
      } catch {
        /* Canva optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canva, canvaConnectedProp, engagementId]);

  useEffect(() => {
    if (!activeJobId) return;
    const interval = window.setInterval(async () => {
      const job = await collateral.getExportJob(activeJobId);
      setActiveJob(job);
      if (job.step === "ready" || job.step === "failed") {
        window.clearInterval(interval);
        setExportOpen(false);
        if (job.step === "ready") {
          void collateral
            .listEngagementExports(engagementId)
            .then(setExportHistory);
        }
      }
    }, 400);
    return () => window.clearInterval(interval);
  }, [activeJobId, collateral, engagementId]);

  const assetsById = useMemo(
    () => new Map(assets.map((a) => [a.id, a])),
    [assets],
  );

  const requiredImageSlots =
    selectedPack?.slots.filter(
      (s: CollateralTemplatePack["slots"][number]) => s.type === "image",
    ) ?? [];
  const slotsFilled = requiredImageSlots.every((s) => {
    if (s.key === "hero_image") {
      return Boolean(slotMapping.hero_image ?? heroAssetId);
    }
    return Boolean(slotMapping[s.key]);
  });

  const canGeneratePdf =
    selectedIds.size > 0 &&
    packId !== null &&
    slotsFilled &&
    !exportOpen;

  const toggleAsset = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (heroAssetId === id) setHeroAssetId(null);
      } else {
        next.add(id);
        if (!heroAssetId) setHeroAssetId(id);
      }
      return next;
    });
  };

  useEffect(() => {
    if (heroAssetId) {
      setSlotMapping((prev) => ({ ...prev, hero_image: heroAssetId }));
    }
  }, [heroAssetId]);

  const startPdfExport = async () => {
    if (!packId) return;
    setExportOpen(true);
    setActiveJob({
      jobId: "pending",
      step: "preparing",
      progressLabel: "Preparing export…",
      creditsEstimated: estimatedCredits,
    });
    const mapping = { ...slotMapping };
    if (heroAssetId && !mapping.hero_image) {
      mapping.hero_image = heroAssetId;
    }
    const { jobId } = await collateral.startExport({
      engagementId,
      templatePackId: packId,
      assetIds: [...selectedIds],
      slotMapping: mapping,
      textFields,
      sheetAssetIds: sheetIds,
    });
    setActiveJobId(jobId);
  };

  const refreshCanvaConnection = useCallback(async () => {
    const status = await canva.getConnectionStatus();
    if (!canvaConnectedProp && status.state === "connected") {
      setConnection({ state: "disconnected" });
      return;
    }
    setConnection(status);
  }, [canva, canvaConnectedProp]);

  const handleConnectCanva = async () => {
    setConnectError(null);
    setConnecting(true);
    try {
      await connectCanvaAccount();
      await refreshCanvaConnection();
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Could not connect Canva",
      );
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div
      className="cockpit-tab client-materials-tab"
      data-testid="client-materials-tab"
      data-engagement-id={engagementId}
    >
      <TabHeader
        overline="Deliver · client collateral"
        title="Client materials"
        subtitle="Generate client-ready PDF presentations from your renders and plan sheets. Usage-based export credits."
      />

      {loadError ? (
        <p className="client-materials-connect-error sc-meta" role="alert">
          {loadError}
        </p>
      ) : null}

      <div className="client-materials-workspace">
        <section className="client-materials-pane client-materials-pane--assets">
          <h2 className="client-materials-pane-title">Source assets</h2>
          <p className="client-materials-pane-lead">
            Renders, plans, and sheet exports from this engagement.
          </p>
          <CanvaAssetPicker
            assets={assets as CanvaSelectableAsset[]}
            selectedIds={selectedIds}
            heroAssetId={heroAssetId}
            onToggle={toggleAsset}
            onHeroChange={setHeroAssetId}
            loading={loading}
          />
        </section>

        <section className="client-materials-pane client-materials-pane--templates">
          <h2 className="client-materials-pane-title">Presentation template</h2>
          <div className="canva-template-grid" role="list">
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                role="listitem"
                className={`canva-template-card${packId === pack.id ? " canva-template-card--selected" : ""}`}
                data-testid={`collateral-pack-${pack.id}`}
                onClick={() => setPackId(pack.id)}
              >
                <img src={pack.thumbnailUrl} alt="" />
                <span className="canva-template-name">{pack.name}</span>
                <span className="sc-meta">{pack.tags.join(" · ")}</span>
              </button>
            ))}
          </div>
          {selectedPack ? (
            <div className="client-materials-text-fields">
              {selectedPack.slots
                .filter(
                  (s: CollateralTemplatePack["slots"][number]) =>
                    s.type === "text",
                )
                .map((slot) => (
                  <label key={slot.key} className="sc-field">
                    <span className="sc-field-label">{slot.label}</span>
                    <input
                      type="text"
                      className="sc-input"
                      value={textFields[slot.key] ?? ""}
                      onChange={(e) =>
                        setTextFields((prev) => ({
                          ...prev,
                          [slot.key]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
            </div>
          ) : null}
        </section>

        <aside className="client-materials-pane client-materials-pane--summary sc-card">
          <h2 className="client-materials-pane-title">Summary</h2>
          <ul className="client-materials-summary-meta sc-meta">
            <li>
              <strong>{selectedIds.size}</strong> asset
              {selectedIds.size === 1 ? "" : "s"} selected
            </li>
            <li>
              ~<strong>{estimatedCredits}</strong> credits · {pageCount} pages
            </li>
            <li>Pack: {selectedPack?.name ?? "None"}</li>
          </ul>

          <div className="client-materials-summary-actions">
            <button
              type="button"
              className="sc-btn-primary"
              disabled={!canGeneratePdf}
              data-testid="collateral-generate-pdf"
              onClick={() => void startPdfExport()}
            >
              <FileText size={14} aria-hidden /> Generate PDF
            </button>
          </div>

          {(exportOpen || activeJob) && (
            <CollateralExportProgress
              job={activeJob}
              onCancel={() => {
                setExportOpen(false);
                setActiveJob(null);
                setActiveJobId(null);
              }}
              onRetry={() => void startPdfExport()}
            />
          )}

          <section
            className="client-materials-history"
            data-testid="collateral-export-history"
          >
            <h3 className="client-materials-history-title">
              <History size={14} aria-hidden /> Previous PDF exports
            </h3>
            {exportHistory.length === 0 ? (
              <p className="sc-meta">No PDF exports yet for this engagement.</p>
            ) : (
              <ul className="canva-history-list">
                {exportHistory.map((row) => (
                  <li
                    key={row.id}
                    className="canva-history-row"
                    data-testid={`collateral-history-${row.id}`}
                  >
                    <div>
                      <div className="canva-history-name">{row.templateName}</div>
                      <div className="sc-meta">
                        {row.createdAt} · {row.status}
                        {row.creditsCharged != null
                          ? ` · ${row.creditsCharged} credits`
                          : ""}
                      </div>
                    </div>
                    {row.downloadUrl ? (
                      <a
                        href={row.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                        className="sc-btn-ghost sc-btn-sm"
                      >
                        Download <ExternalLink size={12} aria-hidden />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canvaAutofillEnabled ? (
            <>
              <hr className="client-materials-divider" />
              <h3 className="client-materials-pane-title">Canva (optional)</h3>
              <CanvaConnectionBanner
                status={connection}
                onConnect={() => void handleConnectCanva()}
                onDisconnect={async () => {
                  await disconnectCanvaAccount();
                  setConnection({ state: "disconnected" });
                }}
                onReconnect={() => void handleConnectCanva()}
              />
              {connectError ? (
                <p className="sc-meta" role="alert">
                  {connectError}
                </p>
              ) : null}
              <CanvaTemplateGrid
                templates={canvaTemplates}
                selectedTemplateId={canvaTemplateId}
                onSelectTemplate={setCanvaTemplateId}
                slotMapping={canvaSlotMapping}
                onSlotMappingChange={(key, assetId) =>
                  setCanvaSlotMapping((prev) => ({ ...prev, [key]: assetId }))
                }
                assetsById={assetsById as Map<string, CanvaSelectableAsset>}
                textFields={canvaTextFields}
                onTextFieldChange={(key, value) =>
                  setCanvaTextFields((prev) => ({ ...prev, [key]: value }))
                }
              />
              <button
                type="button"
                className="sc-btn-ghost"
                disabled={
                  connection.state !== "connected" ||
                  selectedIds.size === 0 ||
                  !canvaTemplateId
                }
                data-testid="canva-generate"
                onClick={async () => {
                  setCanvaPushOpen(true);
                  const { jobId } = await canva.startPush({
                    engagementId,
                    templateId: canvaTemplateId!,
                    assetIds: [...selectedIds],
                    slotMapping: canvaSlotMapping,
                    textFields: canvaTextFields,
                  });
                  const poll = window.setInterval(async () => {
                    const job = await canva.getPushJob(jobId);
                    setCanvaActiveJob(job);
                    if (job.step === "ready" || job.step === "failed") {
                      window.clearInterval(poll);
                      setCanvaPushOpen(false);
                    }
                  }, 400);
                }}
              >
                Generate in Canva
              </button>
              <button
                type="button"
                className="sc-btn-ghost sc-btn-sm"
                data-testid="canva-upload-only"
                onClick={async () => {
                  await canva.startPush({
                    engagementId,
                    templateId: "upload-only",
                    assetIds: [...selectedIds],
                    slotMapping: {},
                    textFields: canvaTextFields,
                    uploadAssetsOnly: true,
                  });
                }}
              >
                <Upload size={14} aria-hidden /> Upload to my Canva
              </button>
              {canvaPushOpen || canvaActiveJob ? (
                <CanvaPushProgress job={canvaActiveJob} />
              ) : null}
            </>
          ) : (
            <p className="sc-meta client-materials-canva-backlog">
              <a
                href="https://www.canva.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                Export to my Canva
              </a>{" "}
              — upload-only path (backlog; Enterprise autofill not required).
            </p>
          )}

          {onNavigate ? (
            <p className="client-materials-footer sc-meta">
              Need more assets?{" "}
              <button
                type="button"
                className="client-materials-inline-link"
                onClick={() => onNavigate("renders")}
              >
                Open Rendering
              </button>{" "}
              or{" "}
              <button
                type="button"
                className="client-materials-inline-link"
                onClick={() => onNavigate("sheets")}
              >
                Sheets
              </button>
            </p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
