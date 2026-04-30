import type { ReactNode } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListEngagements,
  getListEngagementsQueryKey,
} from "@workspace/api-client-react";
import {
  Activity,
  BookOpen,
  Database,
  FolderOpen,
  LayoutDashboard,
  Palette,
} from "lucide-react";

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
          label: "Code Library",
          href: "/code-library",
          icon: <BookOpen size={14} />,
        },
        {
          label: "Style Probe",
          href: "/style-probe",
          icon: <Palette size={14} />,
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
    >
      {children}
    </DashboardLayout>
  );
}
