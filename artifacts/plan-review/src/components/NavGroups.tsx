import type { ReactNode } from "react";
import {
  useListMyReviewerRequests,
  getListMyReviewerRequestsQueryKey,
  useListReviewerQueue,
  getListReviewerQueueQueryKey,
  type SubmissionStatus,
} from "@workspace/api-client-react";
import { useSessionAudience, useSessionPermissions } from "../lib/session";

/**
 * Sidebar group definitions, paired with the optional permission claim
 * required to render each entry.
 *
 * Items without `requiresPermission` are visible to every session; items
 * that *do* declare one are filtered out by {@link useNavGroups} when the
 * server-side session does not list that claim. The ADMIN entries are
 * all gated on a `<resource>:manage` claim mirroring the server-side
 * check pattern in `routes/users.ts`: "Users & Roles" on
 * `users:manage`, "Reviewer Pool" on `reviewers:manage`, and
 * "Settings" on `settings:manage`. The latter two pages are still
 * ComingSoon stubs today, but gating the nav and route now means the
 * moment they grow real admin chrome a non-admin cannot land on them
 * by URL — the route wrapper and the sidebar share the same claim, so
 * they stay in sync.
 *
 * Whole groups whose every item filters out are dropped from the result
 * so the sidebar does not render an empty section header.
 */
export interface NavItem {
  label: string;
  href: string;
  /** Optional permission claim the session must carry for this item to render. */
  requiresPermission?: string;
  /** Optional audience the session must match for this item to render. */
  requiresAudience?: "internal" | "user" | "ai";
  /**
   * Optional trailing badge node forwarded to the sidebar. Populated
   * dynamically by {@link useNavGroups} (e.g. the Outstanding
   * Requests pending-count pill); the static {@link ALL_NAV_GROUPS}
   * tree never sets this directly.
   */
  badge?: ReactNode;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const ALL_NAV_GROUPS: NavGroup[] = [
  { label: "SUBMITTALS", items: [
      { label: "Inbox", href: "/" },
      { label: "Engagements", href: "/engagements" },
      { label: "In Review", href: "/in-review", requiresAudience: "internal" },
      { label: "Approved", href: "/approved", requiresAudience: "internal" },
      { label: "Rejected", href: "/rejected", requiresAudience: "internal" },
      { label: "Sheets", href: "/sheets" },
  ]},
  { label: "MY WORK", items: [
      { label: "Outstanding Requests", href: "/requests", requiresAudience: "internal" },
  ]},
  { label: "AI REVIEWER", items: [
      { label: "Compliance Engine", href: "/compliance", requiresAudience: "internal" },
      { label: "Code Library", href: "/code" },
      { label: "Saved Findings", href: "/findings" },
  ]},
  { label: "ARCHITECT PORTAL", items: [
      { label: "Firms", href: "/firms" },
      { label: "Projects", href: "/projects" },
      { label: "Integrations", href: "/integrations" },
  ]},
  { label: "ADMIN", items: [
      { label: "Users & Roles", href: "/users", requiresPermission: "users:manage" },
      { label: "Reviewer Pool", href: "/reviewers", requiresPermission: "reviewers:manage" },
      { label: "Canned Findings", href: "/canned-findings", requiresPermission: "settings:manage" },
      { label: "Settings", href: "/settings", requiresPermission: "settings:manage" },
  ]},
  { label: "DEV", items: [
      { label: "Style Probe", href: "/style-probe" },
  ]},
];

/**
 * Filter the static {@link ALL_NAV_GROUPS} tree against the caller's
 * permission claims and audience. Pure (no React hooks) so it can be
 * used in tests. Entries without `requiresAudience` show for every
 * audience; passing `null` for `audience` hides every audience-gated
 * entry (mirrors the conservative permission-filter stance).
 */
export function filterNavGroups(
  permissions: ReadonlyArray<string>,
  audience: "internal" | "user" | "ai" | null = null,
): NavGroup[] {
  const granted = new Set(permissions);
  return ALL_NAV_GROUPS.flatMap((group) => {
    const items = group.items.filter((i) => {
      if (i.requiresPermission && !granted.has(i.requiresPermission)) {
        return false;
      }
      if (i.requiresAudience && i.requiresAudience !== audience) {
        return false;
      }
      return true;
    });
    if (items.length === 0) return [];
    return [{ label: group.label, items }];
  });
}

/**
 * React hook that returns the sidebar groups visible to the current
 * session.
 *
 * The session is fetched from `/api/session`; while the request is in
 * flight (or if it fails outright), we treat the caller as having no
 * permission claims at all. That collapses to the same view an
 * unauthenticated visitor sees, which is the safer default — it would
 * be worse to flash the admin links to a non-admin during the initial
 * render than to briefly hide them from a real admin.
 */
export function useNavGroups(): NavGroup[] {
  const { permissions } = useSessionPermissions();
  const { audience } = useSessionAudience();
  const isInternal = audience === "internal";
  const pendingCount = useOutstandingRequestsBadgeCount(isInternal);
  const inReviewCount = useReviewerQueueBucketCount(
    { status: "corrections_requested" },
    "inReview",
    isInternal,
  );
  const approvedCount = useReviewerQueueBucketCount(
    { status: "approved", order: "respondedAt" },
    "approved",
    isInternal,
  );
  const rejectedCount = useReviewerQueueBucketCount(
    { status: "rejected", order: "respondedAt" },
    "rejected",
    isInternal,
  );
  const groups = filterNavGroups(permissions, audience);
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      if (item.href === "/requests" && pendingCount > 0) {
        return {
          ...item,
          badge: (
            <BucketCountBadge
              count={pendingCount}
              testId="nav-outstanding-requests-badge"
              ariaLabel={`${pendingCount} pending ${pendingCount === 1 ? "request" : "requests"}`}
            />
          ),
        };
      }
      if (item.href === "/in-review" && inReviewCount > 0) {
        return {
          ...item,
          badge: (
            <BucketCountBadge
              count={inReviewCount}
              testId="nav-in-review-badge"
              ariaLabel={`${inReviewCount} in review`}
            />
          ),
        };
      }
      if (item.href === "/approved" && approvedCount > 0) {
        return {
          ...item,
          badge: (
            <BucketCountBadge
              count={approvedCount}
              testId="nav-approved-badge"
              ariaLabel={`${approvedCount} approved`}
            />
          ),
        };
      }
      if (item.href === "/rejected" && rejectedCount > 0) {
        return {
          ...item,
          badge: (
            <BucketCountBadge
              count={rejectedCount}
              testId="nav-rejected-badge"
              ariaLabel={`${rejectedCount} rejected`}
            />
          ),
        };
      }
      return item;
    }),
  }));
}

