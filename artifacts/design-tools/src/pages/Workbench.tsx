import { DashboardLayout } from "@workspace/portal-ui";
import { SnapshotList } from "../components/SnapshotList";
import { SnapshotDetail } from "../components/SnapshotDetail";
import { ClaudeChat } from "../components/ClaudeChat";

const navGroups = [
  {
    label: "WORKSPACE",
    items: [
      { label: "Workbench", href: "/" },
      { label: "Style Probe", href: "/style-probe" },
    ],
  },
  {
    label: "PROJECTS",
    items: [
      { label: "Seguin Residence", href: "/p/seguin" },
      { label: "Musgrave Residence", href: "/p/musgrave" },
    ],
  },
  {
    label: "DEV",
    items: [
      { label: "API Health", href: "/health" },
    ],
  },
];

export function Workbench() {
  return (
    <DashboardLayout
      title="Revit Workbench"
      brandLabel="SMARTCITY OS"
      brandProductName="Design Tools"
      navGroups={navGroups}
      rightPanel={<ClaudeChat />}
    >
      <div className="flex h-full gap-6">
        <SnapshotList />
        <SnapshotDetail />
      </div>
    </DashboardLayout>
  );
}
