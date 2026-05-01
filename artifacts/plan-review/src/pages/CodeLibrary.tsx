import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "../components/NavGroups";

export default function CodeLibrary() {
  const navGroups = useNavGroups();
  return (
    <DashboardLayout
      title="Code Library"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="flex items-center justify-center h-[50vh]">
        <div className="sc-card p-8 max-w-sm w-full text-center">
          <div className="sc-prose">Coming soon — this view is in design.</div>
        </div>
      </div>
    </DashboardLayout>
  );
}
