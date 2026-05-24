import { useEffect } from "react";
import { Link } from "wouter";
import { BookOpen, ChevronRight } from "lucide-react";
import {
  useListEngagements,
  getListEngagementsQueryKey,
} from "@workspace/api-client-react";
import { AppShell } from "../components/AppShell";
import { InboxActionQueue } from "../components/inbox/InboxActionQueue";
import { ProjectsDashboardSection } from "../components/dashboard/ProjectsDashboardSection";
import { CodeLibrary } from "./CodeLibrary";

export type DashboardFocusSection = "inbox" | "projects" | "code" | null;

function scrollToSection(id: string) {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Unified workspace dashboard — inbox triage, project portfolio, and
 * code library overview on one screen.
 */
export function DashboardPage({
  focusSection = null,
}: {
  focusSection?: DashboardFocusSection;
}) {
  const { refetch, isFetching } = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      refetchInterval: 5000,
    },
  });

  useEffect(() => {
    if (!focusSection) return;
    const id =
      focusSection === "inbox"
        ? "dashboard-inbox"
        : focusSection === "code"
          ? "dashboard-code"
          : "dashboard-projects";
    const t = window.setTimeout(() => scrollToSection(id), 80);
    return () => window.clearTimeout(t);
  }, [focusSection]);

  return (
    <AppShell title="Dashboard">
      <div className="cockpit-dashboard" data-testid="dashboard-page">
        <header className="cockpit-dashboard-page-head">
          <div>
            <h1 className="cockpit-dashboard-page-title">Dashboard</h1>
            <p className="cockpit-dashboard-page-sub">
              Triage inbox and projects above; browse the full code library
              below.
            </p>
          </div>
        </header>

        <div className="cockpit-dashboard-grid">
          <div className="cockpit-dashboard-top-row">
            <section
              className="cockpit-dashboard-panel cockpit-dashboard-panel--inbox"
              id="dashboard-inbox"
              data-testid="dashboard-inbox-section"
            >
              <InboxActionQueue compact />
            </section>

            <section
              className="cockpit-dashboard-panel cockpit-dashboard-panel--projects"
              id="dashboard-projects"
              data-testid="dashboard-projects-section"
            >
              <ProjectsDashboardSection
                onRefresh={() => void refetch()}
                isFetching={isFetching}
              />
            </section>
          </div>

          <section
            className="cockpit-dashboard-panel cockpit-dashboard-panel--code"
            id="dashboard-code"
            data-testid="dashboard-code-section"
          >
            <header className="cockpit-dashboard-section-head cockpit-dashboard-code-head">
              <div>
                <h2 className="cockpit-dashboard-section-title">
                  <BookOpen size={16} aria-hidden className="sc-accent-cyan" />
                  Code library
                </h2>
                <p className="cockpit-dashboard-section-sub">
                  Browse jurisdictions, warm up atoms, and inspect code sections.
                </p>
              </div>
              <Link
                href="/code-library"
                className="cockpit-dashboard-section-link"
                data-testid="dashboard-code-open-full"
              >
                Open full page
                <ChevronRight size={14} aria-hidden />
              </Link>
            </header>
            <CodeLibrary embedded />
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/** Legacy routes land on the same dashboard with scroll focus. */
export function DashboardFocusPage({
  section,
}: {
  section: DashboardFocusSection;
}) {
  return <DashboardPage focusSection={section} />;
}
