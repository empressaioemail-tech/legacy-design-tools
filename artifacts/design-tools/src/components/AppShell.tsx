import type { ReactNode } from "react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListEngagements,
  getListEngagementsQueryKey,
} from "@workspace/api-client-react";

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
  }));

  if (engagements.length > 8) {
    projectItems.push({ label: "View all →", href: "/" });
  }

  const navGroups = [
    {
      label: "WORKSPACE",
      items: [
        { label: "Projects", href: "/" },
        { label: "Style Probe", href: "/style-probe" },
      ],
    },
    {
      label: "PROJECTS",
      items:
        projectItems.length > 0
          ? projectItems
          : [{ label: "No engagements yet", href: "/" }],
    },
    {
      label: "DEV",
      items: [{ label: "API Health", href: "/health" }],
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
