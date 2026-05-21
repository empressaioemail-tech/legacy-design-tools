import type { ReactNode } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListEngagements,
  getListEngagementsQueryKey,
  useListMyNotifications,
  getListMyNotificationsQueryKey,
  useGetSession,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";
import {
  Activity,
  BookOpen,
  Database,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  Palette,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { AuthChip } from "./AuthChip";

interface AppShellProps {
  title?: string;
  rightPanel?: ReactNode;
  children: ReactNode;
}

export function AppShell({ title, rightPanel, children }: AppShellProps) {
  const { data } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      refetchInterval: 5000,
    },
  });
  const engagements = data ?? [];

  // Gate the inbox poll on a real user session — production fail-closes
  // the session middleware to anonymous (see middlewares/session.ts), so
  // /me/notifications correctly 401s for any request that lacks a
  // `requestor.kind === "user"`. Without this gate the side-nav inbox
  // poll hammers the console with 401s every 5s on prod. Once a verified
  // auth layer lands (Task #29 follow-up), the session will carry a real
  // requestor and the gate will let the poll through unchanged.
  const { data: session } = useGetSession({
    query: { queryKey: getGetSessionQueryKey() },
  });
  const isUserSession = session?.requestor?.kind === "user";

  // Poll the architect inbox so the side-nav badge updates without
  // a hard refresh. The 5s cadence matches the engagement-list
  // poll above so a single "tab is active" signal covers both.
  const { data: notifications } = useListMyNotifications(undefined, {
    query: {
      queryKey: getListMyNotificationsQueryKey(),
      refetchInterval: isUserSession ? 5000 : false,
      enabled: isUserSession,
    },
  });
  const unreadCount = notifications?.unreadCount ?? 0;
  const inboxBadge =
    unreadCount > 0 ? (
      <span
        data-testid="inbox-badge"
        style={{
          minWidth: 18,
          height: 16,
          padding: "0 5px",
          borderRadius: 8,
          background: "#C0392B",
          color: "#FFF",
          fontSize: 10,
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        {unreadCount > 99 ? "99+" : unreadCount}
      </span>
    ) : null;

  const projectItems = engagements.slice(0, 8).map((e) => ({
    label: e.name,
    href: `/engagements/${e.id}`,
    icon: <FolderOpen size={14} />,
  }));

  if (engagements.length > 8) {
    projectItems.push({
      label: "View all →",
      href: "/",
      icon: <FolderOpen size={14} />,
    });
  }

  const navGroups = [
    {
      label: "WORKSPACE",
      items: [
        {
          label: "Projects",
          href: "/",
          icon: <LayoutDashboard size={14} />,
        },
        {
          label: "Inbox",
          href: "/notifications",
          icon: <Inbox size={14} />,
          badge: inboxBadge,
        },
        {
          label: "Code Library",
          href: "/code-library",
          icon: <BookOpen size={14} />,
        },
        {
          label: "Style Probe",
          href: "/style-probe",
          icon: <Palette size={14} />,
        },
        {
          label: "Settings",
          href: "/settings",
          icon: <SettingsIcon size={14} />,
        },
      ],
    },
    {
      label: "PROJECTS",
      items:
        projectItems.length > 0
          ? projectItems
          : [
              {
                label: "No engagements yet",
                href: "/",
                icon: <FolderOpen size={14} />,
              },
            ],
    },
    {
      label: "DEV",
      items: [
        {
          label: "Atom Inspector",
          href: "/dev/atoms",
          icon: <Database size={14} />,
        },
        {
          label: "Retrieval Probe",
          href: "/dev/atoms/probe",
          icon: <Search size={14} />,
        },
        {
          label: "API Health",
          href: "/health",
          icon: <Activity size={14} />,
        },
      ],
    },
  ];

  return (
    <DashboardLayout
      title={title}
      brandLabel="SMARTCITY OS"
      brandProductName="Design Tools"
      navGroups={navGroups}
      rightPanel={rightPanel}
      headerNotifications={{ href: "/notifications", unreadCount }}
      headerTrailing={<AuthChip />}
    >
      {children}
    </DashboardLayout>
  );
}
