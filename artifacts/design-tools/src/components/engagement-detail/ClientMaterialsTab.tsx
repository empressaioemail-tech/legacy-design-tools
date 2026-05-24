/**
 * Client Materials — Canva-ready deliverables workspace (UI shell).
 *
 * Cross-asset workflow: pick engagement exports, map to brand templates,
 * push to Canva for client-facing collateral. Stub-driven via
 * `CanvaIntegrationService` — no OAuth or Canva API calls yet.
 *
 * Expected API endpoints:
 *   GET  /api/canva/connection
 *   POST /api/canva/oauth/start
 *   GET  /api/engagements/:id/canva/assets
 *   GET  /api/canva/brand-templates
 *   POST /api/engagements/:id/canva/push
 *   GET  /api/canva/push-jobs/:jobId
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EngagementDetail as EngagementDetailType } from "@workspace/api-client-react";
import {
  CanvaAssetPicker,
  CanvaConnectionBanner,
  CanvaPushProgress,
  CanvaTemplateGrid,
  mockCanvaIntegrationService,
} from "@workspace/portal-ui";
import type {
  CanvaConnectionStatus,
  CanvaDesignPush,
  CanvaPushJob,
  CanvaSelectableAsset,
} from "@workspace/portal-ui";
import { ExternalLink, History, Upload } from "lucide-react";
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
  /** Stub toggle — simulates OAuth connected state. */
  canvaConnected?: boolean;
}) {
  const engagementId = engagement.id;
  const service = mockCanvaIntegrationService;

  const [connection, setConnection] = useState<CanvaConnectionStatus>({
    state: "disconnected",
  });
  const [assets, setAssets] = useState<CanvaSelectableAsset[]>([]);
  const [templates, setTemplates] = useState<Awaited<
    ReturnType<typeof service.listBrandTemplates>
  >>([]);
  const [history, setHistory] = useState<CanvaDesignPush[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [heroAssetId, setHeroAssetId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [slotMapping, setSlotMapping] = useState<Record<string, string>>({});
  const [textFields, setTextFields] = useState<Record<string, string>>(() => ({
    project_name: engagement.name,
    address: engagement.address ?? engagement.site?.address ?? "",
    headline: engagement.name,
  }));
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<CanvaPushJob | null>(null);
  const [pushOpen, setPushOpen] = useState(false);

  const refreshConnection = useCallback(async () => {
    const status = await service.getConnectionStatus();
    if (!canvaConnectedProp && status.state === "connected") {
      setConnection({ state: "disconnected" });
      return;
    }
    setConnection(status);
  }, [canvaConnectedProp, service]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await refreshConnection();
      const [assetList, templateList, designList] = await Promise.all([
        service.listEngagementAssets(engagementId),
        service.listBrandTemplates(),
        service.listEngagementDesigns(engagementId),
      ]);
      if (cancelled) return;
      setAssets(assetList);
      setTemplates(templateList);
      setHistory(designList);
      setLoading(false);

      const preselect = parseCanvaAssetTokens(readCanvaAssetPreselectFromUrl());
      if (preselect.length > 0) {
        const valid = preselect.filter((id) =>
          assetList.some((a) => a.id === id && a.exportable),
        );
        if (valid.length > 0) {
          setSelectedIds(new Set(valid));
          setHeroAssetId(valid[0] ?? null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engagementId, refreshConnection, service]);

  const assetsById = useMemo(
    () => new Map(assets.map((a) => [a.id, a])),
    [assets],
  );

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const requiredImageSlots =
    selectedTemplate?.slots.filter((s) => s.type === "image") ?? [];
  const slotsFilled = requiredImageSlots.every((s) => Boolean(slotMapping[s.key]));
  const connected = connection.state === "connected";
  const canGenerate =
    connected &&
    selectedIds.size > 0 &&
    templateId !== null &&
    slotsFilled &&
    !pushOpen;

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
    if (!activeJobId) return;
    const interval = window.setInterval(async () => {
      const job = await service.getPushJob(activeJobId);
      setActiveJob(job);
      if (job.step === "ready" || job.step === "failed") {
        window.clearInterval(interval);
        setPushOpen(false);
        if (job.step === "ready") {
          void service.listEngagementDesigns(engagementId).then(setHistory);
        }
      }
    }, 350);
    return () => window.clearInterval(interval);
  }, [activeJobId, engagementId, service]);

  const startPush = async (uploadOnly = false) => {
    if (!templateId && !uploadOnly) return;
    setPushOpen(true);
    setActiveJob({
      jobId: "pending",
      step: "preparing",
      progressLabel: "Preparing assets…",
    });
    const { jobId } = await service.startPush({
      engagementId,
      templateId: templateId ?? "upload-only",
      assetIds: [...selectedIds],
      slotMapping,
      textFields,
      uploadAssetsOnly: uploadOnly,
    });
    setActiveJobId(jobId);
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
        subtitle="Select engagement assets, choose a brand template, and generate editable proposals in Canva."
      />

      <CanvaConnectionBanner
        status={connection}
        onConnect={() =>
          setConnection({
            state: "connected",
            displayName: "Studio Canva (demo)",
            connectedAt: "just now",
          })
        }
        onDisconnect={() => setConnection({ state: "disconnected" })}
        onReconnect={() =>
          setConnection({
            state: "connected",
            displayName: "Studio Canva (demo)",
            connectedAt: "reconnected",
          })
        }
      />

      <div className="client-materials-workspace">
        <section className="client-materials-pane client-materials-pane--assets">
          <h2 className="client-materials-pane-title">Source assets</h2>
          <p className="client-materials-pane-lead">
            Renders, plans, and sheet exports from this engagement.
          </p>
          <CanvaAssetPicker
            assets={assets}
            selectedIds={selectedIds}
            heroAssetId={heroAssetId}
            onToggle={toggleAsset}
            onHeroChange={setHeroAssetId}
            loading={loading}
          />
        </section>

        <section className="client-materials-pane client-materials-pane--templates">
          <h2 className="client-materials-pane-title">Brand template</h2>
          <CanvaTemplateGrid
            templates={templates}
            selectedTemplateId={templateId}
            onSelectTemplate={setTemplateId}
            slotMapping={slotMapping}
            onSlotMappingChange={(key, assetId) =>
              setSlotMapping((prev) => ({ ...prev, [key]: assetId }))
            }
            assetsById={assetsById}
            textFields={textFields}
            onTextFieldChange={(key, value) =>
              setTextFields((prev) => ({ ...prev, [key]: value }))
            }
          />
        </section>

        <aside className="client-materials-pane client-materials-pane--summary sc-card">
          <h2 className="client-materials-pane-title">Summary</h2>
          <ul className="client-materials-summary-meta sc-meta">
            <li>
              <strong>{selectedIds.size}</strong> asset
              {selectedIds.size === 1 ? "" : "s"} selected
            </li>
            <li>
              Template:{" "}
              {selectedTemplate ? selectedTemplate.name : "None selected"}
            </li>
            <li>
              Project: {textFields.project_name ?? engagement.name}
            </li>
            {engagement.jurisdiction ? (
              <li>Jurisdiction: {engagement.jurisdiction}</li>
            ) : null}
          </ul>

          <div className="client-materials-summary-actions">
            <button
              type="button"
              className="sc-btn-primary"
              disabled={!canGenerate}
              title={
                !connected
                  ? "Connect Canva first"
                  : selectedIds.size === 0
                    ? "Select at least one asset"
                    : !templateId
                      ? "Select a template"
                      : !slotsFilled
                        ? "Fill required image slots"
                        : undefined
              }
              data-testid="canva-generate"
              onClick={() => startPush(false)}
            >
              Generate in Canva
            </button>
            <button
              type="button"
              className="sc-btn-ghost"
              disabled={!connected || selectedIds.size === 0 || pushOpen}
              data-testid="canva-upload-only"
              onClick={() => startPush(true)}
            >
              <Upload size={14} aria-hidden /> Upload assets only
            </button>
          </div>

          {(pushOpen || activeJob) && (
            <CanvaPushProgress
              job={activeJob}
              onCancel={() => {
                setPushOpen(false);
                setActiveJob(null);
                setActiveJobId(null);
              }}
              onRetry={() => startPush(false)}
              onCopyLink={() => {
                /* stub — clipboard wiring deferred */
              }}
            />
          )}

          <section className="client-materials-history" data-testid="canva-design-history">
            <h3 className="client-materials-history-title">
              <History size={14} aria-hidden /> Previous designs
            </h3>
            {history.length === 0 ? (
              <p className="sc-meta">No Canva pushes yet for this engagement.</p>
            ) : (
              <ul className="canva-history-list">
                {history.map((row) => (
                  <li key={row.id} className="canva-history-row" data-testid={`canva-history-${row.id}`}>
                    {row.thumbnailUrl ? (
                      <img src={row.thumbnailUrl} alt="" className="canva-history-thumb" />
                    ) : null}
                    <div>
                      <div className="canva-history-name">{row.templateName}</div>
                      <div className="sc-meta">
                        {row.createdAt} · {row.status.replace(/_/g, " ")}
                      </div>
                    </div>
                    {row.designUrl ? (
                      <a
                        href={row.designUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="sc-btn-ghost sc-btn-sm"
                        data-testid={`canva-history-open-${row.id}`}
                      >
                        Open <ExternalLink size={12} aria-hidden />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {onNavigate ? (
            <p className="client-materials-footer sc-meta">
              Need more assets?{" "}
              <button
                type="button"
                className="client-materials-inline-link"
                data-testid="client-materials-goto-renders"
                onClick={() => onNavigate("renders")}
              >
                Open Rendering
              </button>{" "}
              or{" "}
              <button
                type="button"
                className="client-materials-inline-link"
                data-testid="client-materials-goto-sheets"
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
