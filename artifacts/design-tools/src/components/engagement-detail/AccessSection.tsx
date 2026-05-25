import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, Eye, Link2, UserPlus, Users } from "lucide-react";
import {
  createEngagementPackage,
  createPackageShare,
  listEngagementPackages,
  absoluteShareUrl,
} from "./packages/packagesApi";
/**
 * Access section — engagement Settings → Access (QA-51 / QA-53).
 *
 * Share link is wired to the client-review package (#115). Team/client
 * invite lists remain preview-only until the Access backend lands.
 */

interface MockMember {
  name: string;
  role: string;
}

const MOCK_TEAM: ReadonlyArray<MockMember> = [
  { name: "You (Operator)", role: "Owner" },
];

const MOCK_CLIENTS: ReadonlyArray<MockMember> = [];

export function AccessSection({ engagementId }: { engagementId: string }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewPackageId, setReviewPackageId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listEngagementPackages(engagementId);
      const review = rows.find((p) => p.template === "client-review");
      if (review) {
        setReviewPackageId(review.id);
        if (review.shareToken) {
          setShareUrl(absoluteShareUrl(review.shareToken));
        }
      }
    } catch {
      /* non-fatal */
    }
  }, [engagementId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureReviewPackage = async (): Promise<string> => {
    if (reviewPackageId) return reviewPackageId;
    const row = await createEngagementPackage(engagementId, {
      template: "client-review",
      title: "Client plan review",
    });
    setReviewPackageId(row.id);
    return row.id;
  };

  const handleCreateShare = async () => {
    setBusy(true);
    setError(null);
    try {
      const packageId = await ensureReviewPackage();
      const { token } = await createPackageShare(packageId);
      setShareUrl(absoluteShareUrl(token));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create share link.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
  };

  return (
    <section
      className="sc-card flex flex-col"
      data-testid="settings-access-section"
    >
      <div className="sc-card-header">
        <span className="sc-label">ACCESS</span>
        <span className="sc-meta opacity-70">
          Client plan review share link and workspace viewers (preview).
        </span>
      </div>

      <div className="access-grid">
        <AccessGroup
          icon={<Users size={14} />}
          title="Team viewers"
          subtitle="Members of your workspace with read-only access."
          members={MOCK_TEAM}
          ctaIcon={<UserPlus size={14} />}
          ctaLabel="Invite teammate"
          testId="access-team"
          comingSoon
        />
        <AccessGroup
          icon={<Eye size={14} />}
          title="Client viewers"
          subtitle="Outside accounts invited by email. Read-only."
          members={MOCK_CLIENTS}
          emptyMessage="No client viewers yet."
          ctaIcon={<UserPlus size={14} />}
          ctaLabel="Invite client viewer"
          testId="access-clients"
          comingSoon
        />
        <div className="access-share" data-testid="access-share-link">
          <div className="access-share-head">
            <Link2 size={14} />
            <div>
              <div className="access-share-title">Share link</div>
              <div className="access-share-sub">
                Token-gated client plan review — open in incognito to preview
                package contents (QA-53).
              </div>
            </div>
          </div>
          <div className="access-share-link-row">
            <input
              type="text"
              className="access-share-link-input"
              value={shareUrl ?? ""}
              readOnly
              placeholder="Create a share link to copy the URL"
              aria-label="Share link"
              data-testid="access-share-url-input"
            />
            <button
              type="button"
              className="sc-btn-ghost"
              disabled={!shareUrl || busy}
              onClick={() => void handleCopy()}
              title="Copy share URL"
              data-testid="access-share-copy"
            >
              <Copy size={14} /> Copy
            </button>
            {shareUrl && (
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="sc-btn-ghost"
                data-testid="access-share-preview"
                title="Open client preview"
              >
                <ExternalLink size={14} /> Preview
              </a>
            )}
          </div>
          {!shareUrl && (
            <button
              type="button"
              className="sc-btn-primary sc-btn-sm"
              disabled={busy}
              onClick={() => void handleCreateShare()}
              data-testid="access-share-create"
            >
              {busy ? "Creating…" : "Create share link"}
            </button>
          )}
          {error && (
            <div className="access-share-error sc-meta" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AccessGroup({
  icon,
  title,
  subtitle,
  members,
  emptyMessage,
  ctaIcon,
  ctaLabel,
  testId,
  comingSoon = false,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  members: ReadonlyArray<MockMember>;
  emptyMessage?: string;
  ctaIcon: React.ReactNode;
  ctaLabel: string;
  testId: string;
  comingSoon?: boolean;
}) {
  return (
    <div className="access-group" data-testid={testId}>
      <div className="access-group-head">
        <span className="access-group-icon">{icon}</span>
        <div>
          <div className="access-group-title">{title}</div>
          <div className="access-group-sub">{subtitle}</div>
        </div>
      </div>
      {members.length === 0 ? (
        <div className="access-group-empty">{emptyMessage}</div>
      ) : (
        <ul className="access-group-list">
          {members.map((m, i) => (
            <li key={i} className="access-group-row">
              <span className="access-group-row-name">{m.name}</span>
              <span className="access-group-row-role">{m.role}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="sc-btn-ghost access-group-cta"
        disabled={comingSoon}
        title={
          comingSoon
            ? "Coming soon — Access backend is not wired"
            : undefined
        }
      >
        {ctaIcon} {ctaLabel}
      </button>
      {comingSoon && <div className="access-coming-soon">Coming soon</div>}
    </div>
  );
}
