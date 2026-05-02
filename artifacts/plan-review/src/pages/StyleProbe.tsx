import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "../components/NavGroups";
import { KpiTile } from "../components/KpiTile";
import { DisciplineBadge } from "../components/DisciplineBadge";

export default function StyleProbe() {
  const navGroups = useNavGroups();

  return (
    <DashboardLayout
      title="Style Probe"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="max-w-4xl mx-auto space-y-12 pb-24">
        
        {/* KPI Strip */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold font-['Oxygen'] text-[var(--text-primary)]">KPI Tiles</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <KpiTile label="AVG REVIEW TIME" value="2.4d" trend="down" trendLabel="12% faster" />
            <KpiTile label="AI ACCURACY" value="94%" trend="up" trendLabel="+3 pts" />
            <KpiTile label="BLOCKING FINDINGS" value="28" trend="up" trendLabel="+4 this week" />
          </div>
        </section>

        {/* Badges & Pills */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold font-['Oxygen'] text-[var(--text-primary)]">Badges & Pills</h2>
          
          <div className="sc-card p-6 space-y-6">
            <div>
              <div className="sc-label mb-3">DISCIPLINES</div>
              <div className="flex flex-wrap gap-3">
                <DisciplineBadge discipline="architectural" />
                <DisciplineBadge discipline="structural" />
                <DisciplineBadge discipline="mep" />
                <DisciplineBadge discipline="civil" />
                <DisciplineBadge discipline="fire-life-safety" />
                <DisciplineBadge discipline="landscape" />
                <DisciplineBadge discipline="zoning" />
              </div>
            </div>

            <div>
              <div className="sc-label mb-3">PLAN REVIEW SEMANTICS</div>
              <div className="flex flex-wrap gap-3">
                <span className="sc-pill sc-pill-cyan">ai-review</span>
                <span className="sc-pill sc-pill-amber">in-review</span>
                <span className="sc-pill sc-pill-green">approved</span>
                <span className="sc-pill sc-pill-red">rejected</span>
                <span className="sc-pill sc-pill-muted">draft</span>
              </div>
            </div>
            
            <div>
              <div className="sc-label mb-3">FINDING SEVERITY</div>
              <div className="flex flex-wrap gap-3">
                <span className="sc-pill sc-pill-red">blocking</span>
                <span className="sc-pill sc-pill-amber">warning</span>
                <span className="sc-pill sc-pill-blue">info</span>
              </div>
            </div>
          </div>
        </section>

      </div>
    </DashboardLayout>
  );
}
