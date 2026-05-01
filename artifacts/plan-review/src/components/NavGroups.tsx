import {
  getGetSessionQueryKey,
  useGetSession,
} from "@workspace/api-client-react";

/**
 * Sidebar group definitions, paired with the optional permission claim
 * required to render each entry.
 *
 * Items without `requiresPermission` are visible to every session; items
 * that *do* declare one are filtered out by {@link useNavGroups} when the
 * server-side session does not list that claim. Today the only gated
 * entry is "Users & Roles" (gated on `users:manage`, matching the
 * server-side check in `routes/users.ts`); other admin entries can opt
 * in by adding their own `requiresPermission` later without touching the
 * call sites.
 *
 * Whole groups whose every item filters out are dropped from the result
 * so the sidebar does not render an empty section header.
 */
export interface NavItem {
  label: string;
  href: string;
  /** Optional permission claim the session must carry for this item to render. */
  requiresPermission?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const ALL_NAV_GROUPS: NavGroup[] = [
  { label: "SUBMITTALS", items: [
      { label: "Inbox", href: "/" },
      { label: "In Review", href: "/in-review" },
      { label: "Approved", href: "/approved" },
      { label: "Rejected", href: "/rejected" },
      { label: "Sheets", href: "/sheets" },
  ]},
  { label: "AI REVIEWER", items: [
      { label: "Compliance Engine", href: "/compliance" },
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
      { label: "Reviewer Pool", href: "/reviewers" },
      { label: "Settings", href: "/settings" },
  ]},
  { label: "DEV", items: [
      { label: "Style Probe", href: "/style-probe" },
  ]},
];

/**
 * Filter the static {@link ALL_NAV_GROUPS} tree against a set of
 * permission claims. Pure (no React hooks) so it can also be used in
 * tests and from non-component code.
 */
export function filterNavGroups(
  permissions: ReadonlyArray<string>,
): NavGroup[] {
  const granted = new Set(permissions);
  return ALL_NAV_GROUPS.flatMap((group) => {
    const items = group.items.filter(
      (i) => !i.requiresPermission || granted.has(i.requiresPermission),
    );
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
  const { data } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      // Cache the session so every page render does not re-fetch it.
      // The server response is cheap (no DB), but the FE only needs
      // it once per app load — permissions cannot change without a
      // full reload today.
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    },
  });
  return filterNavGroups(data?.permissions ?? []);
}
