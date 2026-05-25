import { useCallback, useEffect, useState } from "react";
import { Link2, Copy, MessageSquare, Plus } from "lucide-react";
import type { EngagementDetail } from "@workspace/api-client-react";
import { TabHeader } from "../../cockpit/TabChrome";
import { PublisherIntakeWorkbench } from "../PublisherIntakeWorkbench";
import { PublisherDeliverablePackage } from "../PublisherDeliverablePackage";
import type { TabId } from "../urlState";
import {
  PACKAGE_TEMPLATE_DESCRIPTIONS,
  PACKAGE_TEMPLATE_LABELS,
  type PackageTemplateId,
  readPackageTemplateFromUrl,
  writePackageTemplateToUrl,
} from "./types";
import {
  absoluteShareUrl,
  createEngagementPackage,
  createPackageShare,
  listEngagementPackages,
  listPackageComments,
  updateEngagementPackage,
} from "./packagesApi";
import type { EngagementPackageRecord } from "./types";
import { downloadClientPresentationHtml } from "./exportClientPresentation";
import { buildPublisherIntakeDraft } from "../publisherIntake/buildPublisherIntakeDraft";

const TEMPLATE_ORDER: PackageTemplateId[] = [
  "client-presentation",
  "client-review",
  "publisher-handoff",
  "jurisdiction-manifest",
];

