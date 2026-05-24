import { useMemo, type ReactNode } from "react";
import { useParams } from "wouter";
import {
  useListEngagements,
  getListEngagementsQueryKey,
  useListMyNotifications,
  getListMyNotificationsQueryKey,
  useGetSession,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";
import { AuthChip } from "./AuthChip";
import {
  CockpitShell,
  DEFAULT_PRIMARY_NAV,
  DEFAULT_SECONDARY_NAV,
  type CockpitProject,
} from "./CockpitShell";
import { relativeTime } from "../lib/relativeTime";

interface AppShellProps {
  title?: string;
  rightPanel?: ReactNode;
  /** Right-aligned slot in the Cockpit header (Ask Claude, New Snapshot, …). */
  headerActions?: ReactNode;
  children: ReactNode;
}

/**
 * Thin wrapper around {@link CockpitShell} that wires the live data
 * sources (engagement list for the project rail, notifications poll
 * for the Inbox badge, session check to gate the poll) into the
 * Cockpit IA approved in Wave 2.
 *
 * The external contract is unchanged from the previous portal-ui
 * `DashboardLayout`-backed AppShell — every page still passes
 * `title`, optional `rightPanel`, and `children` — so no page-level
 * call sites need to be rewritten.
 */
export function AppShell({ title, rightPanel, headerActions, children }: AppShellProps) {
  const params = useParams<{ id?: string }>();
  const activeProjectId = params.id ?? null;

  const { data: engagementsData } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      refetchInterval: 5000,
    },
  });
  const engagements = engagementsData ?? [];

  // Same fail-closed gate as the previous shell: don't poll the
  // notifications endpoint for anonymous sessions or production
  // floods the console with 401s every 5s.
  const { data: session } = useGetSession({
    query: { queryKey: getGetSessionQueryKey() },
  });
  const isUserSession = session?.requestor?.kind === "user";

  const { data: notifications } = useListMyNotifications(undefined, {
    query: {
      queryKey: getListMyNotificationsQueryKey(),
      refetchInterval: isUserSession ? 5000 : false,
      enabled: isUserSession,
    },
  });
  const unreadCount = notifications?.unreadCount ?? 0;

  const projectRail = useMemo(() => {
    const projects: CockpitProject[] = engagements
      .filter((e) => e.status !== "archived")
      .slice(0, 12)
      .map((e) => ({
        id: e.id,
        name: e.name,
        jurisdiction: e.jurisdiction ?? null,
        status: e.status,
        snapshotCount: e.snapshotCount ?? 0,
        updatedLabel: relativeTime(e.latestSnapshot?.receivedAt ?? e.updatedAt),
      }));
    return {
      label: "Active engagements",
      projects,
      activeProjectId,
      emptyMessage: "No engagements yet. Send a snapshot from Revit.",
      viewAllHref: "/",
    };
  }, [engagements, activeProjectId]);

  const primaryNav = useMemo(() => {
    return {
      items: DEFAULT_PRIMARY_NAV.items.map((it) =>
        it.href === "/notifications" ? { ...it, badge: unreadCount } : it,
      ),
    };
  }, [unreadCount]);

  return (
    <CockpitShell
      title={title}
      rightPanel={rightPanel}
      headerActions={headerActions}
      primaryNav={primaryNav}
      secondaryNav={DEFAULT_SECONDARY_NAV}
      navTrailing={<AuthChip />}
      projectRail={projectRail}
    >
      {children}
    </CockpitShell>
  );
}
