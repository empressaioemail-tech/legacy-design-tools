import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "../components/NavGroups";

export default function FindingsLibrary() {
  const navGroups = useNavGroups();
  return (
    <DashboardLayout
      title="Saved Findings"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div
        className="sc-card flex flex-col items-center justify-center text-center"
        data-testid="findings-library-empty-state"
        style={{ padding: "48px 24px", gap: 12 }}
      >
        <div className="sc-medium" style={{ fontSize: 16 }}>
          No findings yet.
        </div>
        <div
          className="sc-body"
          style={{ maxWidth: 440, color: "var(--text-secondary)" }}
        >
          The cross-engagement findings library will populate once
          reviewers run AI plan-review on their submissions. Open an
          engagement to view and run findings against a specific
          submission.
        </div>
      </div>
    </DashboardLayout>
  );
}