export function PackagesTab({
  engagement,
  snapshotId,
  onNavigate,
  initialTemplate,
}: {
  engagement: EngagementDetail;
  snapshotId: string | null;
  onNavigate?: (tab: TabId) => void;
  initialTemplate?: PackageTemplateId;
}) {
  const [template, setTemplate] = useState<PackageTemplateId>(
    () => initialTemplate ?? readPackageTemplateFromUrl(),
  );
  const [packages, setPackages] = useState<EngagementPackageRecord[]>([]);
  const [activePackageId, setActivePackageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [comments, setComments] = useState<
    Awaited<ReturnType<typeof listPackageComments>>
  >([]);
  const [clientHeadline, setClientHeadline] = useState("");
  const [clientTalkingPoints, setClientTalkingPoints] = useState("");
  const [clientReviewNote, setClientReviewNote] = useState("");
  const [busy, setBusy] = useState(false);

  const activePackage = packages.find((p) => p.id === activePackageId) ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listEngagementPackages(engagement.id);
      setPackages(rows);
      const forTemplate = rows.filter((p) => p.template === template);
      setActivePackageId((prev) => {
        if (prev && forTemplate.some((p) => p.id === prev)) return prev;
        return forTemplate[0]?.id ?? null;
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load packages.",
      );
      setPackages([]);
    } finally {
      setLoading(false);
    }
  }, [engagement.id, template]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    writePackageTemplateToUrl(template);
    const forTemplate = packages.filter((p) => p.template === template);
    if (!forTemplate.some((p) => p.id === activePackageId)) {
      setActivePackageId(forTemplate[0]?.id ?? null);
    }
  }, [template, packages, activePackageId]);

  useEffect(() => {
    if (!activePackage) return;
    const form = activePackage.formSnapshot ?? {};
    setClientHeadline(form.clientHeadline ?? "");
    setClientTalkingPoints(form.clientTalkingPoints ?? "");
    setClientReviewNote(form.clientReviewNote ?? "");
    if (activePackage.shareToken) {
      setShareUrl(absoluteShareUrl(activePackage.shareToken));
    } else {
      setShareUrl(null);
    }
    if (activePackage.template === "client-review") {
      void listPackageComments(activePackage.id)
        .then(setComments)
        .catch(() => setComments([]));
    }
  }, [activePackage]);

  const handleCreatePackage = async () => {
    setBusy(true);
    try {
      const row = await createEngagementPackage(engagement.id, {
        template,
        title: PACKAGE_TEMPLATE_LABELS[template],
        snapshotId,
      });
      setPackages((prev) => [row, ...prev]);
      setActivePackageId(row.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  };

  const persistClientFields = async () => {
    if (!activePackage) return;
    await updateEngagementPackage(activePackage.id, {
      formSnapshot: {
        ...(activePackage.formSnapshot ?? {}),
        clientHeadline,
        clientTalkingPoints,
        clientReviewNote,
      },
    });
    await refresh();
  };

  const handleShare = async () => {
    if (!activePackage) return;
    setBusy(true);
    try {
      await persistClientFields();
      const { token } = await createPackageShare(activePackage.id);
      setShareUrl(absoluteShareUrl(token));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Share failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopyShare = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
  };

  const handleExportPresentation = async () => {
    if (!activePackage) return;
    setBusy(true);
    try {
      await persistClientFields();
      await updateEngagementPackage(activePackage.id, { status: "exported" });
      downloadClientPresentationHtml({
        engagementName: engagement.name,
        packageRecord: activePackage,
        sheetLabels: {},
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const templateBar = (
    <PackageTemplateBar
      template={template}
      onTemplateChange={setTemplate}
      packages={packages}
      activePackageId={activePackageId}
      onSelectPackage={setActivePackageId}
      onCreate={() => void handleCreatePackage()}
      busy={busy}
      loading={loading}
    />
  );

  if (template === "publisher-handoff") {
    const persistPublisherPackage = async (patch: {
      formSnapshot: EngagementPackageRecord["formSnapshot"];
      selection?: EngagementPackageRecord["selection"];
    }) => {
      if (!activePackage) return;
      await updateEngagementPackage(activePackage.id, patch);
      await refresh();
    };

    return (
      <div className="packages-tab packages-tab--publisher" data-testid="packages-tab">
        {templateBar}
        {!activePackage && !loading ? (
          <div className="packages-tab-empty sc-prose">
            <p>{PACKAGE_TEMPLATE_DESCRIPTIONS[template]}</p>
            <button
              type="button"
              className="sc-btn-primary"
              onClick={() => void handleCreatePackage()}
              disabled={busy}
            >
              <Plus size={14} /> New publisher handoff package
            </button>
          </div>
        ) : null}
        <PublisherIntakeWorkbench
          engagement={engagement}
          snapshotId={snapshotId}
          onNavigate={onNavigate}
          packageRecord={activePackage}
          onPersistPackage={
            activePackage ? persistPublisherPackage : undefined
          }
        />
      </div>
    );
  }

  const placeholderForm = buildPublisherIntakeDraft(engagement).form;

  return (
    <div className="packages-tab" data-testid="packages-tab">
      <TabHeader
        overline="Deliver"
        title="Packages"
        subtitle="One builder for client presentations, client review links, and submittal manifests."
        testId="packages-tab-header"
      />
      {templateBar}
      {error ? (
        <p className="packages-tab-error" data-testid="packages-tab-error">
          {error}
        </p>
      ) : null}
      {!activePackage && !loading ? (
        <div className="packages-tab-empty sc-prose">
          <p>{PACKAGE_TEMPLATE_DESCRIPTIONS[template]}</p>
          <button
            type="button"
            className="sc-btn-primary"
            onClick={() => void handleCreatePackage()}
            disabled={busy}
          >
            <Plus size={14} /> New {PACKAGE_TEMPLATE_LABELS[template].toLowerCase()}
          </button>
        </div>
      ) : null}
      {activePackage ? (
        <>
          {(template === "client-presentation" ||
            template === "client-review") && (
            <section className="packages-client-fields sc-card">
              <h3 className="sc-label">Client-facing copy</h3>
              <label className="packages-field">
                <span>Headline</span>
                <input
                  type="text"
                  value={clientHeadline}
                  onChange={(e) => setClientHeadline(e.target.value)}
                  onBlur={() => void persistClientFields()}
                />
              </label>
              <label className="packages-field">
                <span>Talking points</span>
                <textarea
                  rows={3}
                  value={clientTalkingPoints}
                  onChange={(e) => setClientTalkingPoints(e.target.value)}
                  onBlur={() => void persistClientFields()}
                />
              </label>
              {template === "client-review" ? (
                <label className="packages-field">
                  <span>Review instructions</span>
                  <textarea
                    rows={2}
                    value={clientReviewNote}
                    onChange={(e) => setClientReviewNote(e.target.value)}
                    onBlur={() => void persistClientFields()}
                  />
                </label>
              ) : null}
            </section>
          )}
          <PublisherDeliverablePackage
            engagementId={engagement.id}
            snapshotId={snapshotId}
            engagementName={engagement.name}
            form={placeholderForm}
            completionPct={0}
            autoFilledCount={0}
            onNavigate={onNavigate}
            hideIntakeLane
          />
          <footer className="packages-tab-actions">
            {template === "client-presentation" ? (
              <button
                type="button"
                className="sc-btn-primary"
                disabled={busy}
                onClick={() => void handleExportPresentation()}
                data-testid="packages-export-presentation"
              >
                Export presentation HTML
              </button>
            ) : null}
            {template === "client-review" ? (
              <>
                <button
                  type="button"
                  className="sc-btn-primary"
                  disabled={busy}
                  onClick={() => void handleShare()}
                  data-testid="packages-create-share"
                >
                  <Link2 size={14} />{" "}
                  {shareUrl ? "Refresh share link" : "Create share link"}
                </button>
                {shareUrl ? (
                  <button
                    type="button"
                    className="sc-btn-ghost"
                    onClick={() => void handleCopyShare()}
                    data-testid="packages-copy-share"
                  >
                    <Copy size={14} /> Copy link
                  </button>
                ) : null}
              </>
            ) : null}
            {template === "jurisdiction-manifest" ? (
              <p className="sc-meta">
                Use <strong>Submit to jurisdiction</strong> in the header when
                ready. Link submissions from Review → Submissions.
              </p>
            ) : null}
          </footer>
          {template === "client-review" && shareUrl ? (
            <section
              className="packages-share-panel sc-card"
              data-testid="packages-share-panel"
            >
              <p className="sc-meta">Share URL: {shareUrl}</p>
              {comments.length > 0 ? (
                <ul className="packages-comments">
                  {comments.map((c) => (
                    <li key={c.id}>
                      <MessageSquare size={12} aria-hidden />
                      <strong>{c.authorName}</strong>: {c.body}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sc-meta">No client comments yet.</p>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PackageTemplateBar({
  template,
  onTemplateChange,
  packages,
  activePackageId,
  onSelectPackage,
  onCreate,
  busy,
  loading,
}: {
  template: PackageTemplateId;
  onTemplateChange: (t: PackageTemplateId) => void;
  packages: EngagementPackageRecord[];
  activePackageId: string | null;
  onSelectPackage: (id: string) => void;
  onCreate: () => void;
  busy: boolean;
  loading: boolean;
}) {
  const forTemplate = packages.filter((p) => p.template === template);
  return (
    <div className="packages-template-bar">
      <div className="packages-template-tabs" role="tablist">
        {TEMPLATE_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={template === t}
            className={`packages-template-tab${template === t ? " packages-template-tab--active" : ""}`}
            data-testid={`packages-template-${t}`}
            onClick={() => onTemplateChange(t)}
          >
            {PACKAGE_TEMPLATE_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="packages-package-picker">
        <select
          value={activePackageId ?? ""}
          onChange={(e) => onSelectPackage(e.target.value)}
          disabled={loading || forTemplate.length === 0}
          data-testid="packages-active-select"
        >
          {forTemplate.length === 0 ? (
            <option value="">No packages</option>
          ) : (
            forTemplate.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} · {p.status}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          onClick={onCreate}
          disabled={busy}
          data-testid="packages-new"
        >
          <Plus size={12} /> New
        </button>
      </div>
    </div>
  );
}