/**
 * Fetch the reviewer's pending-request count to drive the sidebar
 * badge. Shares the exact `?status=pending` query key the
 * `OutstandingRequests` page already uses so the two consumers hit
 * the same react-query cache entry — visiting the page warms the
 * badge, and filing/dismissing a request invalidates one and refreshes
 * the other.
 *
 * Gated on `enabled` because the underlying endpoint 403s any
 * non-reviewer audience; passing the gate as `false` short-circuits
 * the fetch and yields a count of 0 (the badge then hides itself).
 */
function useOutstandingRequestsBadgeCount(enabled: boolean): number {
  const params = { status: "pending" as const };
  const { data } = useListMyReviewerRequests(params, {
    query: {
      queryKey: getListMyReviewerRequestsQueryKey(params),
      enabled,
    },
  });
  return data?.requests?.length ?? 0;
}

/**
 * Read one bucket's count off `useListReviewerQueue(params)`. The
 * caller passes the *exact* params the matching bucket page uses
 * (`InReview` / `Approved` / `Rejected`) so the sidebar pill and
 * the page share one react-query cache entry — visiting the page
 * warms the badge and any queue-mutating action that invalidates
 * the queue refreshes both at once. `countKey` selects from
 * `data.counts` (cross-system roll-up, not scoped to the filter).
 * Gated on `enabled` because the endpoint 403s any non-internal
 * audience.
 */
function useReviewerQueueBucketCount(
  params: { status: SubmissionStatus; order?: "submittedAt" | "respondedAt" },
  countKey: "inReview" | "approved" | "rejected",
  enabled: boolean,
): number {
  const { data } = useListReviewerQueue(params, {
    query: {
      queryKey: getListReviewerQueueQueryKey(params),
      enabled,
    },
  });
  return data?.counts?.[countKey] ?? 0;
}

/**
 * Trailing pill rendered on the Outstanding Requests / In Review /
 * Rejected sidebar entries. Caps display at `99+` so a wildly stale
 * queue doesn't blow out the sidebar width. The wrapping
 * `useNavGroups` only constructs this when `count > 0`, so the badge
 * stays absent at rest.
 */
function BucketCountBadge({
  count,
  testId,
  ariaLabel,
}: {
  count: number;
  testId: string;
  ariaLabel: string;
}) {
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className="sc-pill sc-pill-amber"
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {label}
    </span>
  );
}
