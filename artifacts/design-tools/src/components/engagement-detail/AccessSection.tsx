import { Copy, Eye, Link2, UserPlus, Users } from "lucide-react";

/**
 * Access section — engagement Settings → Access (viewership).
 *
 * Three subsections, all explicitly disabled with "coming soon" copy:
 *   1. Team viewers — engineers/architects from your workspace.
 *   2. Client viewers — read-only outside accounts.
 *   3. Share link — token-gated read-only URL.
 *
 * No share tokens are minted, no users invited. This is the IA shell
 * so the next wave drops in without redesigning Settings.
 */

interface MockMember {
  name: string;
  role: string;
}

const MOCK_TEAM: ReadonlyArray<MockMember> = [
  { name: "You (Operator)", role: "Owner" },
  { name: "T. Liang", role: "Architect" },
  { name: "M. Adler", role: "Reviewer" },
];

const MOCK_CLIENTS: ReadonlyArray<MockMember> = [];

export function AccessSection() {
  return (
    <section
      className="sc-card flex flex-col"
      data-testid="settings-access-section"
    >
      <div className="sc-card-header">
        <span className="sc-label">ACCESS</span>
        <span className="sc-meta opacity-70">
          Who can view this engagement. Sharing is coming soon — the lists
          below preview the IA.
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
        />
        <div
          className="access-share"
          data-testid="access-share-link"
        >
          <div className="access-share-head">
            <Link2 size={14} />
            <div>
              <div className="access-share-title">Share link</div>
              <div className="access-share-sub">
                Token-gated read-only URL anyone with the link can open.
              </div>
            </div>
          </div>
          <div className="access-share-link-row">
            <input
              type="text"
              className="access-share-link-input"
              value="https://app.smartcity.example/share/—"
              readOnly
              disabled
              aria-label="Share link (coming soon)"
            />
            <button
              type="button"
              className="sc-btn-ghost"
              disabled
              title="Coming soon — share tokens not implemented"
            >
              <Copy size={14} /> Copy
            </button>
          </div>
          <div className="access-coming-soon">
            Coming soon — share tokens land with the Access backend.
          </div>
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
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  members: ReadonlyArray<MockMember>;
  emptyMessage?: string;
  ctaIcon: React.ReactNode;
  ctaLabel: string;
  testId: string;
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
        disabled
        title="Coming soon — Access backend is not wired"
      >
        {ctaIcon} {ctaLabel}
      </button>
      <div className="access-coming-soon">Coming soon</div>
    </div>
  );
}
